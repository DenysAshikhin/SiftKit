// Tray-first shell (spec §1/§6): no window at startup, the process stays alive until Quit.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use siftkit_assistant_shell_lib::clock::{iso8601_from_epoch, iso8601_now, now_epoch_seconds};
use siftkit_assistant_shell_lib::contracts::{
    CaptureDisplayDto, CaptureSubmissionDto, DesktopStateDto, ForegroundContextDto, SchemaV1,
    SuppressionAuditDto, SuppressionRuleId,
};
use siftkit_assistant_shell_lib::custody::{synchronize_custody, KeyBlobStore};
use siftkit_assistant_shell_lib::daemon::client::{ClientError, DaemonClient};
use siftkit_assistant_shell_lib::daemon::supervisor::{ProbeResult, Supervisor};
use siftkit_assistant_shell_lib::observation::hash::{dhash64_hex, is_blank_frame, pixel_sha256};
use siftkit_assistant_shell_lib::observation::heartbeat::{
    foreground_context_key, Heartbeat, HeartbeatEmission, ObservationTick,
};
use siftkit_assistant_shell_lib::observation::preflight::{evaluate, PreflightInput};
use siftkit_assistant_shell_lib::observation::scheduler::CaptureScheduler;
use siftkit_assistant_shell_lib::observation::titles::normalize_title;
use siftkit_assistant_shell_lib::platform::windows::activity::{
    WindowsActivityProvider, WindowsNotificationProvider,
};
use siftkit_assistant_shell_lib::platform::windows::capture::{encode_png, WindowsCaptureProvider};
use siftkit_assistant_shell_lib::platform::windows::input_tracker::WindowsInputTracker;
use siftkit_assistant_shell_lib::platform::windows::job::JobObjectDaemonControl;
use siftkit_assistant_shell_lib::platform::windows::power::WindowsPowerStateProvider;
use siftkit_assistant_shell_lib::platform::windows::secure_key::DpapiSecureKeyProvider;
use siftkit_assistant_shell_lib::platform::windows::startup::{
    reconcile_startup, WindowsRunKeyRegistry,
};
use siftkit_assistant_shell_lib::platform::{
    CaptureScope, ForegroundSample, NativeActivityProvider, NativeCaptureProvider,
    NativeNotificationProvider, NativePowerStateProvider,
};
use siftkit_assistant_shell_lib::popup::{PopupController, PopupWindow, QuestionFeedback};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const TRAY_ID: &str = "siftkit-assistant";
const POPUP_LABEL: &str = "siftkit-question-popup";
const SNOOZE_SECONDS: u64 = 4 * 3600;
/// How often the worker re-reads the daemon config.
const CONFIG_POLL_SECONDS: u64 = 30;
/// Back-off after a failed connect or an errored desktop-state poll.
const RETRY_DELAY: Duration = Duration::from_secs(5);
/// How long `connect` waits for a freshly spawned daemon: attempts × interval.
const SPAWN_PROBE_ATTEMPTS: u32 = 20;
const SPAWN_PROBE_INTERVAL: Duration = Duration::from_millis(500);

/// The observation subset the shell drives its loops from; parsed loosely — unknown fields are
/// ignored and missing fields take [`Default`], the single source of the shell-side defaults —
/// so a newer daemon config still steers this shell.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase", default)]
struct ObservationConfig {
    screenshots_enabled: bool,
    fixed_cadence_seconds: u64,
    window_change_capture: bool,
    minimum_foreground_dwell_seconds: u64,
    capture_scope: CaptureScope,
    skip_fullscreen: bool,
    process_deny_list: Vec<String>,
    title_deny_patterns: Vec<String>,
    start_on_sign_in: bool,
}

impl Default for ObservationConfig {
    fn default() -> Self {
        Self {
            screenshots_enabled: false,
            fixed_cadence_seconds: 30,
            window_change_capture: false,
            minimum_foreground_dwell_seconds: 5,
            capture_scope: CaptureScope::ForegroundWindow,
            skip_fullscreen: true,
            process_deny_list: Vec::new(),
            title_deny_patterns: Vec::new(),
            start_on_sign_in: false,
        }
    }
}

struct FileKeyBlobStore {
    path: std::path::PathBuf,
}

