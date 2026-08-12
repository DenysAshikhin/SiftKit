//! Foreground/idle/lock adapters over Win32 (spec §4). Failure to identify the foreground is an
//! `Err` the preflight treats as suppression — never a capturable unknown.

use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, MAX_PATH, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
    DESKTOP_READOBJECTS, UOI_NAME,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE,
    QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId,
};

use crate::platform::{
    ForegroundSample, NativeActivityProvider, NativeNotificationProvider, NotificationSample,
};

pub struct WindowsActivityProvider;
pub struct WindowsNotificationProvider;

fn window_title(window: HWND) -> Option<String> {
    let length = unsafe { GetWindowTextLengthW(window) };
    if length <= 0 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize + 1];
    let copied = unsafe { GetWindowTextW(window, &mut buffer) };
    if copied <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..copied as usize]))
}

fn process_image_path(process_id: u32) -> Option<String> {
    let handle =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    let mut buffer = vec![0u16; MAX_PATH as usize * 2];
    let mut length = u32::try_from(buffer.len()).expect("buffer fits u32");
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    unsafe { let _ = CloseHandle(handle); };
    result.ok()?;
    Some(String::from_utf16_lossy(&buffer[..length as usize]))
}

fn is_fullscreen(window: HWND) -> bool {
    let mut window_rect = RECT::default();
    if unsafe { GetWindowRect(window, &mut window_rect) }.is_err() {
        return false;
    }
    let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: u32::try_from(std::mem::size_of::<MONITORINFO>()).expect("size fits"),
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return false;
    }
    window_rect.left <= info.rcMonitor.left
        && window_rect.top <= info.rcMonitor.top
        && window_rect.right >= info.rcMonitor.right
        && window_rect.bottom >= info.rcMonitor.bottom
}

/// The name of the current input desktop, or `None` when it cannot even be opened (locked
/// session, secure desktop, UAC prompt).
fn input_desktop_name() -> Option<String> {
    let desktop = unsafe {
        OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
    }
    .ok()?;
    let mut buffer = vec![0u16; 256];
    let mut needed = 0u32;
    let queried = unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(buffer.as_mut_ptr().cast()),
            u32::try_from(buffer.len() * 2).expect("buffer fits"),
            Some(&mut needed),
        )
    };
    unsafe { let _ = CloseDesktop(desktop); };
    queried.ok()?;
    let name: String = String::from_utf16_lossy(&buffer)
        .trim_end_matches('\0')
        .to_string();
    Some(name)
}

/// `app:` + the lowercased executable stem, mirroring the daemon's application identity.
fn application_id(executable_path: &str) -> String {
    let stem = std::path::Path::new(executable_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("unknown");
    format!("app:{}", stem.to_lowercase())
}

impl NativeActivityProvider for WindowsActivityProvider {
    fn foreground(&self) -> Result<ForegroundSample, String> {
        let window = unsafe { GetForegroundWindow() };
        if window.is_invalid() {
            return Err("no foreground window".into());
        }
        let mut process_id = 0u32;
        unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
        if process_id == 0 {
            return Err("foreground window has no owning process".into());
        }
        let executable_path = process_image_path(process_id)
            .ok_or_else(|| "foreground process identity is unavailable".to_string())?;
        let process_name = std::path::Path::new(&executable_path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string);
        Ok(ForegroundSample {
            application_id: Some(application_id(&executable_path)),
            process_name,
            executable_path: Some(executable_path),
            raw_title: window_title(window),
            fullscreen: is_fullscreen(window),
        })
    }

    fn idle_seconds(&self) -> u32 {
        let mut info = LASTINPUTINFO {
            cbSize: u32::try_from(std::mem::size_of::<LASTINPUTINFO>()).expect("size fits"),
            dwTime: 0,
        };
        if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            return 0;
        }
        let now = unsafe { GetTickCount() };
        now.wrapping_sub(info.dwTime) / 1000
    }

    fn session_locked(&self) -> bool {
        input_desktop_name().is_none()
    }

    fn secure_desktop_active(&self) -> bool {
        match input_desktop_name() {
            None => true,
            Some(name) => !name.eq_ignore_ascii_case("Default"),
        }
    }
}

impl NativeNotificationProvider for WindowsNotificationProvider {
    fn read(&self) -> NotificationSample {
        match unsafe { SHQueryUserNotificationState() } {
            Ok(state) => NotificationSample {
                do_not_disturb: state == QUNS_BUSY,
                presenting: state == QUNS_PRESENTATION_MODE,
                fullscreen: state == QUNS_RUNNING_D3D_FULL_SCREEN
                    || state == QUNS_PRESENTATION_MODE,
            },
            Err(_) => NotificationSample::default(),
        }
    }
}
