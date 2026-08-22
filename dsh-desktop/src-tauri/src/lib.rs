mod commands;
mod events;
mod instance;
mod migration;
mod paths;
mod process;
mod state;
mod windows;

use state::AppState;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[cfg(target_os = "linux")]
use crate::process::host::HostManager;

const TAURI_BRIDGE_SCRIPT: &str = include_str!("../../platform/tauri/dist/bridge.js");

pub fn run() {
    let Some(_instance_guard) = (match instance::SingleInstanceGuard::acquire() {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("Tauri instance guard failed: {error}");
            std::process::exit(1);
        }
    }) else {
        return;
    };

    let app_state = AppState::default();
    install_linux_termination_monitor(app_state.host.clone(), app_state.shutting_down.clone());

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::desktop_host_start,
            commands::desktop_host_status,
            commands::desktop_host_stop,
            commands::desktop_ping,
            commands::desktop_page_error,
            commands::desktop_renderer_heartbeat,
            commands::desktop_recovery_window_close,
            commands::desktop_info,
            commands::desktop_about_info,
            commands::desktop_migration_complete,
            commands::desktop_client_update_state,
            commands::desktop_client_update_check,
            commands::desktop_client_update_apply,
            commands::desktop_client_update_cancel,
            commands::desktop_window_control,
            commands::desktop_menu_action,
            commands::desktop_recovery_action,
            commands::desktop_host_call,
            commands::desktop_open_external,
            commands::desktop_copy_text,
            commands::desktop_open_path,
            windows::desktop_window_open,
            windows::desktop_window_close,
            windows::desktop_window_list,
            windows::desktop_window_show_main
        ])
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_page_load(|webview, _payload| {
            let _ = webview.eval(TAURI_BRIDGE_SCRIPT);
        })
        .setup(|app| {
            windows::create_main_window(app.handle()).map_err(std::io::Error::other)?;
            commands::spawn_host_boot(app.handle().clone());
            let monitor_app = app.handle().clone();
            std::thread::spawn(move || {
                let mut observed_running = false;
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    if monitor_app
                        .state::<AppState>()
                        .shutting_down
                        .load(Ordering::Relaxed)
                    {
                        break;
                    }
                    let status = monitor_app
                        .state::<AppState>()
                        .host
                        .lock()
                        .ok()
                        .map(|mut host| host.status());
                    let Some(status) = status else { break };
                    if status.running {
                        observed_running = true;
                        let heartbeat = monitor_app
                            .state::<AppState>()
                            .renderer_heartbeat_ms
                            .load(Ordering::Relaxed);
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let visible = monitor_app
                            .get_webview_window("main")
                            .and_then(|window| window.is_visible().ok())
                            .unwrap_or(false);
                        if visible && heartbeat != 0 && now.saturating_sub(heartbeat) > 15_000 {
                            events::emit_state(
                                &monitor_app,
                                "failed",
                                status.url.as_deref(),
                                Some("renderer heartbeat timed out"),
                            );
                            let _ = windows::open_recovery_window(&monitor_app);
                            break;
                        }
                        continue;
                    }
                    if observed_running {
                        events::emit_state(
                            &monitor_app,
                            "failed",
                            None,
                            Some("desktop-host exited"),
                        );
                        let _ = windows::open_recovery_window(&monitor_app);
                    }
                    break;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                app.state::<AppState>()
                    .shutting_down
                    .store(true, Ordering::Relaxed);
                if let Ok(mut host) = app.state::<AppState>().host.lock() {
                    let _ = host.stop();
                }
            }
        })
}

#[cfg(target_os = "linux")]
fn install_linux_termination_monitor(
    host: Arc<Mutex<HostManager>>,
    shutting_down: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::{AtomicBool, Ordering};

    static TERMINATION_REQUESTED: AtomicBool = AtomicBool::new(false);

    unsafe extern "C" fn request_termination(_signal: libc::c_int) {
        TERMINATION_REQUESTED.store(true, Ordering::SeqCst);
    }

    unsafe {
        let handler = request_termination as *const () as libc::sighandler_t;
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }

    std::thread::spawn(move || {
        while !TERMINATION_REQUESTED.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(25));
        }
        shutting_down.store(true, Ordering::Relaxed);
        match host.lock() {
            Ok(mut manager) => {
                let _ = manager.stop();
            }
            Err(poisoned) => {
                let mut manager = poisoned.into_inner();
                let _ = manager.stop();
            }
        }
        std::process::exit(0);
    });
}

#[cfg(not(target_os = "linux"))]
fn install_linux_termination_monitor(
    _host: Arc<Mutex<process::host::HostManager>>,
    _shutting_down: Arc<std::sync::atomic::AtomicBool>,
) {
}
