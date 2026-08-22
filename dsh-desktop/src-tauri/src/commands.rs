use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;
use url::{Host, Url};

use crate::events;
use crate::migration;
use crate::paths;
use crate::process::host::HostStatus;
use crate::state::AppState;
use crate::windows::open_update_window;

#[derive(Clone, Debug, Serialize)]
pub struct DesktopPing {
    pub shell: &'static str,
    pub pid: u32,
}

#[tauri::command]
pub async fn desktop_ping() -> Result<DesktopPing, String> {
    Ok(DesktopPing {
        shell: "tauri",
        pid: std::process::id(),
    })
}

#[tauri::command]
pub async fn desktop_page_error(
    window: WebviewWindow,
    state: State<'_, AppState>,
    message: String,
) -> Result<Value, String> {
    authorize_renderer_window(&window, &state)?;
    let message = message.chars().take(4096).collect::<String>();
    let host = state.host.clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.lock()
            .map_err(|_| "desktop-host state lock poisoned".to_owned())
            .and_then(|mut manager| {
                manager.call("diagnostic:page-error", json!({ "message": message }))
            })
    })
    .await
    .map_err(|error| format!("desktop page error task failed: {error}"))??;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn desktop_renderer_heartbeat(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    authorize_renderer_window(&window, &state)?;
    if window.label() == "main" {
        state
            .renderer_heartbeat_ms
            .store(unix_time_millis(), std::sync::atomic::Ordering::Relaxed);
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn desktop_recovery_window_close(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if window.label() != "recovery" {
        return Err("recovery window close is not authorized for this window".to_owned());
    }
    authorize_window_origin(&window, &state)?;
    window
        .close()
        .map_err(|error| format!("failed to close recovery window: {error}"))?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn desktop_info(window: WebviewWindow, state: State<'_, AppState>) -> Result<Value, String> {
    authorize_bootstrap_or_runtime(&window, &state)?;
    let menu = host_call(&state, "menu:state", Value::Null).unwrap_or_else(|_| {
        json!({
            "notifyOnTurnEnd": true,
            "closeToTray": true,
            "exitAction": "ask",
            "shortcutPolicy": "auto",
        })
    });
    Ok(json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "desktopShell": "tauri",
        "notifyOnTurnEnd": menu.get("notifyOnTurnEnd").cloned().unwrap_or(json!(true)),
        "closeToTray": menu.get("closeToTray").cloned().unwrap_or(json!(true)),
        "exitAction": menu.get("exitAction").cloned().unwrap_or(json!("ask")),
        "shortcutPolicy": menu.get("shortcutPolicy").cloned().unwrap_or(json!("auto")),
        "repoUrls": {
            "github": "https://github.com/zouyuxuan122/Deepseek-Harness-EAC",
            "gitee": "https://gitee.com/zouyuxuan122/Deepseek-Harness-EAC"
        }
    }))
}

#[tauri::command]
pub fn desktop_about_info(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if window.label() != "about" {
        return Err("about info is only available to the about window".to_owned());
    }
    authorize_window_origin(&window, &state)?;
    let agent = host_call(&state, "update:state", json!({ "kind": "agent" }))
        .ok()
        .and_then(|value| value.get("currentVersion").cloned())
        .unwrap_or(Value::String("unknown".to_owned()));
    Ok(json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "agentVersion": agent,
        "desktopShell": "tauri",
        "repoUrls": {
            "github": "https://github.com/zouyuxuan122/Deepseek-Harness-EAC",
            "gitee": "https://gitee.com/zouyuxuan122/Deepseek-Harness-EAC"
        }
    }))
}

#[tauri::command]
pub fn desktop_migration_complete(
    window: WebviewWindow,
    state: State<'_, AppState>,
    checksum: String,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("webview migration is only available to the main window".to_owned());
    }
    authorize_window_origin(&window, &state)?;
    migration::complete(&paths::user_data_dir()?, &window, &checksum)
}

fn authorize_client_update_window(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
    if window.label() != "update" {
        return Err("client update is only available to the update window".to_owned());
    }
    authorize_window_origin(window, state)
}

fn emit_client_update_state(app: &AppHandle, state: &AppState, snapshot: Value) {
    if let Ok(mut current) = state.client_update_snapshot.lock() {
        *current = snapshot.clone();
    }
    let _ = app.emit("update.state", snapshot);
}

