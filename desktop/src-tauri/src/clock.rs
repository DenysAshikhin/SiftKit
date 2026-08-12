//! UTC timestamps without a date-time dependency: the DTOs carry RFC 3339 strings.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Days-from-civil inverse (Howard Hinnant's algorithm) — epoch days to (year, month, day).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month as u32, day as u32)
}

pub fn iso8601_from_epoch(epoch_seconds: u64, milliseconds: u32) -> String {
    let days = (epoch_seconds / 86_400) as i64;
    let seconds_of_day = epoch_seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{milliseconds:03}Z",
        seconds_of_day / 3600,
        (seconds_of_day % 3600) / 60,
        seconds_of_day % 60,
    )
}

pub fn iso8601_now() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    iso8601_from_epoch(now.as_secs(), now.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_epochs_format_correctly() {
        assert_eq!(iso8601_from_epoch(0, 0), "1970-01-01T00:00:00.000Z");
        // 2026-08-10T14:03:11Z
        assert_eq!(iso8601_from_epoch(1_786_370_591, 250), "2026-08-10T14:03:11.250Z");
        // Leap-year boundary.
        assert_eq!(iso8601_from_epoch(951_782_400, 0), "2000-02-29T00:00:00.000Z");
    }
}
