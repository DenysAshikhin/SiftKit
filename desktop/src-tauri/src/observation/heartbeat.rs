//! Pure heartbeat scheduling (spec §2): an `EnvironmentStateDto` every
//! [`crate::contracts::HEARTBEAT_INTERVAL_SECONDS`], an `ActivityEventDto` on the tick a
//! foreground change is seen while the session is unlocked, and nothing at all while paused.

use crate::contracts::{
    ActivityEventDto, EnvironmentStateDto, ForegroundContextDto, PowerStateDto, SchemaV1,
    HEARTBEAT_INTERVAL_SECONDS,
};
use crate::observation::titles::normalize_title;
use crate::platform::{ForegroundSample, NotificationSample, PowerSample};

/// Everything the providers reported for one tick. Pure data so the loop is testable with an
/// injected clock and fake providers.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservationTick {
    pub now_epoch_seconds: u64,
    pub now_utc: String,
    pub paused: bool,
    /// `None` when the activity provider errored; nothing identity-bearing is emitted then.
    pub foreground: Option<ForegroundSample>,
    pub idle_seconds: u32,
    pub session_locked: bool,
    pub notification: NotificationSample,
    pub power: PowerSample,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HeartbeatEmission {
    Environment(EnvironmentStateDto),
    Activity(ActivityEventDto),
}

/// A privacy-filtered foreground context plus the key used for change detection.
fn foreground_dto(sample: &ForegroundSample) -> ForegroundContextDto {
    ForegroundContextDto {
        process_name: sample.process_name.clone(),
        executable_path: sample.executable_path.clone(),
        application_id: sample.application_id.clone(),
        normalized_title: sample.raw_title.as_deref().map(normalize_title),
        fullscreen: sample.fullscreen,
    }
}

pub fn foreground_context_key(foreground: &ForegroundContextDto) -> String {
    format!(
        "{}|{}",
        foreground.application_id.as_deref().unwrap_or("unknown"),
        foreground
            .normalized_title
            .as_deref()
            .unwrap_or("")
            .to_lowercase(),
    )
}

#[derive(Debug, Default)]
pub struct Heartbeat {
    last_environment_at: Option<u64>,
    last_context_key: Option<String>,
}

impl Heartbeat {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn tick(&mut self, tick: &ObservationTick) -> Vec<HeartbeatEmission> {
        if tick.paused {
            // Paused/private is silence, and the next resume re-reports the then-current
            // foreground as a fresh change instead of pretending continuity across the gap.
            self.last_environment_at = None;
            self.last_context_key = None;
            return Vec::new();
        }

        let mut emissions = Vec::new();
        let due = match self.last_environment_at {
            None => true,
            Some(last) => tick.now_epoch_seconds >= last + HEARTBEAT_INTERVAL_SECONDS,
        };
        if due {
            self.last_environment_at = Some(tick.now_epoch_seconds);
            emissions.push(HeartbeatEmission::Environment(EnvironmentStateDto {
                schema_version: SchemaV1,
                captured_at_utc: tick.now_utc.clone(),
                fullscreen: tick.notification.fullscreen,
                locked: tick.session_locked,
                do_not_disturb: tick.notification.do_not_disturb,
                presenting: tick.notification.presenting,
                excluded_application: false,
                seconds_since_input: tick.idle_seconds,
                power: match tick.power {
                    PowerSample::Available { on_battery, battery_percent } => {
                        PowerStateDto::Available { on_battery, battery_percent }
                    }
                    PowerSample::Unavailable => PowerStateDto::Unavailable,
                },
            }));
        }

        if let Some(sample) = tick.foreground.as_ref() {
            let foreground = foreground_dto(sample);
            let key = foreground_context_key(&foreground);
            let changed = self.last_context_key.as_deref() != Some(key.as_str());
            if changed && !tick.session_locked {
                self.last_context_key = Some(key);
                emissions.push(HeartbeatEmission::Activity(ActivityEventDto {
                    schema_version: SchemaV1,
                    captured_at_utc: tick.now_utc.clone(),
                    foreground,
                    idle_seconds: tick.idle_seconds,
                    session_locked: tick.session_locked,
                }));
            }
        }
        emissions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(title: &str) -> ForegroundSample {
        ForegroundSample {
            process_name: Some("Code.exe".into()),
            executable_path: Some(r"C:\Code.exe".into()),
            application_id: Some("app:code".into()),
            raw_title: Some(title.into()),
            fullscreen: false,
        }
    }

    fn tick(now: u64, foreground: Option<ForegroundSample>) -> ObservationTick {
        ObservationTick {
            now_epoch_seconds: now,
            now_utc: format!("2026-08-10T09:00:{:02}.000Z", now % 60),
            paused: false,
            foreground,
            idle_seconds: 3,
            session_locked: false,
            notification: NotificationSample::default(),
            power: PowerSample::Available { on_battery: false, battery_percent: 80.0 },
        }
    }

    #[test]
    fn environment_emits_every_interval_and_not_between() {
        let mut heartbeat = Heartbeat::new();
        let first = heartbeat.tick(&tick(0, None));
        assert!(matches!(first.as_slice(), [HeartbeatEmission::Environment(_)]));
        assert!(heartbeat.tick(&tick(10, None)).is_empty());
        let second = heartbeat.tick(&tick(HEARTBEAT_INTERVAL_SECONDS, None));
        assert!(matches!(second.as_slice(), [HeartbeatEmission::Environment(_)]));
    }

    #[test]
    fn activity_fires_on_change_on_the_same_tick_while_unlocked() {
        let mut heartbeat = Heartbeat::new();
        let first = heartbeat.tick(&tick(0, Some(sample("SiftKit - Code"))));
        assert_eq!(first.len(), 2, "environment + the initial foreground");
        assert!(heartbeat.tick(&tick(1, Some(sample("SiftKit - Code")))).is_empty());
        let changed = heartbeat.tick(&tick(2, Some(sample("Budget - Excel"))));
        assert!(
            matches!(changed.as_slice(), [HeartbeatEmission::Activity(event)]
                if event.foreground.normalized_title.as_deref() == Some("Budget - Excel")),
        );
    }

    #[test]
    fn nothing_is_emitted_while_locked_or_paused() {
        let mut heartbeat = Heartbeat::new();
        let mut locked = tick(0, Some(sample("SiftKit - Code")));
        locked.session_locked = true;
        let emissions = heartbeat.tick(&locked);
        assert_eq!(emissions.len(), 1, "the environment beat still reports the locked session");
        assert!(matches!(emissions.first(), Some(HeartbeatEmission::Environment(env)) if env.locked));

        let mut paused = tick(30, Some(sample("Budget - Excel")));
        paused.paused = true;
        assert!(heartbeat.tick(&paused).is_empty(), "paused is silence");
    }

    #[test]
    fn titles_are_normalized_before_leaving_the_shell() {
        let mut heartbeat = Heartbeat::new();
        let emissions = heartbeat.tick(&tick(
            0,
            Some(sample("Docs https://secret.example.com/x - Browser")),
        ));
        let activity = emissions.iter().find_map(|emission| match emission {
            HeartbeatEmission::Activity(event) => Some(event),
            HeartbeatEmission::Environment(_) => None,
        });
        assert_eq!(
            activity.expect("activity").foreground.normalized_title.as_deref(),
            Some("Docs - Browser"),
        );
    }
}