#[tauri::command]
pub fn desktop_client_update_state(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    authorize_client_update_window(&window, &state)?;
    let current = state
        .client_update_snapshot
        .lock()
        .map_err(|_| "client update state lock poisoned".to_owned())?
        .clone();
    if current.is_null() {
        Ok(json!({
            "kind": "client",
            "state": "idle",
            "currentVersion": env!("CARGO_PKG_VERSION")
        }))
    } else {
        Ok(current)
    }
}

#[tauri::command]
pub async fn desktop_client_update_check(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    authorize_client_update_window(&window, &state)?;
    let current_version = env!("CARGO_PKG_VERSION");
    emit_client_update_state(
        &app,
        &state,
        json!({
            "kind": "client",
            "state": "checking",
            "currentVersion": current_version
        }),
    );
    let updater = app
        .updater()
        .map_err(|error| format!("Tauri updater is unavailable: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Tauri updater check failed: {error}"))?;
    let snapshot = if let Some(update) = update {
        let version = update.version.clone();
        state
            .client_update
            .lock()
            .map_err(|_| "client update lock poisoned".to_owned())?
            .replace(update);
        json!({
            "kind": "client",
            "state": "available",
            "currentVersion": current_version,
            "latestVersion": version,
            "message": "发现新的客户端版本"
        })
    } else {
        state
            .client_update
            .lock()
            .map_err(|_| "client update lock poisoned".to_owned())?
            .take();
        json!({
            "kind": "client",
            "state": "current",
            "currentVersion": current_version,
            "message": "当前客户端已是最新版本"
        })
    };
    emit_client_update_state(&app, &state, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
pub async fn desktop_client_update_apply(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    authorize_client_update_window(&window, &state)?;
    let update = state
        .client_update
        .lock()
        .map_err(|_| "client update lock poisoned".to_owned())?
        .clone()
        .ok_or_else(|| "no signed client update is available".to_owned())?;
    let job_id = format!(
        "tauri-client-update-{}",
        state
            .client_update_job
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1
    );
    emit_client_update_state(
        &app,
        &state,
        json!({
            "kind": "client",
            "state": "running",
            "currentVersion": env!("CARGO_PKG_VERSION"),
            "latestVersion": update.version,
            "jobId": job_id
        }),
    );
    let progress_app = app.clone();
    let progress_state = state.inner().clone();
    let progress_job_id = job_id.clone();
    update
        .download_and_install(
            move |received, total| {
                emit_client_update_state(
                    &progress_app,
                    &progress_state,
                    json!({
                        "kind": "client",
                        "state": "running",
                        "currentVersion": env!("CARGO_PKG_VERSION"),
                        "jobId": progress_job_id,
                        "progress": {"received": received, "total": total}
                    }),
                );
            },
            || {},
        )
        .await
        .map_err(|error| format!("Tauri client update failed: {error}"))?;
    emit_client_update_state(
        &app,
        &state,
        json!({
            "kind": "client",
            "state": "ready",
            "currentVersion": env!("CARGO_PKG_VERSION"),
            "jobId": job_id,
            "message": "客户端更新已安装"
        }),
    );
    Ok(json!({ "ok": true, "jobId": job_id }))
}

#[tauri::command]
pub fn desktop_client_update_cancel(
    window: WebviewWindow,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Value, String> {
    authorize_client_update_window(&window, &state)?;
    let _ = job_id;
    Err("Tauri updater cancellation is not supported after download starts".to_owned())
}

#[tauri::command]
pub fn desktop_open_external(
    window: WebviewWindow,
    state: State<'_, AppState>,
    url: String,
) -> Result<Value, String> {
    authorize_bootstrap_or_runtime(&window, &state)?;
    let parsed = Url::parse(&url).map_err(|_| "invalid external URL".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("only credential-free HTTP(S) URLs may be opened externally".to_owned());
    }
    open_external_url(&url)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn desktop_copy_text(
    window: WebviewWindow,
    state: State<'_, AppState>,
    text: String,
) -> Result<Value, String> {
    if window.label() == "about" {
        authorize_window_origin(&window, &state)?;
    } else {
        authorize_bootstrap_or_runtime(&window, &state)?;
    }
    if text.is_empty() || text.len() > 2048 {
        return Ok(json!({ "ok": false }));
    }
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("clipboard write failed: {error}"))?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn desktop_window_control(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    action: String,
) -> Result<Value, String> {
    authorize_bootstrap_or_runtime(&window, &state)?;
    match action.as_str() {
        "minimize" => window
            .minimize()
            .map(|_| json!({ "ok": true }))
            .map_err(|error| error.to_string()),
        "toggle-maximize" => {
            let was_maximized = window.is_maximized().map_err(|error| error.to_string())?;
            if was_maximized {
                window.unmaximize().map_err(|error| error.to_string())?;
            } else {
                window.maximize().map_err(|error| error.to_string())?;
            }
            let is_maximized = !was_maximized;
            let _ = app.emit_to(window.label(), "window.maximized", is_maximized);
            Ok(json!({ "ok": true, "isMaximized": is_maximized }))
        }
        "close" => window
            .close()
            .map(|_| json!({ "ok": true }))
            .map_err(|error| error.to_string()),
        "is-maximized" => window
            .is_maximized()
            .map(|value| json!(value))
            .map_err(|error| error.to_string()),
        _ => Err("unsupported window action".to_owned()),
    }
}

#[tauri::command]
pub async fn desktop_menu_action(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    authorize_bootstrap_or_runtime(&window, &state)?;
    let value = payload
        .as_ref()
        .and_then(|payload| payload.get("value"))
        .cloned()
        .unwrap_or(Value::Null);
    match action.as_str() {
        "reload" => {
            window.reload().map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "devtools" => {
            #[cfg(debug_assertions)]
            {
                window.open_devtools();
                Ok(json!({ "ok": true }))
            }
            #[cfg(not(debug_assertions))]
            {
                Err("developer tools are unavailable in release builds".to_owned())
            }
        }
        "fullscreen" => {
            let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
            window
                .set_fullscreen(!fullscreen)
                .map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true, "fullscreen": !fullscreen }))
        }
        "open-browser" => {
            let url = state
                .host
                .lock()
                .map_err(|_| "desktop-host state lock poisoned".to_owned())?
                .status()
                .url
                .ok_or_else(|| "dsh web URL is not ready".to_owned())?;
            open_external_url(&url)?;
            Ok(json!({ "ok": true }))
        }
        "open-logs" => {
            let logs = host_call(&state, "recovery:state", Value::Null)?
                .get("logsDir")
                .and_then(Value::as_str)
                .ok_or_else(|| "desktop-host returned no logs directory".to_owned())?
                .to_owned();
            open_system_path(&logs)?;
            Ok(json!({ "ok": true, "path": logs }))
        }
        "feedback" => {
            open_external_url("https://github.com/zouyuxuan122/Deepseek-Harness-EAC/issues")?;
            Ok(json!({ "ok": true }))
        }
        "open-terminal" => {
            open_terminal(&app)?;
            Ok(json!({ "ok": true }))
        }
        "check-agent-update" | "check-client-update" => {
            open_update_window(
                &app,
                if action == "check-client-update" {
                    "client"
                } else {
                    "agent"
                },
            )?;
            Ok(json!({ "ok": true, "kind": action }))
        }
        "about" => {
            crate::windows::open_about_window(&app)?;
            Ok(json!({ "ok": true }))
        }
        "restart-service" => {
            let status = restart_host(app, state.host.clone()).await?;
            Ok(json!({ "ok": true, "url": status.url }))
        }
        "toggle-notify" | "toggle-close-to-tray" | "set-exit-action" | "toggle-shortcut-policy" => {
            host_call(
                &state,
                "menu:action",
                json!({ "action": action, "value": value }),
            )
        }
        "quit" => {
            app.exit(0);
            Ok(json!({ "ok": true }))
        }
        _ => Ok(json!({
            "ok": false,
            "error": "unsupported",
            "action": action,
        })),
    }
}

#[tauri::command]
pub async fn desktop_recovery_action(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    action: String,
) -> Result<Value, String> {
    authorize_recovery_window(&window, &state)?;
    match action.as_str() {
        "reload" => {
            let result = host_call(&state, "recovery:reload", Value::Null)?;
            if let Some(main) = app.get_webview_window("main") {
                if let Some(url) = result.get("url").and_then(Value::as_str) {
                    navigate_to_url(&main, url)?;
                }
                main.show().map_err(|error| error.to_string())?;
            }
            Ok(result)
        }
        "restart" => {
            stop_host(&state)?;
            let exe = std::env::current_exe().map_err(|error| error.to_string())?;
            std::process::Command::new(exe)
                .args(std::env::args_os().skip(1))
                .spawn()
                .map_err(|error| format!("failed to relaunch application: {error}"))?;
            app.exit(0);
            Ok(json!({ "ok": true }))
        }
        "export-logs" => {
            let result = host_call(&state, "recovery:export-logs", Value::Null)?;
            if let Some(zip_path) = result.get("zipPath").and_then(Value::as_str) {
                if let Some(parent) = std::path::Path::new(zip_path).parent() {
                    open_system_path(&parent.display().to_string())?;
                }
            }
            Ok(result)
        }
        "safe-mode" => {
            stop_host(&state)?;
            let exe = std::env::current_exe().map_err(|error| error.to_string())?;
            std::process::Command::new(exe)
                .args(std::env::args_os().skip(1))
                .env("DSH_DESKTOP_SAFE_MODE", "1")
                .spawn()
                .map_err(|error| format!("failed to relaunch application: {error}"))?;
            app.exit(0);
            Ok(json!({ "ok": true }))
        }
        _ => Err("unsupported recovery action".to_owned()),
    }
}

#[tauri::command]
pub async fn desktop_host_call(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    authorize_host_call_window(&window, &state, &method)?;
    if !matches!(
        method.as_str(),
        "balance:refresh"
            | "balance:prices:get"
            | "balance:prices:set"
            | "balance:prices:reset"
            | "plugin:list"
            | "plugin:set-enabled"
            | "plugin:set-removed"
            | "plugin:updates"
            | "plugin:update"
            | "plugin:auto-update"
            | "guard:action"
            | "recovery:state"
            | "recovery:reload"
            | "recovery:export-logs"
            | "recovery:action"
            | "onboard:needs"
            | "onboard:list"
            | "onboard:submit"
            | "image-paste:save"
            | "file:revert"
            | "file:validate-open"
            | "menu:state"
            | "menu:action"
            | "update:state"
            | "update:check"
            | "update:apply"
            | "update:cancel"
    ) {
        return Err("desktop-host method is not allowed by the Tauri boundary".to_owned());
    }
    let host = state.host.clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.lock()
            .map_err(|_| "desktop-host state lock poisoned".to_owned())
            .and_then(|mut manager| {
                manager.call_with_notify(
                    &method,
                    params.unwrap_or(Value::Null),
                    |event, payload| {
                        let _ = app.emit(event, payload.clone());
                    },
                )
            })
    })
    .await
    .map_err(|error| format!("desktop-host business call task failed: {error}"))?
}

