#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

#[tauri::command]
fn show_panel(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("panel") {
        let is_vis = panel.is_visible().unwrap_or(false);
        if !is_vis {
            // 如果面板未显示，且尚未定位，给一个默认舒适位置（在主屏幕中央偏右）
            if let Ok(Some(monitor)) = panel.primary_monitor() {
                let screen_size = monitor.size();
                if let Ok(panel_size) = panel.outer_size() {
                    let w = panel_size.width as i32;
                    let h = panel_size.height as i32;
                    let sw = screen_size.width as i32;
                    let sh = screen_size.height as i32;
                    // 默认靠右侧居中摆放，与右下角宠物完全分离独立
                    let x = (sw - w - 240).max(40);
                    let y = ((sh - h) / 2).max(40);
                    let _ = panel.set_position(PhysicalPosition::new(x, y));
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
                // 初次启动将桌宠定位在主屏幕右下角安全可视区（避开任务栏）
                if let Ok(Some(monitor)) = pet.primary_monitor() {
                    let screen_size = monitor.size();
                    let x = screen_size.width as i32 - 210;
                    let y = screen_size.height as i32 - 230;
                    let _ = pet.set_position(PhysicalPosition::new(x, y));
                }
                let _ = pet.set_always_on_top(true);
            }

            if let Some(panel) = app.get_webview_window("panel") {
                // 窗口与宠物完全独立，面板不强制顶置，不随桌宠拖动而位移，桌宠也绝不随面板位移
                let _ = panel.set_always_on_top(false);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
