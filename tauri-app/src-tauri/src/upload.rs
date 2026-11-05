// upload.rs: 真实文件入库链路（上传 + 解析状态轮询 + 令牌刷新）
//
// 为什么放在 Rust 侧而不是 webview 里：
// 1. 文件字节不需要进 JS 内存，50MB 的文件在 webview 里过一次是纯粹的浪费；
// 2. 队列和状态机必须在「不随窗口隐藏而停摆」的地方 —— 面板被隐藏时 WebKit 会挂起
//    渲染进程的定时器，之前 0/1 卡死就是这个原因；
// 3. 桌宠窗口和面板窗口共享同一份队列，天然不会重复上传。
//
// 与后端的契约（在 192.168.1.234 上逐条实测过）：
//   POST {base}/knowledge-bases/{kb}/knowledge/file   multipart 字段 file
//        headers: Authorization: Bearer <token>, X-Tenant-ID: <tenant>
//        成功: HTTP 200 {"success":true,"data":{"id":"...","parse_status":"pending"}}
//        重复: HTTP 409 {"success":false,"code":"duplicate_file","data":{已有记录}}
//   GET  {base}/knowledge/{id}  → data.parse_status: pending/processing/finalizing/completed/failed
//        实测 md 文件 4 秒内 completed，同时 enable_status 从 disabled 变 enabled
//   POST {base}/auth/refresh  {"refreshToken":"..."}
//        → 扁平结构 {"success":true,"access_token":"...","refresh_token":"..."}
//          （注意不是包在 data 里，键名也不是 camelCase；旧刷新令牌刷新后立刻作废）

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_http::reqwest::{self, multipart, Client};

/// 与服务端 MAX_FILE_SIZE_MB 保持一致，本地先拦一道，省得传完 50MB 才被拒。
const MAX_FILE_MB: u64 = 50;
/// 单次提交最多展开多少个文件（防止误拖整个 home 目录）
const MAX_BATCH: usize = 500;

fn client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(600))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    })
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UploadCfg {
    pub server_url: String,
    pub token: String,
    pub refresh_token: String,
    pub tenant_id: i64,
    pub kb_id: String,
}

impl UploadCfg {
    fn base(&self) -> String {
        format!("{}/api/v1", self.server_url.trim_end_matches('/'))
    }
    fn usable(&self) -> bool {
        !self.server_url.is_empty() && !self.kb_id.is_empty()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadItem {
    pub id: String,
    pub name: String,
    /// 相对路径（文件夹上传时带上子目录，面板拿它当显示名）
    pub rel: String,
    pub path: String,
    pub size: u64,
    /// queued | uploading | parsing | done | exists | failed
    pub status: String,
    pub progress: u32,
    pub knowledge_id: String,
    pub parse_status: String,
    pub parse_elapsed: u64,
    pub error: String,
    pub tenant_id: i64,
}

impl UploadItem {
    fn new(path: String, rel: String, size: u64, tenant_id: i64) -> Self {
        let name = Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        Self {
            id: format!("u_{}", uuid_like()),
            name,
            rel,
            path,
            size,
            status: "queued".into(),
            progress: 0,
            knowledge_id: String::new(),
            parse_status: String::new(),
            parse_elapsed: 0,
            error: String::new(),
            tenant_id,
        }
    }
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let r = (nanos as u64) ^ (std::process::id() as u64).wrapping_mul(2654435761);
    format!("{:x}{:04x}", nanos, (r & 0xffff) as u16)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    total: usize,
    queued: usize,
    running: usize,
    done: usize,
    failed: usize,
    exists: usize,
    uploading: usize,
    parsing: usize,
}

fn stats_of(items: &[UploadItem]) -> Stats {
    let mut s = Stats::default();
    s.total = items.len();
    for it in items {
        match it.status.as_str() {
            "queued" => s.queued += 1,
            "uploading" => {
                s.uploading += 1;
                s.running += 1;
            }
            "parsing" => {
                s.parsing += 1;
                s.running += 1;
            }
            "done" => s.done += 1,
            "exists" => s.exists += 1,
            "failed" => s.failed += 1,
            _ => {}
        }
    }
    s
}

struct Inner {
    cfg: UploadCfg,
    items: Vec<UploadItem>,
}

pub struct UploadState {
    inner: Mutex<Inner>,
    busy: AtomicBool,
}

impl UploadState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                cfg: UploadCfg::default(),
                items: Vec::new(),
            }),
            busy: AtomicBool::new(false),
        }
    }
}

