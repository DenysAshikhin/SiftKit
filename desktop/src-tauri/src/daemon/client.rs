//! The authenticated loopback client (spec §2). The bearer is bootstrapped once per shell
//! lifecycle and kept memory-only; a contract mismatch (400) or a disconnect halts capture with
//! no local buffering — nothing is captured while there is nowhere authenticated to send it.

use serde::Deserialize;

use crate::contracts::{
    ActivityEventDto, CaptureSubmissionDto, DesktopStateDto, EnvironmentStateDto,
    KeyCustodyStatusDto, KeyMaterialDto, SuppressionAuditDto,
};
use crate::custody::CustodyDaemon;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// The daemon rejected the payload as an unsupported contract generation (HTTP 400):
    /// capture halts and the tray shows the attention state.
    ContractMismatch(String),
    /// The daemon is unreachable: capture halts immediately, nothing is buffered.
    Disconnected(String),
    /// Any other daemon-side rejection (auth, conflict, server error).
    Rejected { status: u16, message: String },
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ContractMismatch(message) => write!(formatter, "contract mismatch: {message}"),
            Self::Disconnected(message) => write!(formatter, "daemon unreachable: {message}"),
            Self::Rejected { status, message } => write!(formatter, "rejected ({status}): {message}"),
        }
    }
}

#[derive(Debug, Deserialize)]
struct BootstrapResponse {
    token: String,
}

pub struct DaemonClient {
    base_url: String,
    agent: ureq::Agent,
    token: Option<String>,
}

impl DaemonClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(15))
                .build(),
            token: None,
        }
    }

    /// Fetches the loopback bearer once; it lives in this struct and nowhere else.
    pub fn bootstrap(&mut self) -> Result<(), ClientError> {
        let url = format!("{}/assistant/auth/bootstrap", self.base_url);
        let response = self.agent.get(&url).call().map_err(map_transport)?;
        let parsed: BootstrapResponse = response
            .into_json()
            .map_err(|error| ClientError::Disconnected(error.to_string()))?;
        self.token = Some(parsed.token);
        Ok(())
    }

    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    fn bearer(&self) -> Result<String, ClientError> {
        self.token
            .as_deref()
            .map(|token| format!("Bearer {token}"))
            .ok_or_else(|| ClientError::Disconnected("no bearer bootstrapped".into()))
    }

    fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, ClientError> {
        let response = self
            .agent
            .get(&format!("{}{path}", self.base_url))
            .set("Authorization", &self.bearer()?)
            .call()
            .map_err(map_transport)?;
        response
            .into_json()
            .map_err(|error| ClientError::Disconnected(error.to_string()))
    }

    fn post_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &impl serde::Serialize,
    ) -> Result<T, ClientError> {
        let response = self
            .agent
            .post(&format!("{}{path}", self.base_url))
            .set("Authorization", &self.bearer()?)
            .send_json(body)
            .map_err(map_transport)?;
        response
            .into_json()
            .map_err(|error| ClientError::Disconnected(error.to_string()))
    }

    pub fn desktop_state(&self) -> Result<DesktopStateDto, ClientError> {
        self.get_json("/assistant/desktop/state")
    }

    /// `GET /assistant/config`, parsed into whatever subset the caller models.
    pub fn get_config<T: for<'de> Deserialize<'de>>(&self) -> Result<T, ClientError> {
        self.get_json("/assistant/config")
    }

    pub fn post_environment(&self, state: &EnvironmentStateDto) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>("/assistant/ingest/environment", state)?;
        Ok(())
    }

    pub fn post_activity(&self, event: &ActivityEventDto) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>("/assistant/ingest/activity", event)?;
        Ok(())
    }

    pub fn post_capture(&self, capture: &CaptureSubmissionDto) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>("/assistant/ingest/capture", capture)?;
        Ok(())
    }

    pub fn post_suppression(&self, audit: &SuppressionAuditDto) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>("/assistant/ingest/suppression", audit)?;
        Ok(())
    }

    pub fn mark_question_shown(&self, question_id: &str) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>(
            "/assistant/questions/mark-shown",
            &serde_json::json!({ "questionId": question_id }),
        )?;
        Ok(())
    }

    pub fn dismiss_question(&self, question_id: &str) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>(
            "/assistant/questions/dismiss",
            &serde_json::json!({ "questionId": question_id }),
        )?;
        Ok(())
    }

    pub fn answer_question(&self, question_id: &str, answer: &str) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>(
            &format!("/assistant/questions/{question_id}/answer"),
            &serde_json::json!({ "answer": answer }),
        )?;
        Ok(())
    }

    pub fn skip_question(&self, question_id: &str) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>(
            &format!("/assistant/questions/{question_id}/skip"),
            &serde_json::json!({}),
        )?;
        Ok(())
    }

    pub fn snooze_question(
        &self,
        question_id: &str,
        eligible_after_utc: &str,
    ) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>(
            &format!("/assistant/questions/{question_id}/snooze"),
            &serde_json::json!({ "eligibleAfterUtc": eligible_after_utc }),
        )?;
        Ok(())
    }

    pub fn do_not_repeat_question(&self, question_id: &str) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>(
            &format!("/assistant/questions/{question_id}/do-not-repeat"),
            &serde_json::json!({}),
        )?;
        Ok(())
    }

    pub fn block_question_topic(&self, question_id: &str) -> Result<(), ClientError> {
        self.post_json::<serde_json::Value>(
            &format!("/assistant/questions/{question_id}/block-topic"),
            &serde_json::json!({}),
        )?;
        Ok(())
    }

    pub fn probe_status(&self) -> Result<serde_json::Value, ClientError> {
        let response = self
            .agent
            .get(&format!("{}/assistant/status", self.base_url))
            .set("Authorization", &self.bearer()?)
            .call()
            .map_err(map_transport)?;
        response
            .into_json()
            .map_err(|error| ClientError::Disconnected(error.to_string()))
    }
}

