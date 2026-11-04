#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

static IS_ALIGNING: AtomicBool = AtomicBool::new(false);

fn align_panel_to_pet(pet: &WebviewWindow, panel: &WebviewWindow, pet_pos: PhysicalPosition<i32>) {
    if IS_ALIGNING.swap(true, Ordering::SeqCst) {
        return;
    }

    if let (Ok(pet_size), Ok(panel_size)) = (pet.outer_size(), panel.outer_size()) {
        let mut min_x = 0;
        let mut max_x = 1920;
        let mut min_y = 0;
        let mut max_y = 1080;

        if let Ok(monitors) = pet.available_monitors() {
            for m in monitors {
                let m_pos = m.position();
                let m_size = m.size();
                if pet_pos.x >= m_pos.x - 150
                    && pet_pos.x < m_pos.x + m_size.width as i32 + 150
                    && pet_pos.y >= m_pos.y - 150
                    && pet_pos.y < m_pos.y + m_size.height as i32 + 150
                {
                    min_x = m_pos.x;
                    max_x = m_pos.x + m_size.width as i32;
                    min_y = m_pos.y;
                    max_y = m_pos.y + m_size.height as i32;
                    break;
                }
            }
        }

        let w = panel_size.width as i32;
        let h = panel_size.height as i32;
        let pw = pet_size.width as i32;
        let ph = pet_size.height as i32;

        let mut x = pet_pos.x + pw - w;
        let mut y = pet_pos.y - h - 10;
        if y < min_y + 10 {
            y = pet_pos.y + ph + 10;
        }
        if y + h > max_y - 10 {
            y = max_y - h - 10;
        }
        if x < min_x + 10 {
            x = min_x + 10;
        }
        if x + w > max_x - 10 {
            x = max_x - w - 10;
        }

        let _ = panel.set_position(PhysicalPosition::new(x, y));
    }

    IS_ALIGNING.store(false, Ordering::SeqCst);
}

fn align_pet_to_panel(panel: &WebviewWindow, pet: &WebviewWindow, panel_pos: PhysicalPosition<i32>) {
    if IS_ALIGNING.swap(true, Ordering::SeqCst) {
        return;
    }

    if let (Ok(pet_size), Ok(panel_size)) = (pet.outer_size(), panel.outer_size()) {
        let w = panel_size.width as i32;
        let h = panel_size.height as i32;
        let pw = pet_size.width as i32;

        let pet_x = panel_pos.x + w - pw;
        let pet_y = panel_pos.y + h + 10;

        let _ = pet.set_position(PhysicalPosition::new(pet_x, pet_y));
    }

    IS_ALIGNING.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn show_panel(app: AppHandle) -> Result<(), String> {
    if let (Some(pet), Some(panel)) = (app.get_webview_window("pet"), app.get_webview_window("panel")) {
        if let Ok(pet_pos) = pet.outer_position() {
            align_panel_to_pet(&pet, &panel, pet_pos);
        }
        let _ = panel.show();
        let _ = panel.set_focus();
        let _ = panel.emit("panel:shown", ());
    }
    Ok(())
}

#[tauri::command]
fn hide_panel(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
    Ok(())
}

#[tauri::command]
fn toggle_panel(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("panel") {
        if panel.is_visible().unwrap_or(false) {
            let _ = panel.hide();
        } else {
            return show_panel(app);
        }
    }
    Ok(())
}

#[tauri::command]
fn start_dragging(app: AppHandle, window_label: Option<String>) -> Result<(), String> {
    let label = window_label.unwrap_or_else(|| "pet".to_string());
    if let Some(win) = app.get_webview_window(&label) {
        win.start_dragging().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn emit_event(app: AppHandle, event: String, payload: serde_json::Value) -> Result<(), String> {
    app.emit(&event, payload).map_err(|e| e.to_string())
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            show_panel,
            hide_panel,
            toggle_panel,
            start_dragging,
            emit_event,
            app_quit
        ])
        .setup(|app| {
            if let Some(pet) = app.get_webview_window("pet") {
                // 初次启动定位在主屏幕右下角
                if let Ok(Some(monitor)) = pet.primary_monitor() {
                    let screen_size = monitor.size();
                    let x = screen_size.width as i32 - 220;
                    let y = screen_size.height as i32 - 240;
                    let _ = pet.set_position(PhysicalPosition::new(x, y));
                }

                // 核心1：实时监听 pet 窗口的移动事件，让 panel 窗口实时吸附跟随！
                let app_handle_for_pet = app.handle().clone();
                let pet_clone = pet.clone();
                pet.on_window_event(move |event| {
                    if let tauri::WindowEvent::Moved(pet_pos) = event {
                        if let Some(panel) = app_handle_for_pet.get_webview_window("panel") {
                            if panel.is_visible().unwrap_or(false) {
                                align_panel_to_pet(&pet_clone, &panel, *pet_pos);
                            }
                        }
                    }
                });
            }

            if let Some(panel) = app.get_webview_window("panel") {
                // 核心2：实时监听 panel 窗口的移动事件，让 pet 桌宠窗口双向吸附跟随！
                let app_handle_for_panel = app.handle().clone();
                let panel_clone = panel.clone();
                panel.on_window_event(move |event| {
                    if let tauri::WindowEvent::Moved(panel_pos) = event {
                        if let Some(pet) = app_handle_for_panel.get_webview_window("pet") {
                            align_pet_to_panel(&panel_clone, &pet, *panel_pos);
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
