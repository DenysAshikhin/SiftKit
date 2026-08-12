//! Silent capture (spec §4): `PrintWindow(PW_RENDERFULLCONTENT)` for the foreground scope and
//! DXGI output duplication for all monitors. Nothing here flashes, borders, or changes focus;
//! minimized/cloaked windows and DRM-black frames are failures, not evidence.

use windows::core::Interface;
use windows::Win32::Foundation::{HMODULE, HWND, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_FLAG, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIResource,
    DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetMonitorInfoW,
    MonitorFromWindow, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, IsIconic};

use crate::platform::{Capture, CaptureDisplay, CaptureFrame, CaptureScope, NativeCaptureProvider};

/// The DPI Windows calls 100% scaling.
const BASE_DPI: f64 = 96.0;

/// `MONITORINFO.dwFlags` primary-monitor bit (winuser.h `MONITORINFOF_PRIMARY`).
const MONITORINFOF_PRIMARY: u32 = 0x0000_0001;

/// `PW_RENDERFULLCONTENT`: undocumented-but-stable flag that captures DirectComposition
/// content; without it modern apps print black.
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

pub struct WindowsCaptureProvider;

impl NativeCaptureProvider for WindowsCaptureProvider {
    fn capture(&self, scope: CaptureScope) -> Result<Capture, String> {
        match scope {
            CaptureScope::ForegroundWindow => capture_foreground_window(),
            CaptureScope::AllMonitors => capture_all_monitors(),
        }
    }
}

/// NUL-terminated UTF-16 device name (`\\.\DISPLAY1`) to a string.
fn device_name(raw: &[u16]) -> String {
    let length = raw.iter().position(|&unit| unit == 0).unwrap_or(raw.len());
    String::from_utf16_lossy(&raw[..length])
}

/// The monitor a window sits on, as the OS reports it. A display we cannot identify is a
/// capture failure: fabricated evidence metadata is worse than a suppressed capture.
fn window_display(window: HWND) -> Result<CaptureDisplay, String> {
    let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = u32::try_from(std::mem::size_of::<MONITORINFOEXW>())
        .expect("monitor info size");
    if !unsafe { GetMonitorInfoW(monitor, std::ptr::from_mut(&mut info).cast()) }.as_bool() {
        return Err("GetMonitorInfoW failed".into());
    }
    let dpi = unsafe { GetDpiForWindow(window) };
    if dpi == 0 {
        return Err("GetDpiForWindow failed".into());
    }
    let name = device_name(&info.szDevice);
    Ok(CaptureDisplay {
        id: name.clone(),
        name,
        primary: (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0,
        scale_factor: f64::from(dpi) / BASE_DPI,
    })
}

fn is_cloaked(window: HWND) -> bool {
    let mut cloaked = 0u32;
    unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED,
            std::ptr::from_mut(&mut cloaked).cast(),
            u32::try_from(std::mem::size_of::<u32>()).expect("u32 size"),
        )
    }
    .map(|()| cloaked != 0)
    .unwrap_or(false)
}

fn capture_foreground_window() -> Result<Capture, String> {
    let window = unsafe { GetForegroundWindow() };
    if window.is_invalid() {
        return Err("no foreground window to capture".into());
    }
    if unsafe { IsIconic(window) }.as_bool() {
        return Err("foreground window is minimized".into());
    }
    if is_cloaked(window) {
        return Err("foreground window is cloaked".into());
    }
    let display = window_display(window)?;
    let mut rect = RECT::default();
    unsafe { GetWindowRect(window, &mut rect) }
        .map_err(|error| format!("GetWindowRect failed: {error}"))?;
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return Err("foreground window has no visible area".into());
    }

    unsafe {
        let device_context = CreateCompatibleDC(None);
        if device_context.is_invalid() {
            return Err("CreateCompatibleDC failed".into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: u32::try_from(std::mem::size_of::<BITMAPINFOHEADER>())
                    .expect("header size"),
                biWidth: width,
                biHeight: -height, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(
            Some(device_context),
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        )
        .map_err(|error| {
            let _ = DeleteDC(device_context);
            format!("CreateDIBSection failed: {error}")
        })?;
        let previous = SelectObject(device_context, bitmap.into());
        let printed = PrintWindow(window, device_context, PW_RENDERFULLCONTENT).as_bool();
        let frame = if printed {
            let pixel_count = (width as usize) * (height as usize);
            let bgra = std::slice::from_raw_parts(bits.cast::<u8>(), pixel_count * 4);
            Some(bgra_to_rgba(bgra, width as u32, height as u32))
        } else {
            None
        };
        SelectObject(device_context, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(device_context);
        frame
            .map(|frame| Capture { frame, display })
            .ok_or_else(|| "PrintWindow refused the capture".into())
    }
}

fn bgra_to_rgba(bgra: &[u8], width: u32, height: u32) -> CaptureFrame {
    let mut rgba = vec![0u8; bgra.len()];
    for (source, target) in bgra.chunks_exact(4).zip(rgba.chunks_exact_mut(4)) {
        target[0] = source[2];
        target[1] = source[1];
        target[2] = source[0];
        target[3] = 0xff;
    }
    CaptureFrame { width, height, rgba }
}

struct MonitorShot {
    left: i32,
    top: i32,
    device_name: String,
    frame: CaptureFrame,
}

fn capture_all_monitors() -> Result<Capture, String> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }
        .map_err(|error| format!("CreateDXGIFactory1 failed: {error}"))?;
    let mut shots: Vec<MonitorShot> = Vec::new();
    let mut adapter_index = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(adapter_index) } {
        collect_adapter_outputs(&adapter, &mut shots)?;
        adapter_index += 1;
    }
    if shots.is_empty() {
        return Err("no DXGI output produced a frame".into());
    }
    let display = virtual_desktop_display(&shots);
    Ok(Capture { frame: compose_virtual_desktop(shots), display })
}