fn host_call(state: &AppState, method: &str, params: Value) -> Result<Value, String> {
    state
        .host
        .lock()
        .map_err(|_| "desktop-host state lock poisoned".to_owned())?
        .call(method, params)
}

fn stop_host(state: &AppState) -> Result<(), String> {
    state
        .host
        .lock()
        .map_err(|_| "desktop-host state lock poisoned".to_owned())?
        .stop()
}

async fn restart_host(
    app: AppHandle,
    host: std::sync::Arc<std::sync::Mutex<crate::process::host::HostManager>>,
) -> Result<HostStatus, String> {
    let stop_host = host.clone();
    tauri::async_runtime::spawn_blocking(move || {
        stop_host
            .lock()
            .map_err(|_| "desktop-host state lock poisoned".to_owned())
            .and_then(|mut manager| manager.stop())
    })
    .await
    .map_err(|error| format!("desktop-host restart stop task failed: {error}"))??;
    start_host(app, host).await
}

pub(crate) fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    return Err("external URL opening is unsupported on this platform".to_owned());
    #[cfg(target_os = "linux")]
    command.arg(url);
    command
        .spawn()
        .map_err(|error| format!("failed to open external URL: {error}"))?;
    Ok(())
}

fn open_system_path(path: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    return Err("path opening is unsupported on this platform".to_owned());
    command
        .arg(path)
        .spawn()
        .map_err(|error| format!("failed to open path: {error}"))?;
    Ok(())
}

