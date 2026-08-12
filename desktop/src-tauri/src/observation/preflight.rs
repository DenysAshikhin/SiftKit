//! Capture privacy preflight (spec §4). Rules are evaluated in exactly the documented order and
//! the first match wins. A provider error is a suppression, never a capture.
//!
//! Rule 9 (accessibility-text secret classification) has no input here: the shell wires no
//! accessibility extraction yet. The feature that adds extraction adds the rule with it.

use regex::Regex;

use crate::contracts::SuppressionRuleId;
use crate::platform::ForegroundSample;

/// Title suffixes the major browsers append to private windows.
const PRIVATE_BROWSING_MARKERS: [&str; 3] = ["inprivate", "incognito", "private browsing"];

pub struct PreflightInput<'a> {
    pub private_mode: bool,
    pub session_locked: bool,
    pub secure_desktop: bool,
    /// `None` when the activity provider failed or reported no identity at all.
    pub foreground: Option<&'a ForegroundSample>,
    pub process_deny_list: &'a [String],
    pub title_deny_patterns: &'a [String],
    /// Config `SkipFullscreen` (spec §4 rule 8); the foreground's own flag supplies the state.
    pub skip_fullscreen: bool,
}

pub fn evaluate(input: &PreflightInput<'_>) -> Option<SuppressionRuleId> {
    if input.private_mode {
        return Some(SuppressionRuleId::PrivateMode);
    }
    if input.session_locked {
        return Some(SuppressionRuleId::SessionLocked);
    }
    if input.secure_desktop {
        return Some(SuppressionRuleId::SecureDesktop);
    }
    let Some(foreground) = input.foreground else {
        return Some(SuppressionRuleId::UnknownForeground);
    };
    let Some(process_name) = foreground.process_name.as_deref() else {
        return Some(SuppressionRuleId::UnknownForeground);
    };
    if input
        .process_deny_list
        .iter()
        .any(|denied| denied.eq_ignore_ascii_case(process_name))
    {
        return Some(SuppressionRuleId::ProcessDenylist);
    }
    let title = foreground.raw_title.as_deref().unwrap_or("");
    for pattern in input.title_deny_patterns {
        // A pattern the user typed that fails to compile must deny, not silently allow.
        match Regex::new(&format!("(?i){pattern}")) {
            Ok(compiled) if compiled.is_match(title) => {
                return Some(SuppressionRuleId::TitleDenyPattern);
            }
            Ok(_) => {}
            Err(_) => return Some(SuppressionRuleId::TitleDenyPattern),
        }
    }
    let lowered_title = title.to_lowercase();
    if PRIVATE_BROWSING_MARKERS
        .iter()
        .any(|marker| lowered_title.contains(marker))
    {
        return Some(SuppressionRuleId::PrivateBrowsing);
    }
    if input.skip_fullscreen && foreground.fullscreen {
        return Some(SuppressionRuleId::FullscreenSuppression);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn foreground() -> ForegroundSample {
        ForegroundSample {
            process_name: Some("Code.exe".into()),
            executable_path: Some(r"C:\Code.exe".into()),
            application_id: Some("app:code".into()),
            raw_title: Some("SiftKit - Visual Studio Code".into()),
            fullscreen: false,
        }
    }

    fn base<'a>(sample: &'a ForegroundSample) -> PreflightInput<'a> {
        PreflightInput {
            private_mode: false,
            session_locked: false,
            secure_desktop: false,
            foreground: Some(sample),
            process_deny_list: &[],
            title_deny_patterns: &[],
            skip_fullscreen: true,
        }
    }

    #[test]
    fn a_clean_foreground_passes() {
        let sample = foreground();
        assert_eq!(evaluate(&base(&sample)), None);
    }

    #[test]
    fn rules_fire_in_spec_order_and_the_first_match_wins() {
        let mut fullscreen_denied = foreground();
        fullscreen_denied.fullscreen = true;
        let deny = ["code.exe".to_string()];
        let input = PreflightInput {
            private_mode: true,
            session_locked: true,
            secure_desktop: true,
            foreground: Some(&fullscreen_denied),
            process_deny_list: &deny,
            title_deny_patterns: &[],
            skip_fullscreen: true,
        };
        assert_eq!(evaluate(&input), Some(SuppressionRuleId::PrivateMode));

        let mut next = input;
        next.private_mode = false;
        assert_eq!(evaluate(&next), Some(SuppressionRuleId::SessionLocked));
        next.session_locked = false;
        assert_eq!(evaluate(&next), Some(SuppressionRuleId::SecureDesktop));
        next.secure_desktop = false;
        assert_eq!(evaluate(&next), Some(SuppressionRuleId::ProcessDenylist));
        next.process_deny_list = &[];
        next.skip_fullscreen = true;
        assert_eq!(evaluate(&next), Some(SuppressionRuleId::FullscreenSuppression));
        next.skip_fullscreen = false;
        assert_eq!(evaluate(&next), None);
    }

    #[test]
    fn an_unknown_or_errored_foreground_fails_closed() {
        let sample = foreground();
        let mut input = base(&sample);
        input.foreground = None;
        assert_eq!(evaluate(&input), Some(SuppressionRuleId::UnknownForeground));

        let mut anonymous = foreground();
        anonymous.process_name = None;
        let mut input = base(&sample);
        input.foreground = Some(&anonymous);
        assert_eq!(evaluate(&input), Some(SuppressionRuleId::UnknownForeground));
    }

    #[test]
    fn title_patterns_and_private_browsing_suppress() {
        let mut banking = foreground();
        banking.raw_title = Some("My Bank - Account Overview".into());
        let patterns = [".*bank.*".to_string()];
        let mut input = base(&banking);
        input.title_deny_patterns = &patterns;
        assert_eq!(evaluate(&input), Some(SuppressionRuleId::TitleDenyPattern));

        let broken = ["(".to_string()];
        let mut input = base(&banking);
        input.title_deny_patterns = &broken;
        assert_eq!(
            evaluate(&input),
            Some(SuppressionRuleId::TitleDenyPattern),
            "an uncompilable user pattern denies rather than silently allowing",
        );

        let mut incognito = foreground();
        incognito.raw_title = Some("Search - Google Chrome (Incognito)".into());
        let input = base(&incognito);
        assert_eq!(evaluate(&input), Some(SuppressionRuleId::PrivateBrowsing));
    }
}