/// The composed virtual desktop, anchored to the display at the virtual origin (the primary).
/// The composition is raw physical pixels, so there is no single logical scale to report:
/// `scale_factor` 1.0 states exactly that logical size equals pixel size for this frame.
fn virtual_desktop_display(shots: &[MonitorShot]) -> CaptureDisplay {
    let anchor = shots
        .iter()
        .find(|shot| shot.left == 0 && shot.top == 0)
        .unwrap_or(&shots[0]);
    CaptureDisplay {
        id: anchor.device_name.clone(),
        name: format!("virtual desktop ({} displays)", shots.len()),
        primary: anchor.left == 0 && anchor.top == 0,
        scale_factor: 1.0,
    }
}

fn collect_adapter_outputs(
    adapter: &IDXGIAdapter1,
    shots: &mut Vec<MonitorShot>,
) -> Result<(), String> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    unsafe {
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(|error| format!("D3D11CreateDevice failed: {error}"))?;
    let device = device.ok_or("D3D11CreateDevice returned no device")?;
    let context = context.ok_or("D3D11CreateDevice returned no context")?;

    let mut output_index = 0u32;
    while let Ok(output) = unsafe { adapter.EnumOutputs(output_index) } {
        output_index += 1;
        let Ok(description) = (unsafe { output.GetDesc() }) else {
            continue;
        };
        let output1: IDXGIOutput1 = match output.cast() {
            Ok(output1) => output1,
            Err(_) => continue,
        };
        if let Some(frame) = duplicate_one_frame(&output1, &device, &context) {
            shots.push(MonitorShot {
                left: description.DesktopCoordinates.left,
                top: description.DesktopCoordinates.top,
                device_name: device_name(&description.DeviceName),
                frame,
            });
        }
    }
    Ok(())
}

fn duplicate_one_frame(
    output: &IDXGIOutput1,
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
) -> Option<CaptureFrame> {
    let duplication = unsafe { output.DuplicateOutput(device) }.ok()?;
    // The first acquire frequently times out until the desktop repaints; a few patient
    // retries beat a spurious failure.
    for _ in 0..4 {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        if unsafe { duplication.AcquireNextFrame(250, &mut info, &mut resource) }.is_err() {
            continue;
        }
        let Some(resource) = resource else {
            let _ = unsafe { duplication.ReleaseFrame() };
            continue;
        };
        let texture: ID3D11Texture2D = match resource.cast() {
            Ok(texture) => texture,
            Err(_) => {
                let _ = unsafe { duplication.ReleaseFrame() };
                continue;
            }
        };
        let frame = read_texture(device, context, &texture);
        let _ = unsafe { duplication.ReleaseFrame() };
        if frame.is_some() {
            return frame;
        }
    }
    None
}

fn read_texture(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    texture: &ID3D11Texture2D,
) -> Option<CaptureFrame> {
    let mut description = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut description) };
    let staging_description = D3D11_TEXTURE2D_DESC {
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        #[allow(clippy::cast_sign_loss)]
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
        ..description
    };
    let mut staging: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&staging_description, None, Some(&mut staging)) }.ok()?;
    let staging = staging?;
    unsafe { context.CopyResource(&staging, texture) };
    let mut mapped = windows::Win32::Graphics::Direct3D11::D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.ok()?;
    let width = description.Width;
    let height = description.Height;
    let mut bgra = vec![0u8; (width * height * 4) as usize];
    for row in 0..height {
        let source = unsafe {
            std::slice::from_raw_parts(
                mapped.pData.cast::<u8>().add((row * mapped.RowPitch) as usize),
                (width * 4) as usize,
            )
        };
        let start = (row * width * 4) as usize;
        bgra[start..start + (width * 4) as usize].copy_from_slice(source);
    }
    unsafe { context.Unmap(&staging, 0) };
    Some(bgra_to_rgba(&bgra, width, height))
}