impl CustodyDaemon for DaemonClient {
    fn custody_status(&self) -> Result<KeyCustodyStatusDto, String> {
        self.get_json("/assistant/keys/custody").map_err(|error| error.to_string())
    }

    fn export_keys(&self) -> Result<KeyMaterialDto, String> {
        self.post_json("/assistant/keys/export", &serde_json::json!({}))
            .map_err(|error| error.to_string())
    }

    fn import_keys(&self, material: &KeyMaterialDto) -> Result<KeyCustodyStatusDto, String> {
        self.post_json("/assistant/keys/import", material).map_err(|error| error.to_string())
    }
}

fn map_transport(error: ureq::Error) -> ClientError {
    match error {
        ureq::Error::Status(status, response) => {
            let message = response.into_string().unwrap_or_default();
            if status == 400 {
                ClientError::ContractMismatch(message)
            } else {
                ClientError::Rejected { status, message }
            }
        }
        ureq::Error::Transport(transport) => ClientError::Disconnected(transport.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    use crate::contracts::{SchemaV1, SuppressionRuleId};

    struct StubServer {
        base_url: String,
        received: mpsc::Receiver<(String, Option<String>)>,
        handle: std::thread::JoinHandle<()>,
    }

    /// Serves scripted responses; records `(path, authorization)` per request.
    fn serve(responses: Vec<(u16, &'static str)>) -> StubServer {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("stub server");
        let base_url = format!("http://{}", server.server_addr());
        let (sender, received) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            for (status, body) in responses {
                let Ok(request) = server.recv() else { return };
                let authorization = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Authorization"))
                    .map(|header| header.value.as_str().to_string());
                let _ = sender.send((request.url().to_string(), authorization));
                let response = tiny_http::Response::from_string(body)
                    .with_status_code(status)
                    .with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..], &b"application/json"[..],
                        )
                        .expect("header"),
                    );
                let _ = request.respond(response);
            }
        });
        StubServer { base_url, received, handle }
    }

    fn suppression() -> SuppressionAuditDto {
        SuppressionAuditDto {
            schema_version: SchemaV1,
            occurred_at_utc: "2026-08-10T14:03:11.000Z".into(),
            rule_id: SuppressionRuleId::PrivateMode,
        }
    }

    #[test]
    fn every_call_carries_the_bootstrapped_bearer() {
        let stub = serve(vec![
            (200, r#"{"token":"session-secret"}"#),
            (200, r#"{"ok":true}"#),
        ]);
        let mut client = DaemonClient::new(stub.base_url.clone());
        client.bootstrap().expect("bootstrap");
        client.post_suppression(&suppression()).expect("post");

        let (bootstrap_path, bootstrap_auth) = stub.received.recv().expect("bootstrap seen");
        assert_eq!(bootstrap_path, "/assistant/auth/bootstrap");
        assert_eq!(bootstrap_auth, None, "bootstrap itself needs no bearer");
        let (path, authorization) = stub.received.recv().expect("call seen");
        assert_eq!(path, "/assistant/ingest/suppression");
        assert_eq!(authorization.as_deref(), Some("Bearer session-secret"));
        stub.handle.join().expect("server thread");
    }

    #[test]
    fn a_version_mismatch_is_a_contract_error_that_halts_capture() {
        let stub = serve(vec![
            (200, r#"{"token":"session-secret"}"#),
            (400, r#"{"error":{"code":"invalid_request","message":"contract"}}"#),
        ]);
        let mut client = DaemonClient::new(stub.base_url.clone());
        client.bootstrap().expect("bootstrap");
        let error = client.post_suppression(&suppression()).expect_err("400 maps to error");
        assert!(matches!(error, ClientError::ContractMismatch(_)));
        stub.handle.join().expect("server thread");
    }

    #[test]
    fn a_dead_daemon_is_a_disconnect_and_a_restarted_one_resumes() {
        let stub = serve(vec![(200, r#"{"token":"session-secret"}"#)]);
        let mut client = DaemonClient::new(stub.base_url.clone());
        client.bootstrap().expect("bootstrap");
        stub.handle.join().expect("server gone");
        let error = client.post_suppression(&suppression()).expect_err("dead server");
        assert!(matches!(error, ClientError::Disconnected(_)));

        // A fresh daemon at a fresh port: bootstrap again, calls resume.
        let revived = serve(vec![
            (200, r#"{"token":"second-secret"}"#),
            (200, r#"{"ok":true}"#),
        ]);
        let mut client = DaemonClient::new(revived.base_url.clone());
        client.bootstrap().expect("re-bootstrap");
        client.post_suppression(&suppression()).expect("resumed");
        let _ = revived.received.recv();
        let (_, authorization) = revived.received.recv().expect("second call");
        assert_eq!(authorization.as_deref(), Some("Bearer second-secret"));
        revived.handle.join().expect("server thread");
    }
}
