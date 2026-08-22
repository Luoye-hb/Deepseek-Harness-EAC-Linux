use std::fs::{self, File, OpenOptions};
use std::path::PathBuf;

use crate::paths;

/// Process-lifetime single-instance guard.
///
/// The operating system owns the lock. A crashed process therefore cannot
/// leave a stale lock that blocks the next launch.
pub struct SingleInstanceGuard {
    #[cfg(unix)]
    file: File,
    #[cfg(target_os = "windows")]
    handle: *mut std::ffi::c_void,
}

impl SingleInstanceGuard {
    pub fn acquire() -> Result<Option<Self>, String> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::OpenOptionsExt;

            let path = lock_path()?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!("failed to create instance-lock directory: {error}")
                })?;
            }
            let file = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .truncate(false)
                .mode(0o600)
                .open(&path)
                .map_err(|error| {
                    format!("failed to open instance lock {}: {error}", path.display())
                })?;
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result == 0 {
                return Ok(Some(Self { file }));
            }
            let error = std::io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN)
            {
                return Ok(None);
            }
            Err(format!(
                "failed to acquire instance lock {}: {error}",
                path.display()
            ))
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;

            #[link(name = "kernel32")]
            extern "system" {
                fn CreateMutexW(
                    attributes: *mut std::ffi::c_void,
                    initial_owner: i32,
                    name: *const u16,
                ) -> *mut std::ffi::c_void;
                fn GetLastError() -> u32;
            }

            const ERROR_ALREADY_EXISTS: u32 = 183;
            let name = std::ffi::OsStr::new("Local\\DeepseekHarnessEAC");
            let wide: Vec<u16> = name.encode_wide().chain(std::iter::once(0)).collect();
            let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 1, wide.as_ptr()) };
            if handle.is_null() {
                return Err(format!(
                    "failed to create Windows instance mutex: {}",
                    std::io::Error::last_os_error()
                ));
            }
            if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                unsafe {
                    CloseHandle(handle);
                }
                return Ok(None);
            }
            return Ok(Some(Self { handle }));
        }

        #[cfg(not(any(unix, target_os = "windows")))]
        {
            Ok(Some(Self {}))
        }
    }
}

#[cfg(unix)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        // flock is released automatically when the descriptor closes.
        let _ = &self.file;
    }
}

#[cfg(target_os = "windows")]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

#[cfg(target_os = "windows")]
extern "system" {
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(unix)]
fn lock_path() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("DSH_DESKTOP_INSTANCE_LOCK") {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return Ok(path);
        }
    }
    Ok(paths::user_data_dir()?.join("desktop-instance.lock"))
}

#[cfg(test)]
mod tests {
    use super::SingleInstanceGuard;

    #[cfg(unix)]
    #[test]
    fn lock_is_exclusive_for_the_process() {
        let path = std::env::temp_dir().join(format!(
            "dsh-tauri-instance-test-{}.lock",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        std::env::set_var("DSH_DESKTOP_INSTANCE_LOCK", &path);
        let first = SingleInstanceGuard::acquire()
            .expect("first lock acquisition should succeed")
            .expect("first process should own the lock");
        assert!(SingleInstanceGuard::acquire()
            .expect("second lock attempt should not error")
            .is_none());
        drop(first);
        assert!(SingleInstanceGuard::acquire()
            .expect("lock should be reusable after drop")
            .is_some());
        std::env::remove_var("DSH_DESKTOP_INSTANCE_LOCK");
        let _ = std::fs::remove_file(path);
    }
}
