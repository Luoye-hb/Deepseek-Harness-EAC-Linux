use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::{Host, Url};

use crate::commands::open_external_url;
use crate::commands::{authorize_bootstrap_or_runtime, authorize_window_origin};
use crate::migration;
use crate::paths;
use crate::process::host::HostManager;
use crate::state::AppState;

const FLOAT_MAX: usize = 8;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowKind {
    Main,
    Float,
    Wizard,
    Update,
    Recovery,
    About,
}

#[derive(Clone, Debug, Deserialize)]
pub struct WindowOpenRequest {
    pub kind: WindowKind,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WindowDescriptor {
    pub kind: String,
    pub label: String,
    pub session_id: Option<String>,
    pub visible: bool,
}

#[tauri::command]
pub fn desktop_window_open(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, AppState>,
    request: WindowOpenRequest,
) -> Result<WindowDescriptor, String> {
    authorize_bootstrap_or_runtime(&caller, &state)?;
    let (kind, label, session_id) = window_identity(&request)?;
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(descriptor(&existing, kind, label, session_id));
    }
    if matches!(request.kind, WindowKind::Float) {
        let count = app
            .webview_windows()
            .keys()
            .filter(|label| label.starts_with("float-"))
            .count();
        if count >= FLOAT_MAX {
            return Err(format!("maximum of {FLOAT_MAX} float windows reached"));
        }
    }
    let host_url = state
        .host
        .lock()
        .map_err(|_| "desktop-host state lock poisoned".to_owned())?
        .status()
        .url;
    let window = build_window(
        &app,
        &label,
        local_page(&request.kind),
        window_title(&request.kind),
        window_size(&request.kind),
        host_url.as_deref(),
        state.host.clone(),
    )?;
    if matches!(request.kind, WindowKind::Wizard) {
        let mode = if request.mode.as_deref() == Some("rerun") {
            "rerun"
        } else {
            "first"
        };
        window
            .eval(format!("window.__DSH_ONBOARD_MODE__={mode:?};"))
            .map_err(|error| format!("failed to set onboarding mode: {error}"))?;
    }
    if matches!(request.kind, WindowKind::Float) {
        if let Some(url) = host_url.as_deref() {
            navigate_to_loopback(&window, url)?;
        }
    }
    window
        .show()
        .map_err(|error| format!("failed to show desktop window: {error}"))?;
    Ok(descriptor(&window, kind, label, session_id))
}

pub fn create_main_window(app: &AppHandle) -> Result<(), String> {
    let window = build_window(
        app,
        "main",
        WebviewUrl::App("loading.html".into()),
        "Deepseek Harness EAC",
        (1280.0, 820.0),
        None,
        app.state::<AppState>().host.clone(),
    )?;
    window
        .show()
        .map_err(|error| format!("failed to show main window: {error}"))
}