impl KeyBlobStore for FileKeyBlobStore {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("reading the key blob failed: {error}")),
        }
    }

    fn write(&mut self, blob: &[u8]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("creating the key blob directory failed: {error}"))?;
        }
        std::fs::write(&self.path, blob)
            .map_err(|error| format!("writing the key blob failed: {error}"))
    }

    fn remove(&mut self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("removing the key blob failed: {error}")),
        }
    }
}

/// The popup window driven by the controller; a Tauri window per pending question.
struct TauriPopupWindow {
    app: AppHandle,
}

impl PopupWindow for TauriPopupWindow {
    fn open(
        &mut self,
        question: &siftkit_assistant_shell_lib::contracts::PendingQuestionDto,
    ) -> Result<(), String> {
        if let Some(existing) = self.app.get_webview_window(POPUP_LABEL) {
            let _ = existing.close();
        }
        let url = format!(
            "popup.html?id={}&question={}",
            urlencode(&question.id),
            urlencode(&question.question_text),
        );
        WebviewWindowBuilder::new(&self.app, POPUP_LABEL, WebviewUrl::App(url.into()))
            .title("SiftKit Assistant")
            .inner_size(380.0, 220.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .build()
            .map(|_| ())
            .map_err(|error| format!("popup window creation failed: {error}"))
    }

    fn close(&mut self) {
        if let Some(window) = self.app.get_webview_window(POPUP_LABEL) {
            let _ = window.close();
        }
    }
}

fn urlencode(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

struct ClientFeedback<'a> {
    client: &'a DaemonClient,
}

impl QuestionFeedback for ClientFeedback<'_> {
    fn mark_shown(&self, question_id: &str) -> Result<(), String> {
        self.client.mark_question_shown(question_id).map_err(|error| error.to_string())
    }

    fn dismiss(&self, question_id: &str) -> Result<(), String> {
        self.client.dismiss_question(question_id).map_err(|error| error.to_string())
    }

    fn answer(&self, question_id: &str, answer: &str) -> Result<(), String> {
        self.client.answer_question(question_id, answer).map_err(|error| error.to_string())
    }
}

/// Everything the worker loop and the IPC commands share.
struct ShellState {
    client: Mutex<DaemonClient>,
    controller: Mutex<PopupController>,
    supervisor: Mutex<Supervisor>,
    daemon_control: Mutex<JobObjectDaemonControl>,
    paused: AtomicBool,
    attention: AtomicBool,
    connected: AtomicBool,
    current_question_id: Mutex<Option<String>>,
    base_url: String,
}

fn base_url() -> String {
    let port = std::env::var("SIFTKIT_STATUS_PORT").unwrap_or_else(|_| "4765".into());
    format!("http://127.0.0.1:{port}")
}

fn daemon_spawn_control() -> JobObjectDaemonControl {
    let program = std::env::var("SIFTKIT_DAEMON_PROGRAM").unwrap_or_else(|_| "node".into());
    let arguments = std::env::var("SIFTKIT_DAEMON_ARGS")
        .map(|raw| raw.split_whitespace().map(str::to_string).collect())
        .unwrap_or_else(|_| vec!["dist/status-server/main.js".to_string()]);
    let working_directory = std::env::var("SIFTKIT_DAEMON_CWD").ok();
    JobObjectDaemonControl::new(program, arguments, working_directory)
}

fn key_blob_store() -> FileKeyBlobStore {
    let root = std::env::var("SIFTKIT_RUNTIME_ROOT").unwrap_or_else(|_| ".".into());
    FileKeyBlobStore {
        path: std::path::Path::new(&root).join(".siftkit").join("assistant-keys.dpapi"),
    }
}

