use std::env;
use std::path::PathBuf;

/// Resolve the user-data directory without depending on Tauri's identifier.
/// This preserves the existing Electron directory names and override semantics.
pub fn user_data_dir() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("DSH_DESKTOP_USERDATA") {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return Ok(path);
        }
    }
    if let Some(value) = env::var_os("PORTABLE_EXECUTABLE_DIR") {
        let path = PathBuf::from(value).join("data");
        return Ok(path);
    }
    #[cfg(target_os = "windows")]
    {
        let root = env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "APPDATA is not available".to_owned())?;
        return Ok(root.join("Deepseek Harness EAC"));
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(root) = env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(root).join("Deepseek Harness EAC"));
        }
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is not available".to_owned())?;
        return Ok(home.join(".config").join("Deepseek Harness EAC"));
    }
    #[allow(unreachable_code)]
    Err("unsupported desktop platform".to_owned())
}