impl Default for UploadState {
    fn default() -> Self {
        Self::new()
    }
}

/// 更新单个条目并广播：`upload:update` 的 payload 形状与前端原有约定完全一致，
/// 所以 panel.js / pet.js 的订阅代码一行都不用改。
fn update_item<F: FnOnce(&mut UploadItem)>(app: &AppHandle, id: &str, f: F) {
    let st = app.state::<UploadState>();
    let (item, stats) = {
        let mut g = st.inner.lock().unwrap();
        if let Some(it) = g.items.iter_mut().find(|i| i.id == id) {
            f(it);
        }
        let item = g.items.iter().find(|i| i.id == id).cloned();
        let stats = stats_of(&g.items);
        (item, stats)
    };
    if let Some(item) = item {
        let _ = app.emit("upload:update", json!({ "item": item, "stats": stats }));
    }
}

fn emit_stats(app: &AppHandle) {
    let st = app.state::<UploadState>();
    let stats = {
        let g = st.inner.lock().unwrap();
        stats_of(&g.items)
    };
    let _ = app.emit("upload:update", json!({ "stats": stats }));
}

fn current_cfg(app: &AppHandle) -> UploadCfg {
    let st = app.state::<UploadState>();
    let g = st.inner.lock().unwrap();
    g.cfg.clone()
}

/* ---------------- 目录展开 ---------------- */

fn collect_files(dir: &Path, base: &Path, out: &mut Vec<(String, String, u64)>, depth: usize) {
    if depth > 8 || out.len() >= MAX_BATCH {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        if out.len() >= MAX_BATCH {
            return;
        }
        let p = entry.path();
        let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        // 隐藏文件（.DS_Store 之类）没有入库价值，跳过
        if name.starts_with('.') {
            continue;
        }
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if md.is_dir() {
            collect_files(&p, base, out, depth + 1);
        } else if md.is_file() {
            // 显示名用「相对路径」，文件夹上传时能看出谁是谁
            let rel = p
                .strip_prefix(base)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_else(|_| name.clone());
            out.push((p.to_string_lossy().to_string(), rel, md.len()));
        }
    }
}

/* ---------------- 令牌 ---------------- */

