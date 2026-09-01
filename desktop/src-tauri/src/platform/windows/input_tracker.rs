//! Raw Input mouse/keyboard idle tracking (three-signal idle gate design §3.1). Gamepads and every
//! other HID usage are invisible by construction: only usages 0x02 and 0x06 are registered.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER,
    RIDEV_INPUTSINK, RID_HEADER, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowLongPtrW,
    RegisterClassW, SetWindowLongPtrW, GWLP_USERDATA, HWND_MESSAGE, MSG, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_INPUT, WNDCLASSW,
};

const CLASS_NAME: PCWSTR = w!("SiftKitInputTracker");
const HID_USAGE_PAGE_GENERIC: u16 = 0x01;
const HID_USAGE_GENERIC_MOUSE: u16 = 0x02;
const HID_USAGE_GENERIC_KEYBOARD: u16 = 0x06;

/// Owns the Raw Input thread. Created once at shell startup and passed explicitly to the worker
/// loop; there is no `GetLastInputInfo` fallback anywhere.
pub struct WindowsInputTracker {
    timestamps: Arc<InputIdleTimestamps>,
    alive: Arc<AtomicBool>,
}

impl WindowsInputTracker {
    /// Spawns the message loop and blocks until Raw Input registration succeeds or fails.
    /// `Err` means the shell cannot report idleness; callers must fail startup, not degrade.
    pub fn start() -> Result<Self, String> {
        let timestamps = Arc::new(InputIdleTimestamps::seeded(unsafe { GetTickCount() }));
        let alive = Arc::new(AtomicBool::new(true));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let loop_timestamps = timestamps.clone();
        let loop_alive = alive.clone();
        std::thread::Builder::new()
            .name("siftkit-input-tracker".into())
            .spawn(move || {
                let outcome = run_message_loop(&loop_timestamps, &ready_tx);
                loop_alive.store(false, Ordering::Relaxed);
                if let Err(error) = outcome {
                    eprintln!("input tracker stopped: {error}");
                }
            })
            .map_err(|error| format!("input tracker thread: {error}"))?;
        ready_rx
            .recv()
            .map_err(|_| "input tracker exited before registering".to_string())??;
        Ok(Self { timestamps, alive })
    }

    /// `Err` once the message loop has died: a stale snapshot would read as ever-growing idleness,
    /// which is exactly the wrong-signal failure this tracker exists to remove.
    pub fn snapshot(&self) -> Result<InputIdleSnapshot, String> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err("input tracker thread has exited".into());
        }
        Ok(self.timestamps.snapshot_at(unsafe { GetTickCount() }))
    }
}

fn run_message_loop(
    timestamps: &Arc<InputIdleTimestamps>,
    ready: &Sender<Result<(), String>>,
) -> Result<(), String> {
    let registered = create_message_window(timestamps).and_then(register_mouse_and_keyboard);
    if let Err(error) = registered {
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    let _ = ready.send(Ok(()));

    let mut message = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
        if result.0 == -1 {
            return Err(format!("GetMessageW failed: {:?}", unsafe { GetLastError() }));
        }
        if result.0 == 0 {
            return Err("message loop received WM_QUIT".into());
        }
        unsafe { DispatchMessageW(&message) };
    }
}

/// A message-only window whose `GWLP_USERDATA` points at the timestamps. The `Arc` outlives the
/// window because `run_message_loop` holds it for the loop's whole lifetime.
fn create_message_window(timestamps: &Arc<InputIdleTimestamps>) -> Result<HWND, String> {
    let module = unsafe { GetModuleHandleW(None) }
        .map_err(|error| format!("GetModuleHandleW: {error}"))?;
    let instance = HINSTANCE(module.0);
    let class = WNDCLASSW {
        lpfnWndProc: Some(input_window_proc),
        hInstance: instance,
        lpszClassName: CLASS_NAME,
        ..Default::default()
    };
    if unsafe { RegisterClassW(&class) } == 0 {
        return Err(format!("RegisterClassW failed: {:?}", unsafe { GetLastError() }));
    }
    let window = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS_NAME,
            CLASS_NAME,
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance),
            None,
        )
    }
    .map_err(|error| format!("CreateWindowExW: {error}"))?;
    unsafe { SetWindowLongPtrW(window, GWLP_USERDATA, Arc::as_ptr(timestamps) as isize) };
    Ok(window)
}

/// Usage page 0x01, usages 0x02 (mouse) and 0x06 (keyboard) only. `RIDEV_INPUTSINK` delivers
/// input without foreground focus.
fn register_mouse_and_keyboard(window: HWND) -> Result<(), String> {
    let device = |usage: u16| RAWINPUTDEVICE {
        usUsagePage: HID_USAGE_PAGE_GENERIC,
        usUsage: usage,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: window,
    };
    let devices = [device(HID_USAGE_GENERIC_MOUSE), device(HID_USAGE_GENERIC_KEYBOARD)];
    let size = u32::try_from(std::mem::size_of::<RAWINPUTDEVICE>()).expect("size fits");
    unsafe { RegisterRawInputDevices(&devices, size) }
        .map_err(|error| format!("RegisterRawInputDevices: {error}"))
}

