//! Wire contracts mirroring `packages/contracts/src/assistant-desktop.ts` 1:1.
//!
//! Every envelope pins `schemaVersion` to the unit type [`SchemaV1`], which (de)serializes only
//! the number 1 — an unknown contract generation fails closed at the boundary instead of
//! half-parsing (spec §2).

use std::collections::BTreeMap;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Unit struct standing in for `schemaVersion: 1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SchemaV1;

impl Serialize for SchemaV1 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(1)
    }
}

impl<'de> Deserialize<'de> for SchemaV1 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let version = u64::deserialize(deserializer)?;
        if version == 1 {
            Ok(SchemaV1)
        } else {
            Err(D::Error::custom(format!(
                "unsupported schemaVersion {version}; this shell speaks version 1"
            )))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ForegroundContextDto {
    pub process_name: Option<String>,
    pub executable_path: Option<String>,
    pub application_id: Option<String>,
    pub normalized_title: Option<String>,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivityEventDto {
    pub schema_version: SchemaV1,
    pub captured_at_utc: String,
    pub foreground: ForegroundContextDto,
    pub mouse_idle_seconds: u32,
    pub keyboard_idle_seconds: u32,
    pub session_locked: bool,
}

/// The heartbeat cadence both sides derive their timing from (spec §2).
pub const HEARTBEAT_INTERVAL_SECONDS: u64 = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PowerStateDto {
    #[serde(rename_all = "camelCase")]
    Available { on_battery: bool, battery_percent: f64 },
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EnvironmentStateDto {
    pub schema_version: SchemaV1,
    pub captured_at_utc: String,
    pub fullscreen: bool,
    pub locked: bool,
    pub do_not_disturb: bool,
    pub presenting: bool,
    pub excluded_application: bool,
    pub seconds_since_mouse_input: u32,
    pub seconds_since_keyboard_input: u32,
    pub power: PowerStateDto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureReason {
    FixedCadence,
    WindowChange,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CaptureDisplayDto {
    pub id: String,
    pub name: String,
    pub primary: bool,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub logical_width: u32,
    pub logical_height: u32,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CaptureSubmissionDto {
    pub schema_version: SchemaV1,
    pub captured_at_utc: String,
    pub reason: CaptureReason,
    pub display: CaptureDisplayDto,
    pub foreground_context_key: String,
    pub foreground: ForegroundContextDto,
    pub pixel_sha256: String,
    pub perceptual_hash: String,
    pub image_data_url: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SuppressionRuleId {
    PrivateMode,
    SessionLocked,
    SecureDesktop,
    UnknownForeground,
    ProcessDenylist,
    TitleDenyPattern,
    PrivateBrowsing,
    FullscreenSuppression,
    SecretClassification,
    CaptureFailure,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SuppressionAuditDto {
    pub schema_version: SchemaV1,
    pub occurred_at_utc: String,
    pub rule_id: SuppressionRuleId,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeyCustody {
    File,
    Desktop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct KeyCustodyState {
    pub custody: KeyCustody,
    pub imported: bool,
    pub active_key_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct KeyCustodyStatusDto {
    pub schema_version: SchemaV1,
    pub custody: KeyCustody,
    pub imported: bool,
    pub active_key_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct KeyMaterialDto {
    pub schema_version: SchemaV1,
    pub active_key_id: String,
    /// keyId -> base64 key material, 32 bytes once decoded. Ordered map keeps round-trips stable.
    pub keys: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ImageCapabilityDto {
    pub capable: bool,
    pub instance_id: Option<String>,
    pub queue_depth: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PendingQuestionDto {
    pub id: String,
    pub question_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesktopStateDto {
    pub schema_version: SchemaV1,
    pub assistant_enabled: bool,
    pub capture_enabled: bool,
    pub paused: bool,
    pub custody: KeyCustodyState,
    pub image_capability: ImageCapabilityDto,
    pub pending_question: Option<PendingQuestionDto>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> serde_json::Value {
        let path = format!(
            "{}/../contract-fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("missing fixture {path}: {error}"));
        serde_json::from_str(&text).expect("fixture is valid JSON")
    }

    /// JSON `87` and `87.0` are the same number; canonicalize before comparing so the
    /// round-trip check tests the contract, not serde's integer/float choice.
    fn canonical(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Number(number) => serde_json::json!(number.as_f64()),
            serde_json::Value::Array(items) => {
                serde_json::Value::Array(items.iter().map(canonical).collect())
            }
            serde_json::Value::Object(entries) => serde_json::Value::Object(
                entries.iter().map(|(key, entry)| (key.clone(), canonical(entry))).collect(),
            ),
            other => other.clone(),
        }
    }

    fn round_trips<T>(name: &str)
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let value = fixture(name);
        let parsed: T = serde_json::from_value(value.clone())
            .unwrap_or_else(|error| panic!("{name} failed to parse: {error}"));
        let reserialized = serde_json::to_value(&parsed).expect("reserialize");
        assert_eq!(canonical(&reserialized), canonical(&value), "{name} did not round-trip");
    }

    #[test]
    fn golden_fixtures_parse_and_round_trip() {
        round_trips::<ActivityEventDto>("activity-event.json");
        round_trips::<EnvironmentStateDto>("environment-state.json");
        round_trips::<CaptureSubmissionDto>("capture-submission.json");
        round_trips::<SuppressionAuditDto>("suppression-audit.json");
        round_trips::<KeyCustodyStatusDto>("key-custody-status.json");
        round_trips::<KeyMaterialDto>("key-material.json");
        round_trips::<DesktopStateDto>("desktop-state.json");
    }

    #[test]
    fn unknown_schema_version_fails_closed_for_every_envelope() {
        let value = fixture("unknown-version.json");
        assert!(serde_json::from_value::<ActivityEventDto>(value.clone()).is_err());
        assert!(serde_json::from_value::<EnvironmentStateDto>(value.clone()).is_err());
        assert!(serde_json::from_value::<CaptureSubmissionDto>(value.clone()).is_err());
        assert!(serde_json::from_value::<SuppressionAuditDto>(value.clone()).is_err());
        assert!(serde_json::from_value::<KeyCustodyStatusDto>(value.clone()).is_err());
        assert!(serde_json::from_value::<KeyMaterialDto>(value.clone()).is_err());
        assert!(serde_json::from_value::<DesktopStateDto>(value).is_err());
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let mut value = fixture("activity-event.json");
        value
            .as_object_mut()
            .expect("fixture object")
            .insert("surprise".into(), serde_json::json!(true));
        assert!(serde_json::from_value::<ActivityEventDto>(value).is_err());
    }
}
