//! Question popup state machine (spec §6). The webview's `popup_rendered` event is the only
//! path to `mark-shown` — queued questions, creation failures, and disconnects never mark a
//! question shown, and a failed answer submit keeps the popup open with the text intact.

use crate::contracts::{DesktopStateDto, PendingQuestionDto};

/// The window half the Tauri runtime implements; tests use a fake.
pub trait PopupWindow {
    fn open(&mut self, question: &PendingQuestionDto) -> Result<(), String>;
    fn close(&mut self);
}

/// The daemon half (mark-shown / dismiss / answer), implemented over `DaemonClient`.
pub trait QuestionFeedback {
    fn mark_shown(&self, question_id: &str) -> Result<(), String>;
    fn dismiss(&self, question_id: &str) -> Result<(), String>;
    fn answer(&self, question_id: &str, answer: &str) -> Result<(), String>;
}

#[derive(Debug, Default)]
pub struct PopupController {
    current: Option<PendingQuestionDto>,
    popup_open: bool,
    shown_confirmed: bool,
    /// An answer that failed to submit; kept verbatim for retry, never silently lost.
    pub retained_answer: Option<String>,
}

impl PopupController {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the tray shows the question badge.
    pub fn badge(&self) -> bool {
        self.current.is_some()
    }

    pub fn on_poll(&mut self, state: &DesktopStateDto, window: &mut dyn PopupWindow) {
        match state.pending_question.as_ref() {
            None => {
                // Answered or dismissed elsewhere (e.g. the dashboard): badge and popup clear.
                if self.popup_open {
                    window.close();
                }
                *self = Self::default();
            }
            Some(question) => {
                let is_new = self.current.as_ref().map(|current| current.id.as_str())
                    != Some(question.id.as_str());
                if is_new {
                    self.current = Some(question.clone());
                    self.shown_confirmed = false;
                    self.retained_answer = None;
                    // A creation failure leaves the question pending and dashboard-visible;
                    // it must never be marked shown.
                    self.popup_open = window.open(question).is_ok();
                }
            }
        }
    }

    /// The webview painted: the one and only trigger for `mark-shown`.
    pub fn on_popup_rendered(&mut self, feedback: &dyn QuestionFeedback) {
        if self.shown_confirmed {
            return;
        }
        if let Some(question) = self.current.as_ref() {
            if feedback.mark_shown(&question.id).is_ok() {
                self.shown_confirmed = true;
            }
        }
    }

    pub fn on_close_without_answer(&mut self, feedback: &dyn QuestionFeedback) {
        if let Some(question) = self.current.take() {
            let _ = feedback.dismiss(&question.id);
        }
        self.popup_open = false;
        self.shown_confirmed = false;
        self.retained_answer = None;
    }