fn jwt_expired(token: &str) -> bool {
    // 只做「已知过期」判断：解析失败就当没过期，交给 401 兜底。
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    let payload = parts[1].replace('-', "+").replace('_', "/");
    let pad = (4 - payload.len() % 4) % 4;
    let padded = format!("{}{}", payload, "=".repeat(pad));
    let decoded = match base64_decode(&padded) {
        Some(d) => d,
        None => return false,
    };
    let v: Value = match serde_json::from_slice(&decoded) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let exp = v.get("exp").and_then(|x| x.as_i64()).unwrap_or(0);
    if exp <= 0 {
        return false;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // 30 秒余量，避免「刚好在边界上过期」
    now + 30 >= exp
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let v = T.iter().position(|&x| x == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// 从响应体里按候选键名取值，先看 data 再看顶层。
/// 后端的这一族响应形状并不统一（有的包 data，有的扁平），所以两种都兼容。
/// 键名同时接受 camelCase 与 snake_case。
fn pick_field(body: &Value, keys: &[&str]) -> String {
    let data = body.get("data").cloned().unwrap_or(Value::Null);
    for src in [&data, body] {
        for k in keys {
            if let Some(v) = src.get(*k).and_then(|x| x.as_str()) {
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
    }
    String::new()
}

/// 用 refresh_token 换新 access token；成功后把新令牌广播给前端落盘。
async fn refresh_token(app: &AppHandle) -> bool {
    let cfg = current_cfg(app);
    if cfg.refresh_token.is_empty() || cfg.server_url.is_empty() {
        return false;
    }
    let url = format!("{}/auth/refresh", cfg.base());
    let resp = client()
        .post(url)
        .json(&json!({ "refreshToken": cfg.refresh_token }))
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(_) => return false,
    };
    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return false,
    };
    if body.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return false;
    }
    // 实测服务端返回的是扁平的 snake_case：
    //   {"success":true,"access_token":"...","refresh_token":"...","message":"..."}
    // 不是文档里那种包在 data 里、键名 camelCase 的形状，所以两种都兼容着取。
    let token = pick_field(&body, &["token", "accessToken", "access_token"]);
    if token.is_empty() {
        return false;
    }
    // 刷新令牌是一次性的：服务端每次刷新都会轮换，旧的立刻作废。
    // 所以必须把新的存下来，否则下次刷新一定失败。
    let new_refresh = pick_field(&body, &["refreshToken", "refresh_token"]);

    {
        let st = app.state::<UploadState>();
        let mut g = st.inner.lock().unwrap();
        g.cfg.token = token.clone();
        if !new_refresh.is_empty() {
            g.cfg.refresh_token = new_refresh.clone();
        }
    }
    // 让 bridge 把新令牌写回 localStorage，面板后续的问答/接口调用才不会 401
    let _ = app.emit(
        "auth:updated",
        json!({ "token": token, "refreshToken": new_refresh }),
    );
    true
}

/// 取一个可用 token：临期就先刷新，刷新失败再退回原 token（让服务端给出 401）。
async fn usable_token(app: &AppHandle) -> String {
    let cfg = current_cfg(app);
    if jwt_expired(&cfg.token) && refresh_token(app).await {
        return current_cfg(app).token;
    }
    cfg.token
}

/* ---------------- 上传 ---------------- */

fn mime_of(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" => "text/markdown",
        "txt" | "log" => "text/plain",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn fail(app: &AppHandle, id: &str, msg: &str) {
    let m = msg.to_string();
    update_item(app, id, |it| {
        it.status = "failed".into();
        it.progress = 0;
        it.error = m;
    });
}

async fn upload_one(app: AppHandle, id: String) {
    let (cfg, item) = {
        let st = app.state::<UploadState>();
        let g = st.inner.lock().unwrap();
        let it = match g.items.iter().find(|i| i.id == id) {
            Some(i) => i.clone(),
            None => return,
        };
        (g.cfg.clone(), it)
    };

    if !cfg.usable() {
        fail(&app, &id, "没有登录或未选择知识库");
        return;
    }

    update_item(&app, &id, |it| {
        it.status = "uploading".into();
        it.progress = 1;
        it.error.clear();
    });

    let path = PathBuf::from(&item.path);
    let meta = std::fs::metadata(&path);
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    if let Ok(m) = &meta {
        if m.is_dir() {
            fail(&app, &id, "这是文件夹，会按里面的文件逐个上传");
            return;
        }
    }
    if size == 0 {
        fail(&app, &id, "文件是空的或读不到");
        return;
    }
    if size > MAX_FILE_MB * 1024 * 1024 {
        fail(&app, &id, &format!("超过 {}MB 上限", MAX_FILE_MB));
        return;
    }

    let read_path = path.clone();
    let bytes = match tauri::async_runtime::spawn_blocking(move || std::fs::read(&read_path)).await {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => {
            fail(&app, &id, &format!("读取失败：{}", e));
            return;
        }
        Err(_) => {
            fail(&app, &id, "读取失败");
            return;
        }
    };

    update_item(&app, &id, |it| it.size = bytes.len() as u64);

    let url = format!(
        "{}/knowledge-bases/{}/knowledge/file",
        cfg.base(),
        cfg.kb_id
    );

    let mut body: Option<Value> = None;
    for attempt in 0..2 {
        let token = usable_token(&app).await;
        if token.is_empty() {
            let _ = app.emit("auth:expired", json!({}));
            fail(&app, &id, "登录已过期，请重新登录");
            return;
        }

        let part = match multipart::Part::bytes(bytes.clone())
            .file_name(item.name.clone())
            .mime_str(mime_of(&item.name))
        {
            Ok(p) => p,
            Err(e) => {
                fail(&app, &id, &format!("构造请求失败：{}", e));
                return;
            }
        };
        let form = multipart::Form::new().part("file", part);

        let resp = client()
            .post(&url)
            .bearer_auth(&token)
            .header("X-Tenant-ID", cfg.tenant_id.to_string())
            .header("Accept", "application/json")
            .multipart(form)
            .send()
            .await;

        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                // 网络层错误重试一次（连接被重置之类）
                if attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    continue;
                }
                fail(&app, &id, &format!("网络错误：{}", e));
                return;
            }
        };

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

        if status == reqwest::StatusCode::UNAUTHORIZED {
            if attempt == 0 && refresh_token(&app).await {
                continue;
            }
            let _ = app.emit("auth:expired", json!({}));
            fail(&app, &id, "登录已过期，请重新登录");
            return;
        }
        if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
            fail(&app, &id, &format!("超过服务端 {}MB 限制", MAX_FILE_MB));
            return;
        }
        // 重复文件必须放在 !is_success 之前判断：
        // 实测后端返回的是 HTTP 409 + {"success":false,"code":"duplicate_file","data":{已有记录}}，
        // 先按错误处理就会把「库里已经有了」显示成「失败」。
        if v.get("code").and_then(|c| c.as_str()) == Some("duplicate_file") {
            let kid = v
                .pointer("/data/id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            update_item(&app, &id, |it| {
                it.status = "exists".into();
                it.progress = 100;
                it.knowledge_id = kid;
                it.parse_status = "completed".into();
            });
            return;
        }
        if !status.is_success() {
            let msg = v
                .pointer("/error/message")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("message").and_then(|x| x.as_str()))
                .or_else(|| v.get("error").and_then(|x| x.as_str()))
                .unwrap_or("")
                .to_string();
            fail(
                &app,
                &id,
                &format!("HTTP {} {}", status.as_u16(), if msg.is_empty() { text.chars().take(120).collect::<String>() } else { msg }),
            );
            return;
        }
        body = Some(v);
        break;
    }

    let v = match body {
        Some(v) => v,
        None => {
            fail(&app, &id, "上传没有完成");
            return;
        }
    };

    // 重复文件在上面按 code 处理过了，走到这里的都是成功响应
    if v.get("success").and_then(|s| s.as_bool()) != Some(true) {
        let msg = v
            .pointer("/error/message")
            .and_then(|x| x.as_str())
            .or_else(|| v.get("message").and_then(|x| x.as_str()))
            .unwrap_or("上传失败")
            .to_string();
        fail(&app, &id, &msg);
        return;
    }

    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let kid = data
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if kid.is_empty() {
        fail(&app, &id, "服务端没有返回知识条目 ID");
        return;
    }

    let initial = data
        .get("parse_status")
        .and_then(|x| x.as_str())
        .unwrap_or("pending")
        .to_string();

    update_item(&app, &id, |it| {
        it.status = "parsing".into();
        it.progress = 30;
        it.knowledge_id = kid.clone();
        it.parse_status = initial.clone();
        it.parse_elapsed = 0;
    });

    // 解析轮询单独起任务：不挡住队列里的下一个文件
    tauri::async_runtime::spawn(async move {
        poll_parse(app, id, kid).await;
    });
}