/// Stitches per-monitor frames onto the virtual-desktop bounding box.
fn compose_virtual_desktop(shots: Vec<MonitorShot>) -> CaptureFrame {
    let min_left = shots.iter().map(|shot| shot.left).min().unwrap_or(0);
    let min_top = shots.iter().map(|shot| shot.top).min().unwrap_or(0);
    let max_right = shots
        .iter()
        .map(|shot| shot.left + shot.frame.width as i32)
        .max()
        .unwrap_or(0);
    let max_bottom = shots
        .iter()
        .map(|shot| shot.top + shot.frame.height as i32)
        .max()
        .unwrap_or(0);
    let width = (max_right - min_left).max(1) as u32;
    let height = (max_bottom - min_top).max(1) as u32;
    let mut rgba = vec![0u8; (width * height * 4) as usize];
    for shot in &shots {
        let offset_x = (shot.left - min_left) as u32;
        let offset_y = (shot.top - min_top) as u32;
        for row in 0..shot.frame.height {
            let source_start = (row * shot.frame.width * 4) as usize;
            let source_end = source_start + (shot.frame.width * 4) as usize;
            let target_start = (((offset_y + row) * width + offset_x) * 4) as usize;
            rgba[target_start..target_start + (shot.frame.width * 4) as usize]
                .copy_from_slice(&shot.frame.rgba[source_start..source_end]);
        }
    }
    CaptureFrame { width, height, rgba }
}

/// Encodes a frame to PNG bytes; the daemon stores exactly these bytes as evidence.
pub fn encode_png(frame: &CaptureFrame) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, frame.width, frame.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("png header: {error}"))?;
        writer
            .write_image_data(&frame.rgba)
            .map_err(|error| format!("png data: {error}"))?;
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observation::hash::{is_blank_frame, pixel_sha256};

    #[test]
    fn png_encoding_is_deterministic_for_identical_frames() {
        let frame = CaptureFrame {
            width: 3,
            height: 2,
            rgba: (0..24u8).collect(),
        };
        let first = encode_png(&frame).expect("encode");
        let second = encode_png(&frame).expect("encode twin");
        assert_eq!(pixel_sha256(&first), pixel_sha256(&second));
    }

    #[test]
    fn a_drm_black_frame_is_reported_as_failure_material() {
        let black = CaptureFrame { width: 8, height: 8, rgba: vec![0; 8 * 8 * 4] };
        assert!(is_blank_frame(&black), "uniform frames must become capture_failure audits");
    }

    #[test]
    fn composition_places_monitors_on_the_virtual_desktop() {
        let left = MonitorShot {
            left: 0,
            top: 0,
            device_name: r"\\.\DISPLAY1".into(),
            frame: CaptureFrame { width: 2, height: 1, rgba: vec![10; 8] },
        };
        let right = MonitorShot {
            left: 2,
            top: 0,
            device_name: r"\\.\DISPLAY2".into(),
            frame: CaptureFrame { width: 2, height: 1, rgba: vec![20; 8] },
        };
        let composed = compose_virtual_desktop(vec![left, right]);
        assert_eq!((composed.width, composed.height), (4, 1));
        assert_eq!(&composed.rgba[..8], &[10; 8]);
        assert_eq!(&composed.rgba[8..], &[20; 8]);
    }

    #[test]
    fn the_virtual_desktop_display_is_anchored_to_the_monitor_at_the_origin() {
        let shots = vec![
            MonitorShot {
                left: -1920,
                top: 0,
                device_name: r"\\.\DISPLAY2".into(),
                frame: CaptureFrame { width: 1, height: 1, rgba: vec![0; 4] },
            },
            MonitorShot {
                left: 0,
                top: 0,
                device_name: r"\\.\DISPLAY1".into(),
                frame: CaptureFrame { width: 1, height: 1, rgba: vec![0; 4] },
            },
        ];
        let display = virtual_desktop_display(&shots);
        assert_eq!(display.id, r"\\.\DISPLAY1");
        assert_eq!(display.name, "virtual desktop (2 displays)");
        assert!(display.primary);
        assert_eq!(display.scale_factor, 1.0);
    }

    #[test]
    fn a_composition_missing_the_primary_does_not_claim_it() {
        let shots = vec![MonitorShot {
            left: -1920,
            top: 0,
            device_name: r"\\.\DISPLAY2".into(),
            frame: CaptureFrame { width: 1, height: 1, rgba: vec![0; 4] },
        }];
        let display = virtual_desktop_display(&shots);
        assert_eq!(display.id, r"\\.\DISPLAY2");
        assert!(!display.primary);
    }

    #[test]
    fn device_names_are_read_up_to_the_nul_terminator() {
        let mut raw = [0u16; 32];
        for (index, unit) in r"\\.\DISPLAY1".encode_utf16().enumerate() {
            raw[index] = unit;
        }
        assert_eq!(device_name(&raw), r"\\.\DISPLAY1");
    }
}
