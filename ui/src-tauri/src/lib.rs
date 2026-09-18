//! Token Horizon desktop shell.
//!
//! Lifecycle contract: the app is a config UI for the persistent loopback
//! daemon. Logging only happens while SOMETHING serves the API port range
//! (:8765-8784), so on launch we spawn the bundled `token-horizon-headless`
//! sidecar DETACHED when the API is dark. The daemon outlives the UI on
//! purpose: closing the window hides to the tray, and Quit exits only the
//! UI — the daemon keeps running. Boot/login persistence is the daemon's
//! own user-scoped service (`--install-service` / Settings toggle); this
//! shell never registers or removes it.

use std::net::TcpStream;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_shell::ShellExt;

/// Daemon port range (mirrors POSIXLoopbackHTTPServer + the UI's discovery).
fn api_ports() -> std::ops::RangeInclusive<u16> {
    8765..=8784
}

/// Something is already accepting connections on the loopback API port range.
/// TCP-connect is enough for the spawn decision; the UI reports real health.
fn api_listening() -> bool {
    api_ports().any(|port| {
        TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(150),
        )
        .is_ok()
    })
}

/// Spawn the bundled `token-horizon-headless` sidecar via Tauri's shell
/// plugin, which resolves the target-triple-suffixed `externalBin` in both
/// dev (`src-tauri/binaries/`) and release bundles. (The previous bare-name
/// lookup next to the executable could never match a bundled sidecar, so
/// release builds silently never started the daemon.)
///
/// The child is deliberately DETACHED: we never store a handle to kill on
/// exit, so Quit/close leaves the daemon running in the background.
fn spawn_sidecar(app: &tauri::AppHandle) {
    let spawn = || -> Result<u32, String> {
        let cmd = app
            .shell()
            .sidecar("token-horizon-headless")
            .map_err(|e| format!("bundled sidecar unavailable: {e}"))?;
        let (mut rx, child) = cmd
            .spawn()
            .map_err(|e| format!("sidecar spawn failed: {e}"))?;
        let pid = child.pid();
        log::info!(
            "spawned token-horizon-headless sidecar (pid {pid}) — detached, survives UI quit"
        );
        // Drain spawn events so failures surface in logs, not silence.
        // Dropping the CommandChild does NOT kill the process; it keeps
        // running detached after this shell exits.
        tauri::async_runtime::spawn(async move {
            use tauri_plugin_shell::process::CommandEvent;
            while let Some(ev) = rx.recv().await {
                match ev {
                    CommandEvent::Error(e) => log::warn!("sidecar error: {e}"),
                    CommandEvent::Terminated(p) => {
                        log::info!("sidecar exited: {p:?}");
                        break;
                    }
                    _ => {}
                }
            }
        });
        Ok(pid)
    };
    match spawn() {
        Ok(_) => {
            // Give the UI a fast healthy backend: wait in the background
            // until the API answers (or time out quietly — the frontend
            // keeps polling and reports real health).
            std::thread::spawn(|| {
                for _ in 0..100 {
                    if api_listening() {
                        log::info!("loopback API is up");
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                log::warn!("sidecar spawned but API still dark after ~20s");
            });
        }
        Err(e) => {
            log::warn!("{e}; run scripts/build-sidecar.sh or start the daemon manually");
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Tray: the app's steady state. Show focuses the window; Quit
            // exits only the UI — the daemon keeps running in the background.
            let show = MenuItem::with_id(app, "show", "Show Token Horizon", true, None::<&str>)?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                "Quit (daemon keeps running)",
                true,
                None::<&str>,
            )?;
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

            // Logging guarantee: spawn the daemon (detached) when nothing
            // serves the API port range.
            if api_listening() {
                log::info!("loopback API already up — no sidecar needed");
            } else {
                spawn_sidecar(app.handle());
            }

            // Launch the config UI at login, default on. The daemon itself
            // persists independently (detached sidecar + its own
            // --install-service user service for boot coverage).
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
        // No Exit handler: the sidecar is detached on purpose, so nothing
        // stops the daemon when this UI quits.
        .run(|_app, _event| {});
}