async fn poll_parse(app: AppHandle, id: String, knowledge_id: String) {
    let started = Instant::now();
    // 服务端实测 20 秒内完成；给到 5 分钟，超时只提示不当作失败
    for _ in 0..150 {
        tokio::time::sleep(Duration::from_secs(2)).await;

        let cfg = current_cfg(&app);
        if cfg.server_url.is_empty() {
            return;
        }
        let token = usable_token(&app).await;
        let url = format!("{}/knowledge/{}", cfg.base(), knowledge_id);
        let resp = client()
            .get(&url)
            .bearer_auth(&token)
            .header("X-Tenant-ID", cfg.tenant_id.to_string())
            .header("Accept", "application/json")
            .send()
            .await;

        let v: Value = match resp {
            Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
                if refresh_token(&app).await {
                    continue;
                }
                let _ = app.emit("auth:expired", json!({}));
                return;
            }
            Ok(r) => match r.json().await {
                Ok(v) => v,
                Err(_) => continue,
            },
            Err(_) => continue,
        };

        let data = v.get("data").cloned().unwrap_or(v.clone());
        let ps = data
            .get("parse_status")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let elapsed = started.elapsed().as_secs();

        match ps.as_str() {
            "completed" => {
                update_item(&app, &id, |it| {
                    it.status = "done".into();
                    it.progress = 100;
                    it.parse_status = "completed".into();
                    it.parse_elapsed = elapsed;
                });
                return;
            }
            "failed" => {
                let err = data
                    .get("error_message")
                    .and_then(|x| x.as_str())
                    .unwrap_or("解析失败")
                    .to_string();
                update_item(&app, &id, |it| {
                    it.status = "failed".into();
                    it.parse_status = "failed".into();
                    it.parse_elapsed = elapsed;
                    it.error = err;
                });
                return;
            }
            _ => {
                update_item(&app, &id, |it| {
                    it.status = "parsing".into();
                    it.progress = 60;
                    it.parse_status = ps.clone();
                    it.parse_elapsed = elapsed;
                });
            }
        }
    }

    // 超时不判失败：文件确实已经入库了，只是还没解析完
    update_item(&app, &id, |it| {
        it.parse_status = "processing".into();
        it.error = "解析时间较长，稍后会自动完成".into();
    });
}

