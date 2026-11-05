// update.rs: 自动更新（检查 → 下载安装 → 重启）
//
// 为什么放在 Rust 侧：tauri-plugin-updater 的签名校验、包替换都在原生层完成，
// 前端只要拿状态和百分比。密钥对由 `tauri signer generate` 生成，公钥写进
// tauri.conf.json，私钥只在 CI 的 TAURI_SIGNING_PRIVATE_KEY 里。
//
// 平台差异（插件自身行为，不是我们实现的）：
//   macOS  : 下载后替换 /Applications 里的 .app，需要前端调 restart 才生效
//   Windows: 调 NSIS 安装器，应用会被强制退出，装完由安装器重新拉起
// 所以前端在 Windows 上要提前提示「应用会退出」，macOS 上要显示「重启并安装」。

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    has_update: bool,
    current: String,
    version: String,
    notes: String,
    date: Option<String>,
    target: String,
}

/// 正在下载/安装时挡住重复点击（下载中再点一次会起第二个下载任务）
static INSTALLING: AtomicBool = AtomicBool::new(false);

fn version_of(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// macOS 只有在可写位置（通常 /Applications）才能原地替换 .app。
/// 从 dmg 里直接双击运行、或者放在只读卷上时，更新会失败在最后一步，
/// 不如提前告诉用户「先拖到应用程序」。
fn installable_here() -> bool {
    if !cfg!(target_os = "macos") {
        return true;
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return true,
    };
    let path = exe.to_string_lossy().to_string();
    // 开发态从 target/debug 跑，路径里没有 .app，直接放过
    if !path.contains(".app/Contents/MacOS/") {
        return true;
    }
    path.starts_with("/Applications/")
}

/// 把插件的错误翻译成人话：默认的英文报错直接甩给用户等于没说
fn explain(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("permission") || e.contains("denied") || e.contains("os error 13") {
        return "没有写入权限：把「知识小助」拖到「应用程序」文件夹后再更新，或联系管理员".into();
    }
    if e.contains("timed out") || e.contains("timeout") || e.contains("dns") {
        return "连接更新服务器超时，检查一下网络（可能是公司网络拦了 github.com）".into();
    }
    if e.contains("signature") || e.contains("verify") {
        return "更新包校验失败，已放弃安装（包可能损坏或被替换）".into();
    }
    if e.contains("404") || e.contains("valid release json") || e.contains("not found") {
        return "更新服务器上还没有可用的版本信息（latest.json 缺失或还没发布）".into();
    }
    if e.contains("could not fetch") || e.contains("failed to fetch") || e.contains("connect") {
        return "连不上更新服务器，检查一下网络（可能是公司网络拦了 github.com）".into();
    }
    format!("更新失败：{err}")
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    version_of(&app)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Value {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return json!({ "ok": false, "error": explain(&e.to_string()), "current": version_of(&app) })
        }
    };

    match updater.check().await {
        Ok(Some(u)) => {
            let info = UpdateInfo {
                has_update: true,
                current: u.current_version.clone(),
                version: u.version.clone(),
                notes: u.body.clone().unwrap_or_default(),
                date: u.date.map(|d| d.to_string()),
                target: u.target.clone(),
            };
            json!({
                "ok": true,
                "info": info,
                "canInstall": installable_here(),
                "canAutoRestart": cfg!(target_os = "macos")
            })
        }
        Ok(None) => json!({
            "ok": true,
            "info": { "hasUpdate": false, "current": version_of(&app) },
            "canInstall": true,
            "canAutoRestart": cfg!(target_os = "macos")
        }),
        Err(e) => json!({ "ok": false, "error": explain(&e.to_string()), "current": version_of(&app) }),
    }
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> Value {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return json!({ "ok": false, "error": "正在更新，请稍候" });
    }
    let result = install_inner(&app).await;
    INSTALLING.store(false, Ordering::SeqCst);
    match result {
        Ok(v) => json!({ "ok": true, "version": v }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

async fn install_inner(app: &AppHandle) -> Result<String, String> {
    let updater = app.updater().map_err(|e| explain(&e.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|e| explain(&e.to_string()))?
        .ok_or_else(|| "已经是最新版本".to_string())?;

    let version = update.version.clone();
    let mut downloaded: u64 = 0;
    let mut total: u64 = 0;
    // 每个 chunk 都 emit 会让 webview 每秒收上千条消息，节流到 ~8 帧/秒足够顺滑
    let mut last = Instant::now() - Duration::from_secs(1);

    update
        .download_and_install(
            |chunk, content_length| {
                downloaded += chunk as u64;
                if let Some(c) = content_length {
                    total = c;
                }
                if last.elapsed() >= Duration::from_millis(120) {
                    last = Instant::now();
                    let _ = app.emit(
                        "update:progress",
                        json!({ "downloaded": downloaded, "total": total }),
                    );
                }
            },
            || {},
        )
        .await
        .map_err(|e| explain(&e.to_string()))?;

    let _ = app.emit(
        "update:progress",
        json!({ "downloaded": downloaded, "total": total, "finished": true }),
    );
    Ok(version)
}

/// 装完重启：macOS/Linux 需要它，Windows 上应用已经被安装器接管，一般走不到这里
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explain_maps_permission_error() {
        let msg = explain("failed to write: Permission denied (os error 13)");
        assert!(msg.contains("写入权限"), "实际：{msg}");
    }

    #[test]
    fn explain_maps_signature_error() {
        let msg = explain("signature verification failed");
        assert!(msg.contains("校验失败"), "实际：{msg}");
    }

    #[test]
    fn explain_maps_missing_manifest() {
        let msg = explain("Could not fetch a valid release JSON from the remote");
        assert!(msg.contains("latest.json"), "实际：{msg}");
        let msg = explain("request failed with status 404");
        assert!(msg.contains("latest.json"), "实际：{msg}");
    }

    #[test]
    fn explain_keeps_unknown_error_visible() {
        let msg = explain("weird failure");
        assert!(msg.starts_with("更新失败：weird failure"), "实际：{msg}");
    }
}
