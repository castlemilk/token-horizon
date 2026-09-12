//! Token Horizon desktop shell.
//!
//! Lifecycle contract: the app is a tray-resident companion to the loopback
//! daemon. Logging only happens while SOMETHING serves :8765, so on launch we
//! spawn the bundled `token-horizon-headless` sidecar when the API is dark.
//! Closing the window hides to the tray (logging continues); Quit exits and
//! stops the sidecar only if this process started it. Autostart launches the
//! app with `--minimized`, which keeps the window hidden in the tray.

use std::net::TcpStream;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

/// The sidecar we spawned (empty when the API was already up or spawn failed).
struct Sidecar(Mutex<Option<Child>>);

/// Something is already accepting connections on the loopback API port.
/// TCP-connect is enough for the spawn decision; the UI reports real health.
fn api_listening() -> bool {
    TcpStream::connect_timeout(&"127.0.0.1:8765".parse().unwrap(), Duration::from_millis(300)).is_ok()
}

/// Path to the sidecar binary bundled via `bundle.externalBin` (placed next
/// to the app executable; target-triple suffix is resolved by Tauri at build).
fn sidecar_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        "token-horizon-headless.exe"
    } else {
        "token-horizon-headless"
    };
    let p = dir.join(name);
    p.exists().then_some(p)
}

fn spawn_sidecar() -> Option<Child> {
    let path = sidecar_path()?;
    match std::process::Command::new(path).spawn() {
        Ok(child) => {
            log::info!("spawned token-horizon-headless sidecar (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            log::warn!("failed to spawn sidecar: {e}");
            None
        }
    }
}

fn stop_sidecar(app: &tauri::AppHandle) {
    if let Some(sidecar) = app.try_state::<Sidecar>() {
        if let Ok(mut guard) = sidecar.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
                log::info!("stopped sidecar");
            }
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--minimized"])
                .build(),
        )
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Tray: the app's steady state. Show focuses the window; Quit
            // exits (and stops a sidecar we started).
            let show = MenuItem::with_id(app, "show", "Show Token Horizon", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Token Horizon", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Token Horizon")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Logging guarantee: spawn the daemon when nothing serves :8765.
            if api_listening() {
                log::info!("loopback API already up — no sidecar needed");
            } else {
                let child = spawn_sidecar();
                *app.state::<Sidecar>().0.lock().unwrap() = child;
            }

            // Launch at login, default on (tray-resident background logger).
            let autostart = app.autolaunch();
            if !autostart.is_enabled().unwrap_or(false) {
                if let Err(e) = autostart.enable() {
                    log::warn!("could not enable autostart: {e}");
                }
            }

            // Autostart passes --minimized: boot into the tray, no window.
            if !std::env::args().any(|a| a == "--minimized") {
                show_main_window(app.handle());
            }
            Ok(())
        })
        // Close button hides to the tray; logging continues in background.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_sidecar(app);
            }
        });
}