pub fn kick(app: AppHandle) {
    {
        let st = app.state::<UploadState>();
        if st.busy.swap(true, Ordering::SeqCst) {
            return;
        }
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let next = {
                let st = app.state::<UploadState>();
                let g = st.inner.lock().unwrap();
                g.items
                    .iter()
                    .find(|i| i.status == "queued")
                    .map(|i| i.id.clone())
            };
            match next {
                Some(id) => upload_one(app.clone(), id).await,
                None => break,
            }
        }
        {
            let st = app.state::<UploadState>();
            st.busy.store(false, Ordering::SeqCst);
        }
        // 收尾瞬间可能刚好又排进来一个，补一次
        let more = {
            let st = app.state::<UploadState>();
            let g = st.inner.lock().unwrap();
            g.items.iter().any(|i| i.status == "queued")
        };
        if more {
            kick(app);
        }
    });
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
pub fn upload_enqueue(
    app: AppHandle,
    paths: Vec<String>,
    cfg: UploadCfg,
) -> Value {
    let mut queued = 0usize;
    let mut exists = 0usize;
    let mut skipped = 0usize;
    let mut too_big = Vec::new();

    {
        let st = app.state::<UploadState>();
        let mut g = st.inner.lock().unwrap();
        // 配置每次提交都刷新一遍：换了知识库/重新登录后无需重启
        if cfg.usable() {
            g.cfg = cfg.clone();
        }
        if g.cfg.token.is_empty() {
            return json!({ "queued": 0, "exists": 0, "skipped": 0, "error": "登录已过期，请重新登录" });
        }
        if g.items.len() >= MAX_BATCH {
            return json!({ "queued": 0, "exists": 0, "skipped": 0, "error": "队列太长，先清一下" });
        }
        let tenant_id = if cfg.tenant_id > 0 { cfg.tenant_id } else { g.cfg.tenant_id };

        let mut fresh: Vec<(String, String, u64)> = Vec::new();
        for p in paths.iter().filter(|p| !p.is_empty()) {
            let pb = PathBuf::from(p);
            let name = pb
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| p.clone());
            match std::fs::metadata(&pb) {
                Ok(m) if m.is_dir() => {
                    let before = fresh.len();
                    collect_files(&pb, &pb, &mut fresh, 0);
                    if fresh.len() == before {
                        skipped += 1;
                    }
                }
                Ok(m) if m.is_file() => fresh.push((p.clone(), name, m.len())),
                _ => skipped += 1,
            }
        }

        for (path, rel, size) in fresh {
            if g.items.len() >= MAX_BATCH {
                break;
            }
            if g.items.iter().any(|i| i.path == path && i.status != "failed") {
                exists += 1;
                continue;
            }
            if size > MAX_FILE_MB * 1024 * 1024 {
                too_big.push(rel.clone());
                skipped += 1;
                continue;
            }
            let item = UploadItem::new(path, rel, size, tenant_id);
            g.items.push(item);
            queued += 1;
        }
    }

    // 入队后立刻广播一次，让面板和桌宠马上看到「排队中」
    emit_stats(&app);
    {
        let st = app.state::<UploadState>();
        let g = st.inner.lock().unwrap();
        for it in g.items.iter().filter(|i| i.status == "queued") {
            let _ = app.emit("upload:update", json!({ "item": it, "stats": stats_of(&g.items) }));
        }
    }

    let mut out = json!({ "queued": queued, "exists": exists, "skipped": skipped });
    if !too_big.is_empty() {
        out["error"] = json!(format!(
            "{} 个文件超过 {}MB：{}",
            too_big.len(),
            MAX_FILE_MB,
            too_big.join("、")
        ));
    }
    if queued > 0 {
        kick(app);
    }
    out
}

