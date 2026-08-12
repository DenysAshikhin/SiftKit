//! The shell half of key custody (spec §3). On connect with custody `'file'` the migration
//! runs: status → export → DPAPI write → re-read/unprotect round-trip proof → import; only then
//! does the daemon delete its plaintext key file and flip config. Any failure aborts without a
//! partial state. Steady-state `'desktop'` connects unprotect the blob and re-import.

use zeroize::Zeroize;

use crate::contracts::{KeyCustody, KeyCustodyStatusDto, KeyMaterialDto};
use crate::platform::NativeSecureKeyProvider;

/// The daemon's custody surface as the shell sees it (implemented over the HTTP client).
pub trait CustodyDaemon {
    fn custody_status(&self) -> Result<KeyCustodyStatusDto, String>;
    fn export_keys(&self) -> Result<KeyMaterialDto, String>;
    fn import_keys(&self, material: &KeyMaterialDto) -> Result<KeyCustodyStatusDto, String>;
}

/// Where the DPAPI blob lives (`<runtimeRoot>/.siftkit/assistant-keys.dpapi` in production).
pub trait KeyBlobStore {
    fn read(&self) -> Result<Option<Vec<u8>>, String>;
    fn write(&mut self, blob: &[u8]) -> Result<(), String>;
    fn remove(&mut self) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustodyOutcome {
    /// Migration completed: the daemon now reports `'desktop'`.
    Migrated,
    /// Steady state: the blob was unprotected and re-imported.
    Imported,
}

fn parse_material(bytes: &[u8]) -> Result<KeyMaterialDto, String> {
    serde_json::from_slice(bytes).map_err(|error| format!("key blob is not valid material: {error}"))
}

/// Runs on every daemon connect. Errors surface the tray attention state; capture must stay
/// halted until a later connect succeeds.
pub fn synchronize_custody(
    daemon: &dyn CustodyDaemon,
    secure_keys: &dyn NativeSecureKeyProvider,
    blob_store: &mut dyn KeyBlobStore,
) -> Result<CustodyOutcome, String> {
    let status = daemon.custody_status()?;
    match status.custody {
        KeyCustody::File => migrate(daemon, secure_keys, blob_store),
        KeyCustody::Desktop => steady_state(daemon, secure_keys, blob_store),
    }
}

fn migrate(
    daemon: &dyn CustodyDaemon,
    secure_keys: &dyn NativeSecureKeyProvider,
    blob_store: &mut dyn KeyBlobStore,
) -> Result<CustodyOutcome, String> {
    let material = daemon.export_keys()?;
    let mut plaintext =
        serde_json::to_vec(&material).map_err(|error| format!("serialize material: {error}"))?;
    let result = (|| {
        let protected = secure_keys.protect(&plaintext)?;
        blob_store.write(&protected)?;
        // Round-trip proof: what unprotects from disk must be exactly what was exported.
        let reread = blob_store
            .read()?
            .ok_or_else(|| "DPAPI blob vanished between write and re-read".to_string())?;
        let mut recovered = secure_keys.unprotect(&reread)?;
        let verified = recovered == plaintext;
        recovered.zeroize();
        if !verified {
            return Err("DPAPI round-trip produced different key material".to_string());
        }
        let imported = daemon.import_keys(&material)?;
        if imported.custody != KeyCustody::Desktop {
            return Err(format!(
                "daemon reported custody {:?} after import; expected desktop",
                imported.custody,
            ));
        }
        Ok(CustodyOutcome::Migrated)
    })();
    plaintext.zeroize();
    if result.is_err() {
        // No partial state: a blob without a matching daemon custody flip is deleted so the
        // next connect re-runs the whole migration from the intact file key.
        let _ = blob_store.remove();
    }
    result
}

fn steady_state(
    daemon: &dyn CustodyDaemon,
    secure_keys: &dyn NativeSecureKeyProvider,
    blob_store: &mut dyn KeyBlobStore,
) -> Result<CustodyOutcome, String> {
    let blob = blob_store
        .read()?
        .ok_or_else(|| "custody is desktop but no DPAPI blob exists".to_string())?;
    let mut plaintext = secure_keys.unprotect(&blob)?;
    let material = parse_material(&plaintext);
    plaintext.zeroize();
    daemon.import_keys(&material?)?;
    Ok(CustodyOutcome::Imported)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use super::*;
    use crate::contracts::SchemaV1;

    struct FakeSecureKeys {
        fail_unprotect: bool,
    }

    impl NativeSecureKeyProvider for FakeSecureKeys {
        fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
            let mut blob = b"dpapi:".to_vec();
            blob.extend_from_slice(plaintext);
            Ok(blob)
        }

        fn unprotect(&self, blob: &[u8]) -> Result<Vec<u8>, String> {
            if self.fail_unprotect {
                return Err("unprotect failed".into());
            }
            blob.strip_prefix(b"dpapi:")
                .map(<[u8]>::to_vec)
                .ok_or_else(|| "not a dpapi blob".into())
        }
    }