fn update_tray(app: &AppHandle, state: &ShellState, desktop: Option<&DesktopStateDto>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let tooltip = if !state.connected.load(Ordering::Relaxed) {
        "SiftKit Assistant — daemon disconnected".to_string()
    } else if state.attention.load(Ordering::Relaxed) {
        "SiftKit Assistant — needs attention".to_string()
    } else {
        match desktop {
            None => "SiftKit Assistant".to_string(),
            Some(desktop) if !desktop.assistant_enabled => {
                "SiftKit Assistant — assistant off".to_string()
            }
            Some(desktop) if desktop.paused || state.paused.load(Ordering::Relaxed) => {
                "SiftKit Assistant — observation paused".to_string()
            }
            Some(desktop) => {
                let mut text = if desktop.capture_enabled {
                    "SiftKit Assistant — capture enabled".to_string()
                } else {
                    "SiftKit Assistant — on".to_string()
                };
                if desktop.pending_question.is_some() {
                    text.push_str(" · question waiting");
                }
                if !desktop.image_capability.capable && desktop.image_capability.queue_depth > 0 {
                    text.push_str(&format!(
                        " · {} captures await a vision model",
                        desktop.image_capability.queue_depth,
                    ));
                }
                text
            }
        }
    };
    let _ = tray.set_tooltip(Some(tooltip));
}

fn connect(state: &ShellState) -> Result<(), String> {
    let mut client = DaemonClient::new(state.base_url.clone());
    let probe = match client.bootstrap() {
        Ok(()) => match client.probe_status() {
            Ok(_) => ProbeResult::Compatible,
            Err(ClientError::Disconnected(_)) => ProbeResult::Absent,
            Err(_) => ProbeResult::Incompatible,
        },
        Err(ClientError::Disconnected(_)) => ProbeResult::Absent,
        Err(_) => ProbeResult::Incompatible,
    };
    {
        let mut supervisor = state.supervisor.lock().expect("supervisor lock");
        let mut control = state.daemon_control.lock().expect("control lock");
        supervisor.connect(probe, &mut *control)?;
    }
    if probe == ProbeResult::Absent {
        // Give the spawned daemon a moment, then bootstrap against it.
        for _ in 0..SPAWN_PROBE_ATTEMPTS {
            std::thread::sleep(SPAWN_PROBE_INTERVAL);
            if client.bootstrap().is_ok() {
                break;
            }
        }
    }
    if !client.has_token() {
        return Err("daemon did not become reachable".into());
    }
    let mut blob_store = key_blob_store();
    synchronize_custody(&client, &DpapiSecureKeyProvider, &mut blob_store)?;
    *state.client.lock().expect("client lock") = client;
    state.connected.store(true, Ordering::Relaxed);
    state.attention.store(false, Ordering::Relaxed);
    Ok(())
}

fn observation_tick(paused: bool, input: &WindowsInputTracker) -> ObservationTick {
    let activity = WindowsActivityProvider;
    let notifications = WindowsNotificationProvider;
    let power = WindowsPowerStateProvider;
    let idle = input.snapshot().unwrap_or_else(|error| {
        // No fallback signal exists; a shell that cannot report idleness must not keep
        // heartbeating a guess.
        eprintln!("input tracker failed: {error}; shell exiting");
        std::process::exit(1);
    });
    ObservationTick {
        now_epoch_seconds: now_epoch_seconds(),
        now_utc: iso8601_now(),
        paused,
        foreground: activity.foreground().ok(),
        mouse_idle_seconds: idle.mouse_seconds,
        keyboard_idle_seconds: idle.keyboard_seconds,
        session_locked: activity.session_locked(),
        notification: notifications.read(),
        power: power.read(),
    }
}

