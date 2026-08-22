use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const HOST_READY_EVENT: &str = "desktop-host.ready";
pub const HOST_STATE_EVENT: &str = "desktop-host.state";
pub const HOST_ERROR_EVENT: &str = "desktop-host.error";

#[derive(Clone, Debug, Serialize)]
pub struct HostReadyEvent {
    pub url: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct HostStateEvent {
    pub state: String,
    pub url: Option<String>,
    pub error: Option<String>,
}

pub fn emit_ready(app: &AppHandle, url: &str) {
    let _ = app.emit(
        HOST_READY_EVENT,
        HostReadyEvent {
            url: url.to_owned(),
        },
    );
}

pub fn emit_state(app: &AppHandle, state: &str, url: Option<&str>, error: Option<&str>) {
    let _ = app.emit(
        HOST_STATE_EVENT,
        HostStateEvent {
            state: state.to_owned(),
            url: url.map(str::to_owned),
            error: error.map(str::to_owned),
        },
    );
}

pub fn emit_error(app: &AppHandle, error: &str) {
    let _ = app.emit(HOST_ERROR_EVENT, error.to_owned());
}
