//! DPAPI custody (spec §3): per-user protection, no UI, blob bytes owned by the caller.

use windows::core::PWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

use crate::platform::NativeSecureKeyProvider;

pub struct DpapiSecureKeyProvider;

fn as_blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).unwrap_or(u32::MAX),
        pbData: bytes.as_ptr().cast_mut(),
    }
}

fn take_output(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let bytes = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe { LocalFree(Some(HLOCAL(output.pbData.cast()))) };
    bytes
}

impl NativeSecureKeyProvider for DpapiSecureKeyProvider {
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let input = as_blob(plaintext);
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                PWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(|error| format!("CryptProtectData failed: {error}"))?;
        Ok(take_output(output))
    }

    fn unprotect(&self, blob: &[u8]) -> Result<Vec<u8>, String> {
        let input = as_blob(blob);
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(|error| format!("CryptUnprotectData failed: {error}"))?;
        Ok(take_output(output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows-only round-trip against the real DPAPI.
    #[test]
    fn protect_unprotect_round_trips() {
        let provider = DpapiSecureKeyProvider;
        let plaintext = br#"{"activeKeyId":"akey_001","keys":{"akey_001":"QUJD"}}"#;
        let blob = provider.protect(plaintext).expect("protect");
        assert_ne!(blob.as_slice(), plaintext.as_slice(), "the blob is not the plaintext");
        let recovered = provider.unprotect(&blob).expect("unprotect");
        assert_eq!(recovered.as_slice(), plaintext.as_slice());
    }

    #[test]
    fn garbage_blobs_fail_closed() {
        let provider = DpapiSecureKeyProvider;
        assert!(provider.unprotect(b"not a dpapi blob").is_err());
    }
}
