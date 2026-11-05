#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

#[tauri::command]
fn show_panel(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("panel") {
        let is_vis = panel.is_visible().unwrap_or(false);
        if !is_vis {
            // 如果面板尚未显示，获取主显示器尺寸并计算居中偏右安全坐标
            if let Ok(monitors) = app.available_monitors() {
                if let Some(monitor) = monitors.first() {
                    let screen_size = monitor.size();
                    if let Ok(panel_size) = panel.outer_size() {
                        let w = panel_size.width as i32;
                        let h = panel_size.height as i32;
                        let sw = screen_size.width as i32;
                        let sh = screen_size.height as i32;
                        let x = (sw - w - 240).max(40);
                        let y = ((sh - h) / 2).max(40);
                        let _ = panel.set_position(PhysicalPosition::new(x, y));
                    }
                }
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
            start_dragging,
            emit_event,
            app_quit
        ])
        .setup(|app| {
            if let Some(pet) = app.get_webview_window("pet") {
                // 初次启动将桌宠定位在主屏幕右下角安全可视区（避开任务栏）
                if let Ok(monitors) = app.available_monitors() {
                    if let Some(monitor) = monitors.first() {
                        let screen_size = monitor.size();
                        let x = screen_size.width as i32 - 210;
                        let y = screen_size.height as i32 - 230;
                        let _ = pet.set_position(PhysicalPosition::new(x, y));
                    }
                }
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