fn open_terminal(app: &AppHandle) -> Result<(), String> {
    let home = home_directory();
    let cwd = std::env::var_os("DSH_DESKTOP_CWD")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| home.clone());
    let mut path = std::env::var_os("PATH").unwrap_or_default();
    if let Ok(resource_dir) = app.path().resource_dir() {
        let node_dir = resource_dir.join("node");
        let npm_dir = resource_dir.join("npm").join("bin");
        let bundled_node_dir = resource_dir.join("vendor").join("node");
        let bundled_npm_dir = resource_dir.join("vendor").join("npm").join("bin");
        let mut entries = vec![node_dir, npm_dir, bundled_node_dir, bundled_npm_dir];
        if let Ok(existing) = std::env::current_dir() {
            entries.push(existing.join("vendor").join("node"));
            entries.push(existing.join("vendor").join("npm").join("bin"));
        }
        for entry in entries.into_iter().rev() {
            if entry.is_dir() {
                let mut value = entry.into_os_string();
                value.push(if cfg!(target_os = "windows") {
                    ";"
                } else {
                    ":"
                });
                value.push(&path);
                path = value;
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for program in ["x-terminal-emulator", "gnome-terminal", "konsole"] {
            if std::process::Command::new(program)
                .current_dir(&cwd)
                .env("PATH", &path)
                .env("DSH_DESKTOP_CWD", &cwd)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("no supported terminal emulator was found".to_owned())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/K"])
            .current_dir(&cwd)
            .env("PATH", &path)
            .env("DSH_DESKTOP_CWD", &cwd)
            .spawn()
            .map_err(|error| format!("failed to open terminal: {error}"))?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    Err("terminal opening is unsupported on this platform".to_owned())
}

fn home_directory() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    let key = "USERPROFILE";
    #[cfg(not(target_os = "windows"))]
    let key = "HOME";
    std::env::var_os(key)
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn navigate_to_url(window: &WebviewWindow, url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|error| error.to_string())?;
    if parsed.scheme() != "http"
        || !is_loopback_url(&parsed)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("recovery navigation target is not loopback HTTP".to_owned());
    }
    let script = format!(
        "window.location.replace({});",
        serde_json::to_string(url).map_err(|error| error.to_string())?
    );
    window.eval(&script).map_err(|error| error.to_string())
}

fn is_loopback_url(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[tauri::command]
pub async fn desktop_open_path(
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
) -> Result<Value, String> {
    authorize_bootstrap_or_runtime(&window, &state)?;
    let host = state.host.clone();
    let validated = tauri::async_runtime::spawn_blocking(move || {
        host.lock()
            .map_err(|_| "desktop-host state lock poisoned".to_owned())
            .and_then(|mut manager| manager.call("file:validate-open", json!({ "path": path })))
    })
    .await
    .map_err(|error| format!("desktop-host file validation task failed: {error}"))??;
    if validated.get("ok").and_then(Value::as_bool) != Some(true) {
        return Ok(validated);
    }
    let validated_path = validated
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "desktop-host returned no validated path".to_owned())?;
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    return Err("path opening is unsupported on this platform".to_owned());
    command
        .arg(validated_path)
        .spawn()
        .map_err(|error| format!("failed to open path: {error}"))?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn desktop_host_status(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<HostStatus, String> {
    authorize_bootstrap_or_runtime(&window, &state)?;
    let host = state.host.clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.lock()
            .map_err(|_| "desktop-host state lock poisoned".to_owned())
            .map(|mut manager| manager.status())
    })
    .await
    .map_err(|error| format!("desktop-host status task failed: {error}"))?
}

#[tauri::command]
pub async fn desktop_host_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<HostStatus, String> {
    authorize_bootstrap_or_runtime(&window, &state)?;
    start_host(app, state.host.clone()).await
}

#[tauri::command]
pub async fn desktop_host_stop(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    authorize_bootstrap_or_runtime(&window, &state)?;
    let host = state.host.clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.lock()
            .map_err(|_| "desktop-host state lock poisoned".to_owned())
            .and_then(|mut manager| manager.stop())
    })
    .await
    .map_err(|error| format!("desktop-host stop task failed: {error}"))?
}