#[allow(clippy::too_many_lines)]
fn worker_loop(app: AppHandle, state: std::sync::Arc<ShellState>, input: WindowsInputTracker) {
    let mut heartbeat = Heartbeat::new();
    let mut observation = ObservationConfig::default();
    let mut scheduler = CaptureScheduler::new(
        observation.fixed_cadence_seconds,
        observation.minimum_foreground_dwell_seconds,
        observation.window_change_capture,
    );
    let mut last_config_fetch = 0u64;
    let mut was_paused = false;

    loop {
        if !state.connected.load(Ordering::Relaxed) {
            if let Err(error) = connect(&state) {
                eprintln!("shell connect failed: {error}");
                state.attention.store(true, Ordering::Relaxed);
                update_tray(&app, &state, None);
                std::thread::sleep(RETRY_DELAY);
                continue;
            }
        }

        let now = now_epoch_seconds();
        if now >= last_config_fetch + CONFIG_POLL_SECONDS {
            last_config_fetch = now;
            let fetched = {
                let client = state.client.lock().expect("client lock");
                fetch_config(&client)
            };
            match fetched {
                Ok(fetched) => {
                    observation = fetched;
                    scheduler.refresh(
                        observation.fixed_cadence_seconds,
                        observation.minimum_foreground_dwell_seconds,
                        observation.window_change_capture,
                    );
                    let mut registry = WindowsRunKeyRegistry;
                    if let Ok(exe) = std::env::current_exe() {
                        let _ = reconcile_startup(
                            &mut registry,
                            observation.start_on_sign_in,
                            &format!("\"{}\"", exe.display()),
                        );
                    }
                }
                // A disconnect or contract mismatch on the config poll halts and signals
                // exactly like one on an ingest call; stale deny lists must not keep steering
                // captures silently.
                Err(error) => handle_send_error(&state, &error),
            }
        }

        let paused = state.paused.load(Ordering::Relaxed);
        if paused && !was_paused {
            scheduler.pause();
        }
        was_paused = paused;

        // Desktop state poll: tray + popup.
        let desktop = {
            let client = state.client.lock().expect("client lock");
            client.desktop_state()
        };
        let desktop = match desktop {
            Ok(desktop) => desktop,
            Err(ClientError::Disconnected(_)) => {
                state.connected.store(false, Ordering::Relaxed);
                update_tray(&app, &state, None);
                continue;
            }
            Err(_) => {
                state.attention.store(true, Ordering::Relaxed);
                update_tray(&app, &state, None);
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
        };
        update_tray(&app, &state, Some(&desktop));
        {
            let mut controller = state.controller.lock().expect("controller lock");
            let mut window = TauriPopupWindow { app: app.clone() };
            controller.on_poll(&desktop, &mut window);
            *state.current_question_id.lock().expect("question lock") =
                desktop.pending_question.as_ref().map(|question| question.id.clone());
        }

        let daemon_paused = desktop.paused || !desktop.assistant_enabled;
        let effective_paused = paused || daemon_paused;

        // Heartbeat + activity.
        let tick = observation_tick(effective_paused, &input);
        let emissions = heartbeat.tick(&tick);
        {
            let client = state.client.lock().expect("client lock");
            for emission in &emissions {
                let sent = match emission {
                    HeartbeatEmission::Environment(environment) => {
                        client.post_environment(environment)
                    }
                    HeartbeatEmission::Activity(activity) => client.post_activity(activity),
                };
                if let Err(error) = sent {
                    handle_send_error(&state, &error);
                }
            }
        }

        // Capture pipeline.
        if desktop.capture_enabled && observation.screenshots_enabled && !effective_paused {
            let foreground = tick.foreground.as_ref().map(foreground_dto);
            let context_key = foreground.as_ref().map(foreground_context_key);
            for reason in scheduler.tick(now, context_key.as_deref()) {
                run_capture(
                    &state,
                    &observation,
                    &tick,
                    reason,
                    desktop.paused,
                    foreground.as_ref(),
                );
            }
        }

        std::thread::sleep(Duration::from_secs(1));
    }
}

/// The wire form of a foreground sample; the only place raw titles are normalized (spec §4).
fn foreground_dto(sample: &ForegroundSample) -> ForegroundContextDto {
    ForegroundContextDto {
        process_name: sample.process_name.clone(),
        executable_path: sample.executable_path.clone(),
        application_id: sample.application_id.clone(),
        normalized_title: sample.raw_title.as_deref().map(normalize_title),
        fullscreen: sample.fullscreen,
    }
}

fn fetch_config(client: &DaemonClient) -> Result<ObservationConfig, ClientError> {
    #[derive(Deserialize)]
    struct Envelope {
        assistant: Assistant,
    }
    #[derive(Deserialize)]
    struct Assistant {
        #[serde(rename = "Observation")]
        observation: ObservationConfig,
    }
    client.get_config::<Envelope>().map(|envelope| envelope.assistant.observation)
}

fn handle_send_error(state: &ShellState, error: &ClientError) {
    match error {
        ClientError::Disconnected(_) => state.connected.store(false, Ordering::Relaxed),
        ClientError::ContractMismatch(_) => state.attention.store(true, Ordering::Relaxed),
        ClientError::Rejected { .. } => {}
    }
}

fn run_capture(
    state: &ShellState,
    observation: &ObservationConfig,
    tick: &ObservationTick,
    reason: siftkit_assistant_shell_lib::contracts::CaptureReason,
    private_mode: bool,
    foreground: Option<&ForegroundContextDto>,
) {
    // The worker never schedules captures while private mode pauses observation, so rule 1
    // holds real data and fails loud (as an audit) if that gating ever weakens.
    let suppression = evaluate(&PreflightInput {
        private_mode,
        session_locked: tick.session_locked,
        secure_desktop: WindowsActivityProvider.secure_desktop_active(),
        foreground: tick.foreground.as_ref(),
        process_deny_list: &observation.process_deny_list,
        title_deny_patterns: &observation.title_deny_patterns,
        skip_fullscreen: observation.skip_fullscreen,
    });
    let client = state.client.lock().expect("client lock");
    if let Some(rule) = suppression {
        let _ = client.post_suppression(&SuppressionAuditDto {
            schema_version: SchemaV1,
            occurred_at_utc: iso8601_now(),
            rule_id: rule,
        });
        return;
    }
    let capture = match WindowsCaptureProvider.capture(observation.capture_scope) {
        Ok(capture) => capture,
        Err(_) => {
            let _ = client.post_suppression(&SuppressionAuditDto {
                schema_version: SchemaV1,
                occurred_at_utc: iso8601_now(),
                rule_id: SuppressionRuleId::CaptureFailure,
            });
            return;
        }
    };
    let (frame, display) = (capture.frame, capture.display);
    if is_blank_frame(&frame) {
        let _ = client.post_suppression(&SuppressionAuditDto {
            schema_version: SchemaV1,
            occurred_at_utc: iso8601_now(),
            rule_id: SuppressionRuleId::CaptureFailure,
        });
        return;
    }
    let Ok(png) = encode_png(&frame) else { return };
    let Some(foreground) = foreground else { return };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let logical = |pixels: u32| ((f64::from(pixels) / display.scale_factor).round() as u32).max(1);
    use base64::Engine as _;
    let submission = CaptureSubmissionDto {
        schema_version: SchemaV1,
        captured_at_utc: tick.now_utc.clone(),
        reason,
        display: CaptureDisplayDto {
            id: display.id,
            name: display.name,
            primary: display.primary,
            pixel_width: frame.width.max(1),
            pixel_height: frame.height.max(1),
            logical_width: logical(frame.width),
            logical_height: logical(frame.height),
            scale_factor: display.scale_factor,
        },
        foreground_context_key: foreground_context_key(foreground),
        foreground: foreground.clone(),
        pixel_sha256: pixel_sha256(&png),
        perceptual_hash: dhash64_hex(&frame),
        image_data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png),
        ),
    };
    if let Err(error) = client.post_capture(&submission) {
        handle_send_error(state, &error);
    }
}