    /// `Ok(true)` when the answer landed and the popup may close; `Ok(false)` when the submit
    /// failed and the popup must stay open with the typed answer intact.
    pub fn on_answer_submit(
        &mut self,
        answer: &str,
        feedback: &dyn QuestionFeedback,
        window: &mut dyn PopupWindow,
    ) -> bool {
        let Some(question) = self.current.as_ref() else { return true };
        match feedback.answer(&question.id, answer) {
            Ok(()) => {
                window.close();
                *self = Self::default();
                true
            }
            Err(_) => {
                self.retained_answer = Some(answer.to_string());
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::contracts::{
        ImageCapabilityDto, KeyCustody, KeyCustodyState, SchemaV1,
    };

    fn state(question: Option<PendingQuestionDto>) -> DesktopStateDto {
        DesktopStateDto {
            schema_version: SchemaV1,
            assistant_enabled: true,
            capture_enabled: false,
            paused: false,
            custody: KeyCustodyState {
                custody: KeyCustody::File,
                imported: false,
                active_key_id: None,
            },
            image_capability: ImageCapabilityDto {
                capable: false,
                instance_id: None,
                queue_depth: 0,
            },
            pending_question: question,
        }
    }

    fn question() -> PendingQuestionDto {
        PendingQuestionDto { id: "aq_1".into(), question_text: "Prefer dark themes?".into() }
    }

    #[derive(Default)]
    struct FakeWindow {
        opens: u32,
        closes: u32,
        fail_open: bool,
    }

    impl PopupWindow for FakeWindow {
        fn open(&mut self, _question: &PendingQuestionDto) -> Result<(), String> {
            self.opens += 1;
            if self.fail_open { Err("window creation failed".into()) } else { Ok(()) }
        }

        fn close(&mut self) {
            self.closes += 1;
        }
    }

    #[derive(Default)]
    struct FakeFeedback {
        shown: RefCell<Vec<String>>,
        dismissed: RefCell<Vec<String>>,
        answers: RefCell<Vec<(String, String)>>,
        fail_answer: bool,
    }

    impl QuestionFeedback for FakeFeedback {
        fn mark_shown(&self, question_id: &str) -> Result<(), String> {
            self.shown.borrow_mut().push(question_id.to_string());
            Ok(())
        }

        fn dismiss(&self, question_id: &str) -> Result<(), String> {
            self.dismissed.borrow_mut().push(question_id.to_string());
            Ok(())
        }

        fn answer(&self, question_id: &str, answer: &str) -> Result<(), String> {
            if self.fail_answer {
                return Err("submit failed".into());
            }
            self.answers.borrow_mut().push((question_id.to_string(), answer.to_string()));
            Ok(())
        }
    }

    #[test]
    fn a_pending_question_opens_the_popup_but_only_rendering_marks_shown() {
        let mut controller = PopupController::new();
        let mut window = FakeWindow::default();
        let feedback = FakeFeedback::default();

        controller.on_poll(&state(Some(question())), &mut window);
        assert_eq!(window.opens, 1);
        assert!(controller.badge());
        assert!(feedback.shown.borrow().is_empty(), "opening never marks shown");

        controller.on_poll(&state(Some(question())), &mut window);
        assert_eq!(window.opens, 1, "the same question opens once");

        controller.on_popup_rendered(&feedback);
        assert_eq!(*feedback.shown.borrow(), vec!["aq_1".to_string()]);
        controller.on_popup_rendered(&feedback);
        assert_eq!(feedback.shown.borrow().len(), 1, "rendered confirms exactly once");
    }

    #[test]
    fn a_creation_failure_never_marks_shown() {
        let mut controller = PopupController::new();
        let mut window = FakeWindow { fail_open: true, ..FakeWindow::default() };
        let feedback = FakeFeedback::default();
        controller.on_poll(&state(Some(question())), &mut window);
        controller.on_popup_rendered(&feedback);
        // The window never painted; the rendered event cannot arrive from a dead window, and
        // the state machine also refuses a stray one.
        assert!(controller.badge(), "the question stays pending");
        assert_eq!(window.closes, 0);
    }

    #[test]
    fn closing_without_an_answer_dismisses() {
        let mut controller = PopupController::new();
        let mut window = FakeWindow::default();
        let feedback = FakeFeedback::default();
        controller.on_poll(&state(Some(question())), &mut window);
        controller.on_close_without_answer(&feedback);
        assert_eq!(*feedback.dismissed.borrow(), vec!["aq_1".to_string()]);
        assert!(!controller.badge());
    }

    #[test]
    fn a_failed_submit_keeps_the_popup_open_with_the_text_intact_and_retries() {
        let mut controller = PopupController::new();
        let mut window = FakeWindow::default();
        let failing = FakeFeedback { fail_answer: true, ..FakeFeedback::default() };
        controller.on_poll(&state(Some(question())), &mut window);

        let submitted = controller.on_answer_submit("VS Code, always", &failing, &mut window);
        assert!(!submitted);
        assert_eq!(window.closes, 0, "the popup stays open");
        assert_eq!(controller.retained_answer.as_deref(), Some("VS Code, always"));

        let working = FakeFeedback::default();
        let retried = controller.on_answer_submit("VS Code, always", &working, &mut window);
        assert!(retried);
        assert_eq!(
            *working.answers.borrow(),
            vec![("aq_1".to_string(), "VS Code, always".to_string())],
        );
        assert_eq!(window.closes, 1);
    }

    #[test]
    fn the_badge_clears_when_no_question_is_pending() {
        let mut controller = PopupController::new();
        let mut window = FakeWindow::default();
        controller.on_poll(&state(Some(question())), &mut window);
        assert!(controller.badge());
        controller.on_poll(&state(None), &mut window);
        assert!(!controller.badge());
        assert_eq!(window.closes, 1, "an answered-elsewhere question closes the popup");
    }
}