#[tauri::command]
pub fn upload_list(app: AppHandle) -> Vec<UploadItem> {
    let st = app.state::<UploadState>();
    let g = st.inner.lock().unwrap();
    g.items.clone()
}

#[tauri::command]
pub fn upload_clear(app: AppHandle) -> Value {
    {
        let st = app.state::<UploadState>();
        let mut g = st.inner.lock().unwrap();
        g.items
            .retain(|i| i.status != "done" && i.status != "failed" && i.status != "exists");
    }
    emit_stats(&app);
    json!({ "ok": true })
}

#[tauri::command]
pub fn upload_retry(app: AppHandle, id: String) -> Value {
    {
        let st = app.state::<UploadState>();
        let mut g = st.inner.lock().unwrap();
        if let Some(it) = g.items.iter_mut().find(|i| i.id == id) {
            it.status = "queued".into();
            it.progress = 0;
            it.error.clear();
            it.knowledge_id.clear();
            it.parse_status.clear();
            it.parse_elapsed = 0;
        }
    }
    update_item(&app, &id, |_| {});
    kick(app);
    json!({ "ok": true })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    path: String,
    name: String,
    size: u64,
    is_dir: bool,
    dir: bool,
    ok: bool,
}

fn path_info(p: String) -> PathInfo {
    let pb = PathBuf::from(&p);
    let name = pb
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| p.clone());
    match std::fs::metadata(&pb) {
        Ok(m) => PathInfo {
            path: p,
            name,
            size: if m.is_dir() { 0 } else { m.len() },
            is_dir: m.is_dir(),
            dir: m.is_dir(),
            ok: true,
        },
        Err(_) => PathInfo {
            path: p,
            name,
            size: 0,
            is_dir: false,
            dir: false,
            ok: false,
        },
    }
}

/// 真实文件信息：面板的暂存清单原来把大小写死成 64KB，勾选目录时也判断不出来。
#[tauri::command]
pub fn describe_paths(paths: Vec<String>) -> Vec<PathInfo> {
    paths.into_iter().map(path_info).collect()
}

/// 原生「选文件 / 选文件夹」。
///
/// 为什么不能继续用 webview 里的 `<input type="file">`：WKWebView 交出来的 File
/// 只有 name，没有绝对路径（`File.path` 是 Electron 自己加的），于是
/// `describePaths(['报告.pdf'])` 一律 meta 失败 → ok:false → 清单里显示「读不到」，
/// 「存入」按钮永远是灰的。用户看到的就是「能选，但传不上去」。
///
/// 这里走系统对话框（tauri-plugin-dialog），拿到的是真实绝对路径，和原生拖放
/// （tauri://drag-drop）完全同一条下游链路。
///
/// 注意：blocking_* 不能在主线程调用；async 命令跑在异步运行时线程上，所以安全。
#[tauri::command]
pub async fn pick_paths(app: AppHandle, kind: Option<String>) -> Value {
    use tauri_plugin_dialog::DialogExt;

    let kind = kind.unwrap_or_else(|| "files".to_string());
    let dialog = app.dialog();
    let mut picked: Vec<PathBuf> = Vec::new();

    if kind == "folder" {
        if let Some(f) = dialog.file().blocking_pick_folder() {
            if let Ok(p) = f.into_path() {
                picked.push(p);
            }
        }
    } else if kind == "folders" {
        for f in dialog.file().blocking_pick_folders().unwrap_or_default() {
            if let Ok(p) = f.into_path() {
                picked.push(p);
            }
        }
    } else {
        for f in dialog.file().blocking_pick_files().unwrap_or_default() {
            if let Ok(p) = f.into_path() {
                picked.push(p);
            }
        }
    }

    if picked.is_empty() {
        return json!({ "canceled": true, "items": [] });
    }

    let items: Vec<PathInfo> = picked
        .into_iter()
        .map(|p| path_info(p.to_string_lossy().to_string()))
        .collect();
    json!({ "canceled": false, "items": items })
}

