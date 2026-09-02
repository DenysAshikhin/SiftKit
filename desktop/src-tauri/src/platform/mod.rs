//! Platform-neutral traits over native adapters. All Win32/`unsafe` code lives under
//! [`windows`]; everything above these traits is pure logic testable with fakes (spec §1).

use serde::Deserialize;

pub mod windows;

/// What the OS reports about the foreground window at one instant.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ForegroundSample {
    pub process_name: Option<String>,
    pub executable_path: Option<String>,
    pub application_id: Option<String>,
    /// The raw window title. It never leaves the shell unfiltered; DTOs carry the normalized
    /// form only (spec §4).
    pub raw_title: Option<String>,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PowerSample {
    Available { on_battery: bool, battery_percent: f64 },
    Unavailable,
}

/// Focus/DND/presentation facts from the notification state (spec §2).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct NotificationSample {
    pub do_not_disturb: bool,
    pub presenting: bool,
    pub fullscreen: bool,
}

pub trait NativeActivityProvider: Send {
    /// `Err` means the OS refused the query; callers must treat that as suppression, never as
    /// an unknown-but-capturable foreground (spec §4).
    fn foreground(&self) -> Result<ForegroundSample, String>;
    fn session_locked(&self) -> bool;
    /// UAC prompt / secure desktop: `OpenInputDesktop` failing is `true` here.
    fn secure_desktop_active(&self) -> bool;
}

pub trait NativePowerStateProvider: Send {
    fn read(&self) -> PowerSample;
}

pub trait NativeNotificationProvider: Send {
    fn read(&self) -> NotificationSample;
}

/// One captured frame, decoded to tightly-packed RGBA rows.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Identity and scaling of the display a frame came from, as the OS reports it — never
/// invented: evidence metadata must describe the real monitor (spec §4).
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureDisplay {
    pub id: String,
    pub name: String,
    pub primary: bool,
    pub scale_factor: f64,
}

/// A captured frame together with the display it was taken from.
#[derive(Debug, Clone, PartialEq)]
pub struct Capture {
    pub frame: CaptureFrame,
    pub display: CaptureDisplay,
}

/// Mirrors the daemon config's `CaptureScope` enum; an unknown value fails the config parse
/// instead of silently degrading to a scope the user did not choose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureScope {
    ForegroundWindow,
    AllMonitors,
}

pub trait NativeCaptureProvider: Send {
    fn capture(&self, scope: CaptureScope) -> Result<Capture, String>;
}

/// OS-protected key blob storage (DPAPI on Windows, spec §3).
pub trait NativeSecureKeyProvider: Send {
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, blob: &[u8]) -> Result<Vec<u8>, String>;
}
