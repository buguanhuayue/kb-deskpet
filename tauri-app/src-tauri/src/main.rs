#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod update;
mod upload;

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
fn move_window(app: AppHandle, window_label: Option<String>, dx: f64, dy: f64) -> Result<(), String> {
    let label = window_label.unwrap_or_else(|| "pet".to_string());
    if let Some(win) = app.get_webview_window(&label) {
        // JS 传来的 dx/dy 来自 screenX/screenY 增量，单位是 CSS 像素（逻辑像素）；
        // 而 outer_position / set_position 走的是物理像素。Retina 或 125%/150% 缩放下
        // 不乘 scale_factor，窗口只会移动一半/三分之二的距离——就是「拖不动、不跟手」。
        let scale = win.scale_factor().unwrap_or(1.0);
        if let Ok(pos) = win.outer_position() {
            let _ = win.set_position(PhysicalPosition::new(
                pos.x + (dx * scale).round() as i32,
                pos.y + (dy * scale).round() as i32,
            ));
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

/// 把前端事件广播给**其它**窗口。
/// origin 是发送方窗口 label：app.emit 会连发送方一起投递，前端再监听同一事件就会处理两遍
/// （现象：流式回答每个分片拼两次、上传进度重复刷新）。带上 origin 就用 emit_filter 跳过它。
#[tauri::command]
fn emit_event(
    app: AppHandle,
    event: String,
    payload: serde_json::Value,
    origin: Option<String>,
) -> Result<(), String> {
    match origin.filter(|l| !l.is_empty()) {
        Some(from) => app
            .emit_filter(&event, payload, |target| {
                !matches!(target, tauri::EventTarget::WebviewWindow { label } if *label == from)
            })
            .map_err(|e| e.to_string()),
        None => app.emit(&event, payload).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        // 「选文件 / 选文件夹」用系统对话框：webview 的 input[type=file] 拿不到绝对路径
        .plugin(tauri_plugin_dialog::init())
        .manage(upload::UploadState::new())
        .manage(update::UpdateCache::default())
        .invoke_handler(tauri::generate_handler![
            show_panel,
            hide_panel,
            toggle_panel,
            move_window,
            reset_pet_position,
            start_dragging,
            emit_event,
            app_quit,
            upload::upload_enqueue,
            upload::upload_list,
            upload::upload_clear,
            upload::upload_retry,
            upload::upload_set_cfg,
            upload::describe_paths,
            upload::pick_paths,
            update::app_version,
            update::update_check,
            update::update_auto_result,
            update::update_install,
            update::update_restart
        ])
        .setup(|app| {
            if let Some(pet) = app.get_webview_window("pet") {
                // 初次启动将桌宠定位在主屏幕右下角安全可视区（按逻辑像素精确定位，杜绝 Retina/高分屏坐标超界）
                if let Ok(Some(monitor)) = pet.primary_monitor() {
                    let scale = monitor.scale_factor();
                    let size = monitor.size();
                    let logical_w = size.width as f64 / scale;
                    let logical_h = size.height as f64 / scale;
                    // 桌宠窗口已缩到 112×110（形象按 1/3 显示），右下角留白沿用原来的 20 / 60
                    let x = (logical_w - 132.0).max(50.0);
                    let y = (logical_h - 170.0).max(50.0);
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

            // 每次启动自动查一次更新。放在 Rust 而不是前端定时器：面板窗口是隐藏创建
            // 的，隐藏时 WKWebView 会挂起 setTimeout，「启动后 2.5 秒检查」实际要等
            // 用户第一次点开面板才跑，等于没检查。
            update::auto_check_on_startup(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
