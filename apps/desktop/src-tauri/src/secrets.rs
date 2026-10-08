//! Refresh tokens live in the Windows Credential Manager (DPAPI-protected,
//! per user), never in localStorage or plain files.

#[cfg(windows)]
mod imp {
    use windows::{
        Win32::{
            Foundation::ERROR_NOT_FOUND,
            Security::Credentials::{
                CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW,
                CredWriteW,
            },
        },
        core::{HSTRING, PWSTR},
    };

    fn target(key: &str) -> HSTRING {
        HSTRING::from(format!("Nexus/{key}"))
    }

    pub fn set(key: &str, value: &str) -> Result<(), String> {
        let target = target(key);
        let mut blob = value.as_bytes().to_vec();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_ptr() as *mut u16),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        unsafe { CredWriteW(&cred, 0) }.map_err(|e| e.message())
    }

    pub fn get(key: &str) -> Result<Option<String>, String> {
        let target = target(key);
        let mut ptr: *mut CREDENTIALW = std::ptr::null_mut();
        match unsafe { CredReadW(&target, CRED_TYPE_GENERIC, None, &mut ptr) } {
            Ok(()) => {
                let value = unsafe {
                    let cred = &*ptr;
                    let bytes = std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize);
                    let v = String::from_utf8_lossy(bytes).into_owned();
                    CredFree(ptr as *const _);
                    v
                };
                Ok(Some(value))
            }
            Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(None),
            Err(e) => Err(e.message()),
        }
    }

    pub fn delete(key: &str) -> Result<(), String> {
        match unsafe { CredDeleteW(&target(key), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
            Err(e) => Err(e.message()),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err("unsupported platform".into())
    }
    pub fn get(_: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn delete(_: &str) -> Result<(), String> {
        Ok(())
    }
}

fn check_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 200 || key.chars().any(char::is_control) {
        return Err("invalid key".into());
    }
    Ok(())
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    check_key(&key)?;
    imp::get(&key)
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    check_key(&key)?;
    if value.len() > 2048 {
        return Err("value too large".into());
    }
    imp::set(&key, &value)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    check_key(&key)?;
    imp::delete(&key)
}