fn authorize_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("desktop-host command is only available to the main window".to_owned())
    }
}

fn authorize_recovery_window(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
    if !matches!(window.label(), "main" | "recovery") {
        return Err("recovery action is not authorized for this window".to_owned());
    }
    authorize_window_origin(window, state)
}

fn authorize_host_call_window(
    window: &WebviewWindow,
    state: &AppState,
    method: &str,
) -> Result<(), String> {
    if window.label() == "wizard" {
        if !matches!(
            method,
            "onboard:needs" | "onboard:list" | "onboard:submit" | "onboard:close"
        ) {
            return Err("wizard window cannot call this desktop-host method".to_owned());
        }
    } else if window.label() == "recovery" {
        if !matches!(
            method,
            "recovery:action" | "recovery:reload" | "recovery:state" | "recovery:export-logs"
        ) {
            return Err("recovery window cannot call this desktop-host method".to_owned());
        }
    } else if window.label() == "update" {
        if !matches!(
            method,
            "update:state" | "update:check" | "update:apply" | "update:cancel"
        ) {
            return Err("update window cannot call this desktop-host method".to_owned());
        }
    } else if window.label() != "main" && !window.label().starts_with("float-") {
        return Err("desktop-host method is not authorized for this window".to_owned());
    }
    authorize_window_origin(window, state)
}

