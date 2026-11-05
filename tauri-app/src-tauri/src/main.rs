#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition, Position};

#[tauri::command]
fn show_panel(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("panel") {
        let is_vis = panel.is_visible().unwrap_or(false);
        if !is_vis {
            if let Ok(Some(monitor)) = panel.primary_monitor() {
                let scale = monitor.scale_factor();
                let size = monitor.size();
                let logical_w = size.width as f64 / scale;
                let logical_h = size.height as f64 / scale;
                let x = (logical_w - 780.0).max(40.0);
                let y = ((logical_h - 720.0) / 2.0).max(40.0);
                let _ = panel.set_position(Position::Logical(LogicalPosition::new(x, y)));
            } else {
                let _ = panel.center();
            }
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
fn move_window(app: AppHandle, window_label: Option<String>, dx: i32, dy: i32) -> Result<(), String> {
    let label = window_label.unwrap_or_else(|| "pet".to_string());
    if let Some(win) = app.get_webview_window(&label) {
        if let Ok(pos) = win.outer_position() {
            let _ = win.set_position(PhysicalPosition::new(pos.x + dx, pos.y + dy));
        }
    }
    Ok(())
}

#[tauri::command]
fn reset_pet_position(app: AppHandle) -> Result<(), String> {
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = pet.center();
        let _ = pet.show();
        let _ = pet.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn start_dragging(app: AppHandle, window_label: Option<String>) -> Result<(), String> {
    let label = window_label.unwrap_or_else(|| "pet".to_string());
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.start_dragging();
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
            move_window,
            reset_pet_position,
            start_dragging,
            emit_event,
            app_quit
        ])
        .setup(|app| {
            if let Some(pet) = app.get_webview_window("pet") {
                // 初次启动将桌宠定位在主屏幕右下角安全可视区（按逻辑像素精确定位，杜绝 Retina/高分屏坐标超界）
                if let Ok(Some(monitor)) = pet.primary_monitor() {
                    let scale = monitor.scale_factor();
                    let size = monitor.size();
                    let logical_w = size.width as f64 / scale;
                    let logical_h = size.height as f64 / scale;
                    let x = (logical_w - 220.0).max(50.0);
                    let y = (logical_h - 260.0).max(50.0);
                    let _ = pet.set_position(Position::Logical(LogicalPosition::new(x, y)));
                } else {
                    let _ = pet.center();
                }
                let _ = pet.show();
                let _ = pet.set_focus();
                let _ = pet.set_always_on_top(true);
            }

            if let Some(panel) = app.get_webview_window("panel") {
                let _ = panel.set_always_on_top(false);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