#[tauri::command]
fn popup_rendered(state: tauri::State<'_, std::sync::Arc<ShellState>>) {
    let client = state.client.lock().expect("client lock");
    let feedback = ClientFeedback { client: &client };
    state.controller.lock().expect("controller lock").on_popup_rendered(&feedback);
}

#[tauri::command]
fn popup_submit(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<ShellState>>,
    answer: String,
) -> Result<(), String> {
    let client = state.client.lock().expect("client lock");
    let feedback = ClientFeedback { client: &client };
    let mut window = TauriPopupWindow { app };
    let submitted = state
        .controller
        .lock()
        .expect("controller lock")
        .on_answer_submit(&answer, &feedback, &mut window);
    if submitted { Ok(()) } else { Err("answer submit failed; kept your text — retry".into()) }
}

#[tauri::command]
fn popup_skip(app: AppHandle, state: tauri::State<'_, std::sync::Arc<ShellState>>) {
    let question_id = state.current_question_id.lock().expect("question lock").clone();
    if let Some(question_id) = question_id {
        let client = state.client.lock().expect("client lock");
        let _ = client.skip_question(&question_id);
    }
    TauriPopupWindow { app }.close();
}

#[tauri::command]
fn popup_snooze(app: AppHandle, state: tauri::State<'_, std::sync::Arc<ShellState>>) {
    let question_id = state.current_question_id.lock().expect("question lock").clone();
    if let Some(question_id) = question_id {
        let client = state.client.lock().expect("client lock");
        let eligible = iso8601_from_epoch(now_epoch_seconds() + SNOOZE_SECONDS, 0);
        let _ = client.snooze_question(&question_id, &eligible);
    }
    TauriPopupWindow { app }.close();
}

