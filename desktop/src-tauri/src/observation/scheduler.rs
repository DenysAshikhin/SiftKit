//! Dwell/cadence capture scheduling (spec §4): a fixed-cadence trigger every
//! `FixedCadenceSeconds`, and a `window_change` trigger once a new foreground has dwelt for
//! `MinimumForegroundDwellSeconds`. Pause cancels every timer immediately.

use crate::contracts::CaptureReason;

#[derive(Debug)]
pub struct CaptureScheduler {
    cadence_seconds: u64,
    dwell_seconds: u64,
    window_change_enabled: bool,
    last_cadence_at: Option<u64>,
    current_context: Option<String>,
    dwell_armed_at: Option<u64>,
}

impl CaptureScheduler {
    pub fn new(cadence_seconds: u64, dwell_seconds: u64, window_change_enabled: bool) -> Self {
        Self {
            cadence_seconds,
            dwell_seconds,
            window_change_enabled,
            last_cadence_at: None,
            current_context: None,
            dwell_armed_at: None,
        }
    }

    pub fn refresh(&mut self, cadence_seconds: u64, dwell_seconds: u64, window_change: bool) {
        self.cadence_seconds = cadence_seconds;
        self.dwell_seconds = dwell_seconds;
        self.window_change_enabled = window_change;
    }

    /// Cancels every armed timer. Called the moment pause or private mode begins.
    pub fn pause(&mut self) {
        self.last_cadence_at = None;
        self.current_context = None;
        self.dwell_armed_at = None;
    }

    pub fn tick(&mut self, now: u64, context_key: Option<&str>) -> Vec<CaptureReason> {
        let mut triggers = Vec::new();
        let cadence_due = match self.last_cadence_at {
            None => true,
            Some(last) => now >= last + self.cadence_seconds,
        };
        if cadence_due {
            self.last_cadence_at = Some(now);
            triggers.push(CaptureReason::FixedCadence);
        }

        match context_key {
            None => {
                self.current_context = None;
                self.dwell_armed_at = None;
            }
            Some(key) => {
                if self.current_context.as_deref() != Some(key) {
                    // Every further change re-arms; only sustained focus fires (spec §4).
                    self.current_context = Some(key.to_string());
                    self.dwell_armed_at = self.window_change_enabled.then_some(now);
                } else if let Some(armed_at) = self.dwell_armed_at {
                    if now >= armed_at + self.dwell_seconds {
                        self.dwell_armed_at = None;
                        triggers.push(CaptureReason::WindowChange);
                    }
                }
            }
        }
        triggers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_cadence_fires_every_interval() {
        let mut scheduler = CaptureScheduler::new(30, 5, false);
        assert_eq!(scheduler.tick(0, None), vec![CaptureReason::FixedCadence]);
        assert!(scheduler.tick(29, None).is_empty());
        assert_eq!(scheduler.tick(30, None), vec![CaptureReason::FixedCadence]);
    }

    #[test]
    fn dwell_fires_after_sustained_focus_and_resets_on_further_changes() {
        let mut scheduler = CaptureScheduler::new(1000, 5, true);
        scheduler.tick(0, Some("app:a|one"));
        assert!(scheduler.tick(2, Some("app:a|one")).is_empty(), "still dwelling");
        // Focus moves before the dwell elapses: the timer re-arms on the new context.
        scheduler.tick(3, Some("app:b|two"));
        assert!(scheduler.tick(7, Some("app:b|two")).is_empty());
        assert_eq!(
            scheduler.tick(8, Some("app:b|two")),
            vec![CaptureReason::WindowChange],
        );
        assert!(
            scheduler.tick(9, Some("app:b|two")).is_empty(),
            "one change fires exactly once",
        );
    }

    #[test]
    fn window_change_stays_silent_when_disabled() {
        let mut scheduler = CaptureScheduler::new(1000, 5, false);
        scheduler.tick(0, Some("app:a|one"));
        assert!(scheduler.tick(10, Some("app:a|one")).is_empty());
    }

    #[test]
    fn pause_cancels_all_timers_immediately() {
        let mut scheduler = CaptureScheduler::new(30, 5, true);
        scheduler.tick(0, Some("app:a|one"));
        scheduler.pause();
        // Resume: cadence restarts from now and the same context re-arms as a fresh change.
        let resumed = scheduler.tick(10, Some("app:a|one"));
        assert_eq!(resumed, vec![CaptureReason::FixedCadence]);
        assert!(scheduler.tick(14, Some("app:a|one")).is_empty());
        assert_eq!(
            scheduler.tick(15, Some("app:a|one")),
            vec![CaptureReason::WindowChange],
        );
    }
}