pub fn open_startup_wizard(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("wizard") {
        existing.show().map_err(|error| error.to_string())?;
        existing.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = build_window(
        app,
        "wizard",
        WebviewUrl::App("onboarding.html".into()),
        window_title(&WindowKind::Wizard),
        window_size(&WindowKind::Wizard),
        None,
        app.state::<AppState>().host.clone(),
    )?;
    window
        .eval("window.__DSH_ONBOARD_MODE__='first';")
        .map_err(|error| format!("failed to set onboarding mode: {error}"))?;
    window.show().map_err(|error| error.to_string())
}

pub fn open_update_window(app: &AppHandle, kind: &str) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("update") {
        existing.show().map_err(|error| error.to_string())?;
        existing.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = build_window(
        app,
        "update",
        WebviewUrl::App(
            format!(
                "update.html?kind={}",
                if kind == "client" { "client" } else { "agent" }
            )
            .into(),
        ),
        window_title(&WindowKind::Update),
        window_size(&WindowKind::Update),
        None,
        app.state::<AppState>().host.clone(),
    )?;
    window.show().map_err(|error| error.to_string())
}

pub fn open_recovery_window(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("recovery") {
        existing.show().map_err(|error| error.to_string())?;
        existing.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = build_window(
        app,
        "recovery",
        WebviewUrl::App("recovery-center.html".into()),
        window_title(&WindowKind::Recovery),
        window_size(&WindowKind::Recovery),
        None,
        app.state::<AppState>().host.clone(),
    )?;
    window.show().map_err(|error| error.to_string())
}

pub fn open_about_window(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("about") {
        existing.show().map_err(|error| error.to_string())?;
        existing.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = build_window(
        app,
        "about",
        WebviewUrl::App("about.html".into()),
        window_title(&WindowKind::About),
        window_size(&WindowKind::About),
        None,
        app.state::<AppState>().host.clone(),
    )?;
    window.show().map_err(|error| error.to_string())
}

pub fn show_main_window(
    app: &AppHandle,
    caller: &WebviewWindow,
    state: &AppState,
) -> Result<(), String> {
    if !matches!(caller.label(), "main" | "wizard" | "recovery") {
        return Err(
            "only the main, wizard, or recovery window may show the main window".to_owned(),
        );
    }
    authorize_window_origin(caller, state)?;
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window does not exist".to_owned())?;
    let url = state
        .host
        .lock()
        .map_err(|_| "desktop-host state lock poisoned".to_owned())?
        .status()
        .url
        .ok_or_else(|| "dsh web URL is not ready".to_owned())?;
    navigate_to_loopback(&main, &url)?;
    main.show().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_window_close(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, AppState>,
    label: String,
) -> Result<(), String> {
    if caller.label() == "main" {
        authorize_bootstrap_or_runtime(&caller, &state)?;
    } else if caller.label() == label {
        authorize_window_origin(&caller, &state)?;
    } else {
        return Err("desktop window close is not authorized for this window".to_owned());
    }
    if label == "main" {
        return Err("the main window cannot be closed through this command".to_owned());
    }
    let target = app
        .get_webview_window(&label)
        .ok_or_else(|| "desktop window does not exist".to_owned())?;
    target
        .close()
        .map_err(|error| format!("failed to close desktop window: {error}"))
}

#[tauri::command]
pub fn desktop_window_show_main(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    show_main_window(&app, &caller, &state)
}

#[tauri::command]
pub fn desktop_window_list(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<WindowDescriptor>, String> {
    authorize_bootstrap_or_runtime(&caller, &state)?;
    let mut windows = Vec::new();
    for (label, window) in app.webview_windows() {
        let (kind, session_id) = parse_label(&label)?;
        windows.push(descriptor(&window, kind, label, session_id));
    }
    windows.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(windows)
}

fn window_identity(
    request: &WindowOpenRequest,
) -> Result<(String, String, Option<String>), String> {
    let kind = match request.kind {
        WindowKind::Main => "main",
        WindowKind::Float => "float",
        WindowKind::Wizard => "wizard",
        WindowKind::Update => "update",
        WindowKind::Recovery => "recovery",
        WindowKind::About => "about",
    }
    .to_owned();
    let session_id = if matches!(request.kind, WindowKind::Float) {
        let session = request
            .session_id
            .as_deref()
            .ok_or_else(|| "float window requires a session id".to_owned())?;
        validate_session_id(session)?;
        Some(session.to_owned())
    } else {
        None
    };
    let label = match session_id.as_deref() {
        Some(session) => format!("float-{session}"),
        None => kind.clone(),
    };
    Ok((kind, label, session_id))
}

fn parse_label(label: &str) -> Result<(String, Option<String>), String> {
    if label == "main"
        || label == "wizard"
        || label == "update"
        || label == "recovery"
        || label == "about"
    {
        return Ok((label.to_owned(), None));
    }
    if let Some(session) = label.strip_prefix("float-") {
        validate_session_id(session)?;
        return Ok(("float".to_owned(), Some(session.to_owned())));
    }
    Err(format!("unknown desktop window label: {label}"))
}

fn descriptor(
    window: &WebviewWindow,
    kind: String,
    label: String,
    session_id: Option<String>,
) -> WindowDescriptor {
    WindowDescriptor {
        kind,
        label,
        session_id,
        visible: window.is_visible().unwrap_or(false),
    }
}

fn window_title(kind: &WindowKind) -> &'static str {
    match kind {
        WindowKind::Main => "Deepseek Harness EAC",
        WindowKind::Float => "DSH Session",
        WindowKind::Wizard => "Deepseek Harness EAC Setup",
        WindowKind::Update => "Deepseek Harness EAC Update",
        WindowKind::Recovery => "Deepseek Harness EAC Recovery",
        WindowKind::About => "About Deepseek Harness EAC",
    }
}

fn local_page(kind: &WindowKind) -> WebviewUrl {
    match kind {
        WindowKind::Main => WebviewUrl::App("loading.html".into()),
        WindowKind::Float => WebviewUrl::App("loading.html".into()),
        WindowKind::Wizard => WebviewUrl::App("onboarding.html".into()),
        WindowKind::Update => WebviewUrl::App("update.html".into()),
        WindowKind::Recovery => WebviewUrl::App("recovery-center.html".into()),
        WindowKind::About => WebviewUrl::App("about.html".into()),
    }
}

fn window_size(kind: &WindowKind) -> (f64, f64) {
    if matches!(kind, WindowKind::Float) {
        (900.0, 640.0)
    } else if matches!(kind, WindowKind::Wizard) {
        (920.0, 700.0)
    } else if matches!(kind, WindowKind::Recovery) {
        (980.0, 720.0)
    } else if matches!(kind, WindowKind::About) {
        (480.0, 360.0)
    } else {
        (1100.0, 760.0)
    }
}

fn build_window(
    app: &AppHandle,
    label: &str,
    url: WebviewUrl,
    title: &str,
    size: (f64, f64),
    expected_loopback: Option<&str>,
    host: Arc<Mutex<HostManager>>,
) -> Result<WebviewWindow, String> {
    let expected = expected_loopback.map(str::to_owned);
    let user_data_dir = paths::user_data_dir()?;
    let data_directory = webview_data_directory(&user_data_dir, label)?;
    let migration_script = migration::initialization_script(&user_data_dir, label);
    let initialization_script = float_initialization_script(label)
        .map(|float_script| format!("{migration_script}\n{float_script}"))
        .unwrap_or(migration_script);
    WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(480.0, 360.0)
        .visible(false)
        .resizable(true)
        .data_directory(data_directory)
        .initialization_script(initialization_script)
        .on_navigation(move |candidate| {
            let runtime_expected = expected.clone().or_else(|| {
                host.lock()
                    .ok()
                    .and_then(|mut manager| manager.status().url)
            });
            if navigation_allowed(candidate, runtime_expected.as_deref()) {
                return true;
            }
            if is_safe_external(candidate) {
                let _ = open_external_url(candidate.as_str());
            }
            false
        })
        .on_new_window(move |candidate, _features| {
            if is_safe_external(&candidate) {
                let _ = open_external_url(candidate.as_str());
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| format!("failed to create desktop window: {error}"))
}

fn webview_data_directory(user_data_dir: &std::path::Path, label: &str) -> Result<PathBuf, String> {
    let root = user_data_dir.join("webview");
    let directory = if let Some(session_id) = label.strip_prefix("float-") {
        validate_session_id(session_id)?;
        root.join("float").join(session_id)
    } else {
        root.join("main")
    };
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "failed to create WebView data directory {}: {error}",
            directory.display()
        )
    })?;
    #[cfg(unix)]
    fs::set_permissions(
        &directory,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .map_err(|error| format!("failed to secure WebView data directory: {error}"))?;
    Ok(directory)
}

fn float_initialization_script(label: &str) -> Option<String> {
    let session_id = label.strip_prefix("float-")?;
    let encoded = serde_json::to_string(session_id).ok()?;
    Some(format!(
        r#"(()=>{{
const sessionId={encoded};
window.__DSH_FLOAT__={{sessionId}};
try{{
 const key='dsh.sessions.current';
 const raw=localStorage.getItem(key);
 const current=raw?JSON.parse(raw):{{}};
 if(current&&typeof current==='object'){{current.sessionId=sessionId;delete current.subagentAddress;localStorage.setItem(key,JSON.stringify(current));}}
}}catch{{}}
}})();"#
    ))
}

fn navigation_allowed(candidate: &Url, expected_loopback: Option<&str>) -> bool {
    if is_tauri_origin(candidate) {
        return true;
    }
    let Some(expected) = expected_loopback.and_then(|value| Url::parse(value).ok()) else {
        return false;
    };
    candidate.scheme() == "http"
        && candidate.username().is_empty()
        && candidate.password().is_none()
        && is_loopback(candidate)
        && expected.scheme() == "http"
        && expected.username().is_empty()
        && expected.password().is_none()
        && is_loopback(&expected)
        && candidate.origin() == expected.origin()
}

fn is_tauri_origin(url: &Url) -> bool {
    let clean = url.username().is_empty() && url.password().is_none() && url.port().is_none();
    clean
        && ((url.scheme() == "tauri"
            && url
                .host_str()
                .is_some_and(|host| host.eq_ignore_ascii_case("localhost")))
            || (url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|host| host.eq_ignore_ascii_case("tauri.localhost"))))
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn is_safe_external(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn validate_session_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || matches!(value, "." | "..") {
        return Err("session id must be between 1 and 128 bytes".to_owned());
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("session id contains unsupported characters".to_owned());
    }
    Ok(())
}

fn navigate_to_loopback(window: &WebviewWindow, url: &str) -> Result<(), String> {
    let script = format!(
        "window.location.replace({});",
        serde_json::to_string(url).map_err(|error| error.to_string())?
    );
    window
        .eval(&script)
        .map_err(|error| format!("failed to load desktop window URL: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview_data_directories_isolate_float_sessions() {
        let root =
            std::env::temp_dir().join(format!("dsh-tauri-webview-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        let main = webview_data_directory(&root, "main").expect("main data directory");
        let first =
            webview_data_directory(&root, "float-session-one").expect("first float directory");
        let second =
            webview_data_directory(&root, "float-session-two").expect("second float directory");

        assert_eq!(main, root.join("webview").join("main"));
        assert_eq!(first, root.join("webview").join("float/session-one"));
        assert_eq!(second, root.join("webview").join("float/session-two"));
        assert_ne!(first, second);
        assert!(main.is_dir() && first.is_dir() && second.is_dir());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for directory in [&main, &first, &second] {
                assert_eq!(
                    fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                    0o700
                );
            }
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn navigation_requires_exact_internal_or_loopback_origin() {
        assert!(navigation_allowed(
            &Url::parse("tauri://localhost/loading.html").expect("internal URL"),
            None,
        ));
        assert!(navigation_allowed(
            &Url::parse("https://tauri.localhost/loading.html").expect("internal URL"),
            None,
        ));
        assert!(!navigation_allowed(
            &Url::parse("tauri://evil/loading.html").expect("evil URL"),
            None,
        ));
        assert!(navigation_allowed(
            &Url::parse("http://[::1]:43123/path").expect("IPv6 URL"),
            Some("http://[::1]:43123/"),
        ));
        assert!(!navigation_allowed(
            &Url::parse("http://127.0.0.1:43123@evil.example/path").expect("userinfo URL"),
            Some("http://127.0.0.1:43123/"),
        ));
    }

    #[test]
    fn float_data_directory_rejects_path_traversal_session_ids() {
        let root = std::env::temp_dir().join(format!(
            "dsh-tauri-webview-invalid-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);

        for label in ["float-", "float-..", "float-.", "float-a/b"] {
            assert!(webview_data_directory(&root, label).is_err(), "{label}");
        }
        assert!(!root.exists());
    }
}
