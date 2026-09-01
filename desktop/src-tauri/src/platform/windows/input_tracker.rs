//! Raw Input mouse/keyboard idle tracking (three-signal idle gate design §3.1). Gamepads and every
//! other HID usage are invisible by construction: only usages 0x02 and 0x06 are registered.

use std::sync::atomic::{AtomicU32, Ordering};

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
}