    #[derive(Default)]
    struct FakeBlobStore {
        blob: Option<Vec<u8>>,
    }

    impl KeyBlobStore for FakeBlobStore {
        fn read(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.blob.clone())
        }

        fn write(&mut self, blob: &[u8]) -> Result<(), String> {
            self.blob = Some(blob.to_vec());
            Ok(())
        }

        fn remove(&mut self) -> Result<(), String> {
            self.blob = None;
            Ok(())
        }
    }

    struct FakeDaemon {
        custody: RefCell<KeyCustody>,
        calls: RefCell<Vec<&'static str>>,
        fail_import: bool,
    }

    impl FakeDaemon {
        fn new(custody: KeyCustody) -> Self {
            Self { custody: RefCell::new(custody), calls: RefCell::new(Vec::new()), fail_import: false }
        }

        fn material() -> KeyMaterialDto {
            KeyMaterialDto {
                schema_version: SchemaV1,
                active_key_id: "akey_001".into(),
                keys: BTreeMap::from([("akey_001".to_string(), "QUJD".to_string())]),
            }
        }
    }

    impl CustodyDaemon for FakeDaemon {
        fn custody_status(&self) -> Result<KeyCustodyStatusDto, String> {
            self.calls.borrow_mut().push("status");
            Ok(KeyCustodyStatusDto {
                schema_version: SchemaV1,
                custody: *self.custody.borrow(),
                imported: false,
                active_key_id: Some("akey_001".into()),
            })
        }

        fn export_keys(&self) -> Result<KeyMaterialDto, String> {
            self.calls.borrow_mut().push("export");
            Ok(Self::material())
        }

        fn import_keys(&self, _material: &KeyMaterialDto) -> Result<KeyCustodyStatusDto, String> {
            self.calls.borrow_mut().push("import");
            if self.fail_import {
                return Err("import rejected".into());
            }
            *self.custody.borrow_mut() = KeyCustody::Desktop;
            Ok(KeyCustodyStatusDto {
                schema_version: SchemaV1,
                custody: KeyCustody::Desktop,
                imported: true,
                active_key_id: Some("akey_001".into()),
            })
        }
    }

    #[test]
    fn migration_runs_the_documented_order_and_lands_on_desktop() {
        let daemon = FakeDaemon::new(KeyCustody::File);
        let keys = FakeSecureKeys { fail_unprotect: false };
        let mut store = FakeBlobStore::default();
        let outcome = synchronize_custody(&daemon, &keys, &mut store).expect("migrates");
        assert_eq!(outcome, CustodyOutcome::Migrated);
        assert_eq!(*daemon.calls.borrow(), vec!["status", "export", "import"]);
        assert!(store.blob.is_some(), "the DPAPI blob persists after migration");
    }

    #[test]
    fn a_failing_step_aborts_without_partial_state() {
        let mut daemon = FakeDaemon::new(KeyCustody::File);
        daemon.fail_import = true;
        let keys = FakeSecureKeys { fail_unprotect: false };
        let mut store = FakeBlobStore::default();
        assert!(synchronize_custody(&daemon, &keys, &mut store).is_err());
        assert_eq!(store.blob, None, "an unimported blob is removed");
        assert_eq!(*daemon.custody.borrow(), KeyCustody::File, "the file key stays authoritative");

        let keys = FakeSecureKeys { fail_unprotect: true };
        let clean = FakeDaemon::new(KeyCustody::File);
        let mut store = FakeBlobStore::default();
        assert!(synchronize_custody(&clean, &keys, &mut store).is_err());
        assert_eq!(store.blob, None);
        assert_eq!(
            *clean.calls.borrow(),
            vec!["status", "export"],
            "import is never attempted after a failed round-trip proof",
        );
    }

    #[test]
    fn steady_state_desktop_custody_unprotects_and_imports() {
        let daemon = FakeDaemon::new(KeyCustody::Desktop);
        let keys = FakeSecureKeys { fail_unprotect: false };
        let mut store = FakeBlobStore::default();
        let plaintext = serde_json::to_vec(&FakeDaemon::material()).expect("serialize");
        store.write(&keys.protect(&plaintext).expect("protect")).expect("write");

        let outcome = synchronize_custody(&daemon, &keys, &mut store).expect("imports");
        assert_eq!(outcome, CustodyOutcome::Imported);
        assert_eq!(*daemon.calls.borrow(), vec!["status", "import"]);
    }

    #[test]
    fn desktop_custody_with_no_blob_is_an_attention_state() {
        let daemon = FakeDaemon::new(KeyCustody::Desktop);
        let keys = FakeSecureKeys { fail_unprotect: false };
        let mut store = FakeBlobStore::default();
        assert!(synchronize_custody(&daemon, &keys, &mut store).is_err());
    }
}
