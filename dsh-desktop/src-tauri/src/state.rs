use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, AtomicU64},
    Arc, Mutex,
};
use tauri_plugin_updater::Update;

use crate::process::host::HostManager;

#[derive(Clone)]
pub struct AppState {
    pub host: Arc<Mutex<HostManager>>,
    pub shutting_down: Arc<AtomicBool>,
    pub client_update: Arc<Mutex<Option<Update>>>,
    pub client_update_snapshot: Arc<Mutex<Value>>,
    pub client_update_job: Arc<AtomicU64>,
    pub renderer_heartbeat_ms: Arc<AtomicU64>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            host: Arc::new(Mutex::new(HostManager::default())),
            shutting_down: Arc::new(AtomicBool::new(false)),
            client_update: Arc::new(Mutex::new(None)),
            client_update_snapshot: Arc::new(Mutex::new(Value::Null)),
            client_update_job: Arc::new(AtomicU64::new(0)),
            renderer_heartbeat_ms: Arc::new(AtomicU64::new(0)),
        }
    }
}