#[tauri::command]
fn popup_do_not_repeat(app: AppHandle, state: tauri::State<'_, std::sync::Arc<ShellState>>) {
    let question_id = state.current_question_id.lock().expect("question lock").clone();
    if let Some(question_id) = question_id {
        let client = state.client.lock().expect("client lock");
        let _ = client.do_not_repeat_question(&question_id);
    }
    TauriPopupWindow { app }.close();
}

#[tauri::command]
fn popup_stop_topic(app: AppHandle, state: tauri::State<'_, std::sync::Arc<ShellState>>) {
    let question_id = state.current_question_id.lock().expect("question lock").clone();
    if let Some(question_id) = question_id {
        let client = state.client.lock().expect("client lock");
        let _ = client.block_question_topic(&question_id);
    }
    TauriPopupWindow { app }.close();
}

fn main() {
    let state = std::sync::Arc::new(ShellState {
        client: Mutex::new(DaemonClient::new(base_url())),
        controller: Mutex::new(PopupController::new()),
        supervisor: Mutex::new(Supervisor::new()),
        daemon_control: Mutex::new(daemon_spawn_control()),
        paused: AtomicBool::new(false),
        attention: AtomicBool::new(false),
        connected: AtomicBool::new(false),
        current_question_id: Mutex::new(None),
        base_url: base_url(),
    });

    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            popup_rendered,
            popup_submit,
            popup_skip,
            popup_snooze,
            popup_do_not_repeat,
            popup_stop_topic,
        ])
        .setup(move |app| {
            let open = MenuItemBuilder::with_id("open_dashboard", "Open dashboard").build(app)?;
            let pause = MenuItemBuilder::with_id("pause_observation", "Pause observation")
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit SiftKit Assistant").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&open, &pause, &quit]).build()?;
            let menu_state = state.clone();
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .tooltip("SiftKit Assistant — connecting")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open_dashboard" => {
                        let url = format!("{}/", menu_state.base_url);
                        let _ = WebviewWindowBuilder::new(
                            app,
                            "siftkit-dashboard",
                            WebviewUrl::External(url.parse().expect("dashboard url")),
                        )
                        .title("SiftKit Dashboard")
                        .inner_size(1280.0, 860.0)
                        .build();
                    }
                    "pause_observation" => {
                        let paused = !menu_state.paused.load(Ordering::Relaxed);
                        menu_state.paused.store(paused, Ordering::Relaxed);
                    }
                    "quit" => {
                        let mut supervisor =
                            menu_state.supervisor.lock().expect("supervisor lock");
                        let mut control =
                            menu_state.daemon_control.lock().expect("control lock");
                        supervisor.quit(&mut *control);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let input = WindowsInputTracker::start()?;
            let worker_state = state.clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || worker_loop(handle, worker_state, input));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri app builds")
        .run(|_app, event| {
            // With no windows open the default behavior would exit; the tray owns the process
            // lifetime instead.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_config_field_takes_the_shell_default_not_a_second_hardcoded_one() {
        let parsed: ObservationConfig = serde_json::from_str("{}").expect("empty object parses");
        // The privacy-relevant flag must fail closed: absent means skip fullscreen content.
        assert!(parsed.skip_fullscreen);
        assert_eq!(parsed.fixed_cadence_seconds, 30);
        assert_eq!(parsed.minimum_foreground_dwell_seconds, 5);
        assert_eq!(parsed.capture_scope, CaptureScope::ForegroundWindow);
        assert!(!parsed.screenshots_enabled);
    }

    #[test]
    fn capture_scope_parses_the_contract_enum_and_rejects_strays() {
        let parsed: ObservationConfig =
            serde_json::from_str(r#"{"CaptureScope":"all_monitors"}"#).expect("known scope");
        assert_eq!(parsed.capture_scope, CaptureScope::AllMonitors);
        assert!(
            serde_json::from_str::<ObservationConfig>(r#"{"CaptureScope":"everything"}"#).is_err(),
            "an unknown scope is a contract problem, not a silent foreground_window",
        );
    }
}