unsafe extern "system" fn input_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_INPUT {
        let pointer = GetWindowLongPtrW(window, GWLP_USERDATA) as *const InputIdleTimestamps;
        if let Some(timestamps) = pointer.as_ref() {
            let mut header = RAWINPUTHEADER::default();
            let mut size = u32::try_from(std::mem::size_of::<RAWINPUTHEADER>()).expect("size fits");
            let copied = GetRawInputData(
                HRAWINPUT(lparam.0 as _),
                RID_HEADER,
                Some((&mut header as *mut RAWINPUTHEADER).cast()),
                &mut size,
                size,
            );
            // Injected input (SendInput) arrives with a null device handle; only physical devices
            // count as user activity.
            if copied == size && !header.hDevice.0.is_null() {
                let tick = GetTickCount();
                if header.dwType == RIM_TYPEMOUSE.0 {
                    timestamps.stamp_mouse(tick);
                } else if header.dwType == RIM_TYPEKEYBOARD.0 {
                    timestamps.stamp_keyboard(tick);
                }
            }
        }
    }
    DefWindowProcW(window, message, wparam, lparam)
}

/// Seconds since the last physical input, one value per signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputIdleSnapshot {
    pub mouse_seconds: u32,
    pub keyboard_seconds: u32,
}

/// `GetTickCount` stamps of the last mouse and keyboard input. Pure: callers pass tick values, so
/// the arithmetic (including the 49.7-day wrap) is testable without Win32.
#[derive(Debug)]
pub struct InputIdleTimestamps {
    last_mouse_tick: AtomicU32,
    last_keyboard_tick: AtomicU32,
}

impl InputIdleTimestamps {
    /// Both signals start at `start_tick`, so idle counts from shell start instead of reporting a
    /// spurious large value before the first input arrives.
    pub fn seeded(start_tick: u32) -> Self {
        Self {
            last_mouse_tick: AtomicU32::new(start_tick),
            last_keyboard_tick: AtomicU32::new(start_tick),
        }
    }

    pub fn stamp_mouse(&self, tick: u32) {
        self.last_mouse_tick.store(tick, Ordering::Relaxed);
    }

    pub fn stamp_keyboard(&self, tick: u32) {
        self.last_keyboard_tick.store(tick, Ordering::Relaxed);
    }

    pub fn snapshot_at(&self, now_tick: u32) -> InputIdleSnapshot {
        InputIdleSnapshot {
            mouse_seconds: now_tick.wrapping_sub(self.last_mouse_tick.load(Ordering::Relaxed)) / 1000,
            keyboard_seconds: now_tick.wrapping_sub(self.last_keyboard_tick.load(Ordering::Relaxed))
                / 1000,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_timestamps_report_elapsed_since_start_for_both_signals() {
        let timestamps = InputIdleTimestamps::seeded(10_000);
        assert_eq!(
            timestamps.snapshot_at(15_999),
            InputIdleSnapshot { mouse_seconds: 5, keyboard_seconds: 5 },
        );
    }

    #[test]
    fn stamping_one_signal_does_not_move_the_other() {
        let timestamps = InputIdleTimestamps::seeded(0);
        timestamps.stamp_mouse(30_000);
        assert_eq!(
            timestamps.snapshot_at(31_000),
            InputIdleSnapshot { mouse_seconds: 1, keyboard_seconds: 31 },
        );
        timestamps.stamp_keyboard(40_000);
        assert_eq!(
            timestamps.snapshot_at(40_500),
            InputIdleSnapshot { mouse_seconds: 10, keyboard_seconds: 0 },
        );
    }

    #[test]
    fn elapsed_is_correct_across_a_tick_count_wrap() {
        let timestamps = InputIdleTimestamps::seeded(u32::MAX - 500);
        assert_eq!(
            timestamps.snapshot_at(1_500),
            InputIdleSnapshot { mouse_seconds: 2, keyboard_seconds: 2 },
        );
    }

    #[test]
    fn tracker_starts_and_reports_seeded_idle_for_both_signals() {
        let tracker = WindowsInputTracker::start().expect("tracker starts");
        let snapshot = tracker.snapshot().expect("tracker alive");
        assert!(snapshot.mouse_seconds < 5, "mouse idle counts from start: {snapshot:?}");
        assert!(snapshot.keyboard_seconds < 5, "keyboard idle counts from start: {snapshot:?}");
        // One tracker per process: the second class registration fails, and that failure must
        // surface as `Err` rather than a tracker that reports zero.
        assert!(WindowsInputTracker::start().is_err(), "a second tracker must fail loudly");
    }
}