fn authorize_renderer_window(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
    if !matches!(
        window.label(),
        "main" | "wizard" | "update" | "recovery" | "about"
    ) && !window.label().starts_with("float-")
    {
        return Err("renderer event is not authorized for this window".to_owned());
    }
    authorize_window_origin(window, state)
}

pub(crate) fn authorize_bootstrap_or_runtime(
    window: &WebviewWindow,
    state: &AppState,
) -> Result<(), String> {
    authorize_main_window(window)?;
    authorize_window_origin(window, state)
}

pub(crate) fn authorize_window_origin(
    window: &WebviewWindow,
    state: &AppState,
) -> Result<(), String> {
    let current = window
        .url()
        .map_err(|error| format!("cannot determine current window URL: {error}"))?;
    if is_tauri_app_origin(&current) {
        return Ok(());
    }
    let Some(expected) = state
        .host
        .lock()
        .map_err(|_| "desktop-host state lock poisoned".to_owned())?
        .status()
        .url
    else {
        return Err("desktop-host origin is not ready".to_owned());
    };
    let expected = Url::parse(&expected).map_err(|error| error.to_string())?;
    if current.origin() == expected.origin() {
        Ok(())
    } else {
        Err("window origin is not authorized for this command".to_owned())
    }
}

fn is_tauri_app_origin(url: &Url) -> bool {
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

pub fn spawn_host_boot(app: AppHandle) {
    let state = app.state::<AppState>().host.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = start_host(app.clone(), state).await {
            events::emit_error(&app, &error);
        }
    });
}

async fn start_host(
    app: AppHandle,
    host: std::sync::Arc<std::sync::Mutex<crate::process::host::HostManager>>,
) -> Result<HostStatus, String> {
    events::emit_state(&app, "starting", None, None);
    let resource_dir = app.path().resource_dir().ok();
    let user_data_dir = Some(paths::user_data_dir()?);
    let result = tauri::async_runtime::spawn_blocking(move || {
        host.lock()
            .map_err(|_| "desktop-host state lock poisoned".to_owned())
            .and_then(|mut manager| {
                manager.start(resource_dir.as_deref(), user_data_dir.as_deref())
            })
    })
    .await
    .map_err(|error| format!("desktop-host start task failed: {error}"))?;
    match result {
        Ok(status) => {
            if let Some(url) = status.url.as_deref() {
                events::emit_ready(&app, url);
                events::emit_state(&app, "running", Some(url), None);
                let onboarding_needed = host_needs_onboarding(&app);
                if let Some(window) = app.get_webview_window("main") {
                    let script = format!(
                        "window.location.replace({});",
                        serde_json::to_string(url).map_err(|error| error.to_string())?
                    );
                    window
                        .eval(&script)
                        .map_err(|error| format!("failed to load DSH URL: {error}"))?;
                    if onboarding_needed {
                        crate::windows::open_startup_wizard(&app)?;
                    } else {
                        let _ = window.show();
                    }
                }
            }
            Ok(status)
        }
        Err(error) => {
            events::emit_state(&app, "failed", None, Some(&error));
            let _ = crate::windows::open_recovery_window(&app);
            Err(error)
        }
    }
}

fn host_needs_onboarding(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .host
        .lock()
        .ok()
        .and_then(|mut manager| manager.call("onboard:needs", Value::Null).ok())
        .and_then(|value| value.get("needed").and_then(Value::as_bool))
        .unwrap_or(false)
}

#[allow(dead_code)]
fn _resource_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    app.path()
        .resolve(relative, tauri::path::BaseDirectory::Resource)
        .map_err(|error| error.to_string())
}
