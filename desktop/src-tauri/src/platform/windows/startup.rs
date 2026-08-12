//! Sign-in startup registration (spec §6): an explicit setting reconciled to one HKCU Run
//! value. No silent registration; disabling the setting removes the value.

use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
};

pub const RUN_VALUE_NAME: &str = "SiftKitAssistant";
const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// The registry surface the reconciler needs; tests use a fake map.
pub trait RunKeyRegistry {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&mut self, name: &str, command: &str) -> Result<(), String>;
    fn delete(&mut self, name: &str) -> Result<(), String>;
}

/// Reconciles the Run registration to the setting. Idempotent: a matching state writes nothing.
pub fn reconcile_startup(
    registry: &mut dyn RunKeyRegistry,
    enabled: bool,
    executable: &str,
) -> Result<(), String> {
    let current = registry.get(RUN_VALUE_NAME)?;
    match (enabled, current) {
        (true, Some(existing)) if existing == executable => Ok(()),
        (true, _) => registry.set(RUN_VALUE_NAME, executable),
        (false, Some(_)) => registry.delete(RUN_VALUE_NAME),
        (false, None) => Ok(()),
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct WindowsRunKeyRegistry;

impl WindowsRunKeyRegistry {
    fn open(&self, access: windows::Win32::System::Registry::REG_SAM_FLAGS) -> Result<HKEY, String> {
        let mut key = HKEY::default();
        let path = wide(RUN_KEY_PATH);
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(path.as_ptr()),
                None,
                None,
                REG_OPTION_NON_VOLATILE,
                access,
                None,
                &mut key,
                None,
            )
        };
        if status.is_err() {
            return Err(format!("opening the Run key failed: {status:?}"));
        }
        Ok(key)
    }
}

impl RunKeyRegistry for WindowsRunKeyRegistry {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        let key = self.open(KEY_QUERY_VALUE)?;
        let value_name = wide(name);
        let mut size = 0u32;
        let probe = unsafe {
            RegQueryValueExW(key, PCWSTR(value_name.as_ptr()), None, None, None, Some(&mut size))
        };
        if probe == windows::Win32::Foundation::WIN32_ERROR(ERROR_FILE_NOT_FOUND.0) {
            unsafe { let _ = RegCloseKey(key); };
            return Ok(None);
        }
        if probe.is_err() {
            unsafe { let _ = RegCloseKey(key); };
            return Err(format!("querying the Run value failed: {probe:?}"));
        }
        let mut buffer = vec![0u8; size as usize];
        let read = unsafe {
            RegQueryValueExW(
                key,
                PCWSTR(value_name.as_ptr()),
                None,
                None,
                Some(buffer.as_mut_ptr()),
                Some(&mut size),
            )
        };
        unsafe { let _ = RegCloseKey(key); };
        if read.is_err() {
            return Err(format!("reading the Run value failed: {read:?}"));
        }
        let wide_chars: Vec<u16> = buffer
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|&character| character != 0)
            .collect();
        Ok(Some(String::from_utf16_lossy(&wide_chars)))
    }

    fn set(&mut self, name: &str, command: &str) -> Result<(), String> {
        let key = self.open(KEY_SET_VALUE)?;
        let value_name = wide(name);
        let data = wide(command);
        let bytes = unsafe {
            std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), data.len() * 2)
        };
        let status = unsafe {
            RegSetValueExW(key, PCWSTR(value_name.as_ptr()), None, REG_SZ, Some(bytes))
        };
        unsafe { let _ = RegCloseKey(key); };
        if status.is_err() {
            return Err(format!("writing the Run value failed: {status:?}"));
        }
        Ok(())
    }

    fn delete(&mut self, name: &str) -> Result<(), String> {
        let key = self.open(KEY_SET_VALUE)?;
        let value_name = wide(name);
        let status = unsafe { RegDeleteValueW(key, PCWSTR(value_name.as_ptr())) };
        unsafe { let _ = RegCloseKey(key); };
        if status.is_err() && status != windows::Win32::Foundation::WIN32_ERROR(ERROR_FILE_NOT_FOUND.0) {
            return Err(format!("deleting the Run value failed: {status:?}"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[derive(Default)]
    struct FakeRegistry {
        values: BTreeMap<String, String>,
        writes: u32,
        deletes: u32,
    }

    impl RunKeyRegistry for FakeRegistry {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.values.get(name).cloned())
        }

        fn set(&mut self, name: &str, command: &str) -> Result<(), String> {
            self.writes += 1;
            self.values.insert(name.to_string(), command.to_string());
            Ok(())
        }

        fn delete(&mut self, name: &str) -> Result<(), String> {
            self.deletes += 1;
            self.values.remove(name);
            Ok(())
        }
    }

    const EXE: &str = r#""C:\Program Files\SiftKit Assistant\siftkit-assistant-shell.exe""#;

    #[test]
    fn enabling_writes_the_run_value_with_the_exe_path() {
        let mut registry = FakeRegistry::default();
        reconcile_startup(&mut registry, true, EXE).expect("reconciles");
        assert_eq!(registry.values.get(RUN_VALUE_NAME).map(String::as_str), Some(EXE));
    }

    #[test]
    fn disabling_deletes_the_value() {
        let mut registry = FakeRegistry::default();
        registry.values.insert(RUN_VALUE_NAME.into(), EXE.into());
        reconcile_startup(&mut registry, false, EXE).expect("reconciles");
        assert!(registry.values.is_empty());
    }

    #[test]
    fn reconcile_is_idempotent() {
        let mut registry = FakeRegistry::default();
        reconcile_startup(&mut registry, true, EXE).expect("first");
        reconcile_startup(&mut registry, true, EXE).expect("second");
        assert_eq!(registry.writes, 1, "a matching registration writes nothing");

        reconcile_startup(&mut registry, false, EXE).expect("disable");
        reconcile_startup(&mut registry, false, EXE).expect("disable again");
        assert_eq!(registry.deletes, 1);
    }

    #[test]
    fn never_registers_while_the_setting_is_off() {
        let mut registry = FakeRegistry::default();
        reconcile_startup(&mut registry, false, EXE).expect("reconciles");
        assert!(registry.values.is_empty());
        assert_eq!(registry.writes, 0);
    }

    #[test]
    fn a_stale_path_is_rewritten() {
        let mut registry = FakeRegistry::default();
        registry.values.insert(RUN_VALUE_NAME.into(), "C:\\old\\shell.exe".into());
        reconcile_startup(&mut registry, true, EXE).expect("reconciles");
        assert_eq!(registry.values.get(RUN_VALUE_NAME).map(String::as_str), Some(EXE));
    }
}