#[tauri::command]
pub fn upload_set_cfg(app: AppHandle, cfg: UploadCfg) -> Value {
    let st = app.state::<UploadState>();
    let mut g = st.inner.lock().unwrap();
    g.cfg = cfg;
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端传的是 camelCase（bridge 里就是这么拼的）。字段名对不上时
    /// serde 不会报错，只会静默留空 —— 之前 start_dragging 的 window_label 事故
    /// 就是这个形态，所以这里必须钉住。
    #[test]
    fn cfg_accepts_camel_case_from_bridge() {
        let raw = json!({
            "serverUrl": "http://192.168.1.234:18080",
            "token": "t0k",
            "refreshToken": "r3f",
            "tenantId": 10009,
            "kbId": "kb-1"
        });
        let cfg: UploadCfg = serde_json::from_value(raw).expect("cfg 应当能反序列化");
        assert_eq!(cfg.server_url, "http://192.168.1.234:18080");
        assert_eq!(cfg.token, "t0k");
        assert_eq!(cfg.refresh_token, "r3f");
        assert_eq!(cfg.tenant_id, 10009);
        assert_eq!(cfg.kb_id, "kb-1");
        assert!(cfg.usable());
        assert_eq!(cfg.base(), "http://192.168.1.234:18080/api/v1");
    }

    #[test]
    fn cfg_base_strips_trailing_slash() {
        let cfg = UploadCfg {
            server_url: "https://knowledge.example.com/".into(),
            kb_id: "k".into(),
            ..Default::default()
        };
        assert_eq!(cfg.base(), "https://knowledge.example.com/api/v1");
    }

    /// 发给前端的 item 必须是 camelCase，panel.js 读的是 knowledgeId / parseStatus
    #[test]
    fn item_serializes_camel_case() {
        let mut it = UploadItem::new("/tmp/a.md".into(), "a.md".into(), 1234, 10009);
        it.knowledge_id = "kid".into();
        it.parse_status = "processing".into();
        let v = serde_json::to_value(&it).unwrap();
        assert!(v.get("knowledgeId").is_some(), "缺 knowledgeId: {}", v);
        assert!(v.get("parseStatus").is_some(), "缺 parseStatus: {}", v);
        assert_eq!(v["name"], json!("a.md"));
        // 面板的「移除」按钮只在 knowledgeId 存在时渲染
        assert_eq!(v["knowledgeId"], json!("kid"));
    }

    #[test]
    fn stats_counts_phases() {
        let mut a = UploadItem::new("/tmp/a".into(), "a".into(), 1, 1);
        let mut b = UploadItem::new("/tmp/b".into(), "b".into(), 1, 1);
        let mut c = UploadItem::new("/tmp/c".into(), "c".into(), 1, 1);
        let d = UploadItem::new("/tmp/d".into(), "d".into(), 1, 1);
        a.status = "uploading".into();
        b.status = "parsing".into();
        c.status = "exists".into();
        let s = stats_of(&[a, b, c, d]);
        assert_eq!((s.total, s.uploading, s.parsing, s.running, s.exists, s.queued), (4, 1, 1, 2, 1, 1));
    }

    #[test]
    fn jwt_expiry_is_detected() {
        // {"exp": 1000} —— 早就过期了
        let expired = "h.eyJleHAiOjEwMDB9.s";
        assert!(jwt_expired(expired));
        // {"exp": 99999999999} —— 远未到期
        let alive = "h.eyJleHAiOjk5OTk5OTk5OTk5fQ.s";
        assert!(!jwt_expired(alive));
        // 解析不了就当没过期，交给 401 兜底
        assert!(!jwt_expired("garbage"));
        assert!(!jwt_expired(""));
    }

    /// 后端的 refresh 响应是扁平的 snake_case，不是 data 包装
    #[test]
    fn refresh_response_shapes() {
        let flat = json!({"success": true, "access_token": "A", "refresh_token": "R"});
        assert_eq!(pick_field(&flat, &["token", "accessToken", "access_token"]), "A");
        assert_eq!(pick_field(&flat, &["refreshToken", "refresh_token"]), "R");

        let wrapped = json!({"success": true, "data": {"token": "A2", "refreshToken": "R2"}});
        assert_eq!(pick_field(&wrapped, &["token", "access_token"]), "A2");
        assert_eq!(pick_field(&wrapped, &["refreshToken", "refresh_token"]), "R2");

        // 都没有时返回空串，调用方据此判失败，而不是写入空令牌
        assert_eq!(pick_field(&json!({"success": true}), &["token"]), "");
        assert_eq!(pick_field(&json!({"token": ""}), &["token"]), "");
    }
}
