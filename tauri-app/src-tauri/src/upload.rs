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
//        headers: Authorization: Bearer <token>, X-Tenant-ID: <登录身份租户，>0 时才带>
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
    /// 入队那一刻的目标知识库。队列共用一份全局 cfg，用户中途切库后
    /// 旧的 queued 条目如果不自持 kb_id，就会静默上传到新选的库里。
    pub kb_id: String,
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
            kb_id: String::new(),
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
    /// 认证已失效：kick 循环必须停下，把排队中的条目原样留给用户重新登录后自动续跑。
    /// 没有这道闸门，上传失败后循环会继续取下一个 queued 条目，把它们逐个也标成失败。
    auth_blocked: AtomicBool,
    /// 全应用唯一的刷新锁：前端 refresh_auth 命令、usable_token 预刷新、上传/轮询的
    /// 401 重放都走同一把锁。刷新令牌一次性轮换，跨端各刷一次必然互相作废。
    refresh_lock: tokio::sync::Mutex<()>,
}

impl UploadState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                cfg: UploadCfg::default(),
                items: Vec::new(),
            }),
            busy: AtomicBool::new(false),
            auth_blocked: AtomicBool::new(false),
            refresh_lock: tokio::sync::Mutex::new(()),
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

/// 冷启动时 Rust 侧还是 UploadCfg::default()（空），而 localStorage 里已有有效的
/// refresh_token：不补齐的话启动校验一遇 401 就会误判「无法续期」把用户踢去登录。
/// 只在自己为空时用前端快照补齐，绝不覆盖另一个窗口刚刷出来的新令牌；
/// 也不碰 auth_blocked 闸门（那是 upload_set_cfg 的职责）。
fn prime_cfg_from_snapshot(current: &mut UploadCfg, snap: &UploadCfg) -> bool {
    let mut changed = false;
    if current.refresh_token.is_empty() && !snap.refresh_token.is_empty() {
        current.refresh_token = snap.refresh_token.clone();
        changed = true;
    }
    if current.server_url.is_empty() && !snap.server_url.is_empty() {
        current.server_url = snap.server_url.clone();
        changed = true;
    }
    if current.token.is_empty() && !snap.token.is_empty() {
        current.token = snap.token.clone();
        changed = true;
    }
    changed
}

/// 认证失效时按状态处理条目：正在上传 / 解析中的标失败，排队中的原样保留。
/// 抽成纯函数便于单测；不依赖服务端恰好返回 401 —— 令牌被清后服务端
/// 也可能回 403 或 200，只靠各轮询点自己判 401 会让条目永远卡在 parsing。
fn mark_auth_failure(items: &mut [UploadItem]) -> Vec<String> {
    let mut ids = Vec::new();
    for it in items.iter_mut() {
        if it.status == "uploading" || it.status == "parsing" {
            it.status = "failed".into();
            it.progress = 0;
            it.error = "登录已过期，请重新登录".into();
            ids.push(it.id.clone());
        }
    }
    ids
}

/// 只有第一个触发者返回 true。抽出来便于单测「多次 401 只广播一次」。
fn claim_auth_expiry(flag: &AtomicBool) -> bool {
    !flag.swap(true, Ordering::SeqCst)
}

/// 认证失效的状态变更：清掉 Rust 侧缓存的令牌、按状态标失败、暂停队列。
/// 不广播事件；返回 true 表示是首个触发者，由调用方决定是否广播。
/// 前端刷新失败（refresh_auth 返回 false）也必须走这里，否则 kick 会拿着
/// 刚被前端清掉的令牌继续消费 queued 条目，违背「排队保留、重登续跑」。
fn block_auth(app: &AppHandle) -> bool {
    let st = app.state::<UploadState>();
    let first = claim_auth_expiry(&st.auth_blocked);
    let changed = {
        let mut g = st.inner.lock().unwrap();
        // 只在首次清令牌：并发 401 里若有一个刷新请求正在写回新令牌，
        // 后续 block_auth 再清一次会把刚轮换出的有效令牌一起抹掉。
        if first {
            g.cfg.token.clear();
            g.cfg.refresh_token.clear();
        }
        mark_auth_failure(&mut g.items)
    };
    // 逐条广播状态变化，面板与桌宠窗口才能立刻看到「失败」
    for id in changed {
        update_item(app, &id, |_| {});
    }
    first
}

/// 上传/轮询自身遇到 401：置闸并广播给所有窗口。
fn expire_auth(app: &AppHandle) {
    if block_auth(app) {
        let _ = app.emit("auth:expired", json!({}));
    }
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

/// 刷新结果三态。以前一律 false，导致断网/5xx 也把 localStorage 里仍有效的
/// refreshToken 清掉并踢去登录页 —— 不可逆，且违背「断网/5xx 放行」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefreshOutcome {
    /// 服务端换发了新令牌
    Rotated,
    /// 服务端明确判定 refreshToken 无效：会话真的结束了
    Invalid,
    /// 网络故障 / 5xx / 响应异常：令牌可能仍然有效，不能据此清盘
    Transient,
}

/// 只有服务端明确判定「令牌无效」的 400/401/403 才算会话结束；
/// 429、5xx、其它异常一律按暂时性故障，绝不据此清掉仍有效的 refreshToken。
fn classify_refresh_status(status: reqwest::StatusCode) -> RefreshOutcome {
    match status {
        s if s == reqwest::StatusCode::UNAUTHORIZED
            || s == reqwest::StatusCode::FORBIDDEN
            || s == reqwest::StatusCode::BAD_REQUEST => RefreshOutcome::Invalid,
        _ => RefreshOutcome::Transient,
    }
}

/// 等锁期间前一个持有者是否已经刷新成功。token 被清空（过期置闸）时不算，
/// 否则会把闸门已开的状态误当成「复用刷新结果」放行。
fn refresh_was_rotated(before: &UploadCfg, after: &UploadCfg) -> bool {
    after.token != before.token && !after.token.is_empty()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Upload401Action {
    /// 用新令牌重放本次请求
    Retry,
    /// 只让当前条目失败，保留登录态和排队条目
    FailTransient,
    /// 会话真的结束：置闸、清盘、跳登录
    Expire,
}

/// 上传与解析轮询共用同一套 401 决策，避免两条链路语义漂移。
/// 「已经重放过一次」由调用方各自用独立布尔判断，不塞进这里：upload_one 的
/// attempt 还兼着网络层重试，拿它当 already_retried 会把「网络抖一下后首次 401」
/// 误判成重放失败，刷新成功反而清盘踢登录。
fn decide_upload_401(outcome: RefreshOutcome) -> Upload401Action {
    match outcome {
        RefreshOutcome::Rotated => Upload401Action::Retry,
        RefreshOutcome::Transient => Upload401Action::FailTransient,
        RefreshOutcome::Invalid => Upload401Action::Expire,
    }
}

/// 空 token 也要尝试刷新：冷启动 / 身份被清后 jwt_expired("") 返回 false，
/// 旧写法直接跳过刷新并 expire_auth，把暂时性故障误判成会话结束。
fn should_attempt_refresh(token: &str) -> bool {
    token.is_empty() || jwt_expired(token)
}

/// 用 refresh_token 换新 access token；成功后把新令牌广播给前端落盘。
/// 全应用唯一的刷新入口：前端 refresh_auth 命令、usable_token 预刷新、
/// 上传/轮询的 401 重放全部走这里，由同一把跨端互斥锁串行化。
async fn refresh_token(app: &AppHandle) -> RefreshOutcome {
    let before = current_cfg(app);
    if before.refresh_token.is_empty() || before.server_url.is_empty() {
        return RefreshOutcome::Invalid;
    }
    let st = app.state::<UploadState>();
    let _guard = st.refresh_lock.lock().await;
    // 排队等锁期间前一个持有者可能已经刷新成功：直接复用它的结果，
    // 绝不能拿已经作废的旧 refresh_token 再刷一次。
    let cfg = current_cfg(app);
    if refresh_was_rotated(&before, &cfg) {
        return RefreshOutcome::Rotated;
    }
    let url = format!("{}/auth/refresh", cfg.base());
    let resp = client()
        .post(url)
        .json(&json!({ "refreshToken": cfg.refresh_token }))
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(_) => return RefreshOutcome::Transient,
    };
    // 非 2xx 别指望错误体里恰好是合法 JSON；按状态码分类即可。
    if !resp.status().is_success() {
        return classify_refresh_status(resp.status());
    }
    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return RefreshOutcome::Transient,
    };
    if body.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return RefreshOutcome::Invalid;
    }
    // 实测服务端返回的是扁平的 snake_case：
    //   {"success":true,"access_token":"...","refresh_token":"...","message":"..."}
    // 不是文档里那种包在 data 里、键名 camelCase 的形状，所以两种都兼容着取。
    let token = pick_field(&body, &["token", "accessToken", "access_token"]);
    if token.is_empty() {
        return RefreshOutcome::Transient;
    }
    // 刷新令牌是一次性的：服务端每次刷新都会轮换，旧的立刻作废。
    // 所以必须把新的存下来，否则下次刷新一定失败。
    let new_refresh = pick_field(&body, &["refreshToken", "refresh_token"]);

    let has_queued = {
        let st = app.state::<UploadState>();
        let mut g = st.inner.lock().unwrap();
        g.cfg.token = token.clone();
        if !new_refresh.is_empty() {
            g.cfg.refresh_token = new_refresh.clone();
        }
        g.items.iter().any(|i| i.status == "queued")
    };
    // 令牌由 Rust 单点维护：刷新成功就在这里清闸并续跑队列，前端不再回推
    // upload_set_cfg（旧快照乱序到达会把刚轮换的新令牌覆盖回已作废的旧值）。
    st.auth_blocked.store(false, Ordering::SeqCst);
    if has_queued {
        kick(app.clone());
    }
    // 让 bridge 把新令牌写回 localStorage，面板后续的问答/接口调用才不会 401。
    // 服务端没返回新 refreshToken 时不能下发空串：前端收到空串会保留旧值（正确），
    // 但显式下发空串容易让别的订阅方误清空，这里压根不带这个字段。
    let mut payload = json!({ "token": token });
    if !new_refresh.is_empty() {
        payload["refreshToken"] = json!(new_refresh);
    }
    let _ = app.emit("auth:updated", payload);
    RefreshOutcome::Rotated
}

/// 取一个可用 token。Err 表示「连旧令牌都没有，且这次刷新没成功」，
/// 调用方必须按 outcome 区分：Transient 只让当前条目失败，绝不能全局清盘。
async fn usable_token(app: &AppHandle) -> Result<String, RefreshOutcome> {
    let cfg = current_cfg(app);
    if should_attempt_refresh(&cfg.token) {
        let outcome = refresh_token(app).await;
        if outcome == RefreshOutcome::Rotated {
            return Ok(current_cfg(app).token);
        }
        if cfg.token.is_empty() {
            return Err(outcome);
        }
    }
    Ok(cfg.token)
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
    // kick 取出 id 到本函数真正执行之间，认证可能已被置闸。此时条目仍是 queued，
    // 原样留着等重登续跑；标 failed 会白白丢掉用户排队的文件。
    if app.state::<UploadState>().auth_blocked.load(Ordering::SeqCst) {
        return;
    }
    let (mut cfg, item) = {
        let st = app.state::<UploadState>();
        let g = st.inner.lock().unwrap();
        let it = match g.items.iter().find(|i| i.id == id) {
            Some(i) => i.clone(),
            None => return,
        };
        (g.cfg.clone(), it)
    };

    // 条目没带目标库时绝不回退全局 cfg：那可能是上一个账号 / 上一次选的库，
    // 静默回退会把文件传到别人的空间里（切库、换账号场景）。
    if item.kb_id.is_empty() {
        fail(&app, &id, "没有选择知识库");
        return;
    }
    // 用条目入队时定下的 kb_id，不用此刻的全局 cfg：全局 cfg 会被下一次入队刷新，
    // 用户切库后旧条目会串到新库去。tenant_id 同理取条目自己的身份租户。
    cfg.kb_id = item.kb_id.clone();
    if item.tenant_id > 0 {
        cfg.tenant_id = item.tenant_id;
    }

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

    // 网络层重试与 401 重放各自计数。以前共用 for attempt in 0..2：一次连接重置
    // 把 attempt 推到 1 后遇到首次 401，刷新成功 Retry 却已耗尽循环次数，
    // 结果 body=None、文件被误标「上传没有完成」。现在循环直接返回成功响应体。
    let mut network_retries = 0;
    let mut retried_401 = false;
    let v: Value = loop {
        let token = match usable_token(&app).await {
            Ok(t) => t,
            // 续期请求没打通且手里没有旧令牌：只让这一个文件失败，绝不全局清盘
            Err(RefreshOutcome::Transient) => {
                fail(&app, &id, "网络暂不可用，续期未完成，请稍后重试");
                return;
            }
            Err(_) => {
                expire_auth(&app);
                fail(&app, &id, "登录已过期，请重新登录");
                return;
            }
        };

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

        // X-Tenant-ID 只发登录身份租户（官方 Web 前端的做法）。
        // 发共享库属主租户会撞上认证层「只认 tenant_members 直接成员」的闸，
        // 组织成员的直接成员行已被软删 → 403；不带这个头则由 JWT 解析身份租户。
        let mut req = client()
            .post(&url)
            .bearer_auth(&token)
            .header("Accept", "application/json");
        if cfg.tenant_id > 0 {
            req = req.header("X-Tenant-ID", cfg.tenant_id.to_string());
        }
        let resp = req.multipart(form).send().await;

        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                // 网络层错误重试一次（连接被重置之类），不占用 401 重放配额
                if network_retries < 1 {
                    network_retries += 1;
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
            // 已经用新令牌重放过一次：不再刷新（免得白白消耗一次性轮换的
            // refreshToken），只让这条失败，不全局清盘 —— 也可能是服务端临时问题。
            if retried_401 {
                fail(&app, &id, "续期后仍被拒绝，请稍后重试");
                return;
            }
            retried_401 = true;
            match decide_upload_401(refresh_token(&app).await) {
                Upload401Action::Retry => continue,
                // 续期请求本身没打通：只让这一个文件失败，绝不全局清盘踢登录
                Upload401Action::FailTransient => {
                    fail(&app, &id, "网络暂不可用，续期未完成，请稍后重试");
                    return;
                }
                Upload401Action::Expire => {
                    expire_auth(&app);
                    fail(&app, &id, "登录已过期，请重新登录");
                    return;
                }
            }
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
        break v;
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

    // 解析轮询单独起任务：不挡住队列里的下一个文件。
    // 轮询同样带上这条目自己的身份租户，别用可能被后续入队刷新的全局 cfg。
    let poll_tenant_id = cfg.tenant_id;
    tauri::async_runtime::spawn(async move {
        poll_parse(app, id, kid, poll_tenant_id).await;
    });
}

async fn poll_parse(app: AppHandle, id: String, knowledge_id: String, tenant_id: i64) {
    let started = Instant::now();
    // 401 后允许刷新重试一次；不加限制时每次 401 都刷新成功会绕满 150 轮
    let mut refreshed = false;
    // 服务端实测 20 秒内完成；给到 5 分钟，超时只提示不当作失败
    for _ in 0..150 {
        tokio::time::sleep(Duration::from_secs(2)).await;

        // 解析中的条目不能只等服务端返回 401：令牌被清后服务端也可能回 403 或 200，
        // 那样状态会一直卡在 parsing。按闸门直接标失败。
        if app.state::<UploadState>().auth_blocked.load(Ordering::SeqCst) {
            fail(&app, &id, "登录已过期，请重新登录");
            return;
        }
        let cfg = current_cfg(&app);
        if cfg.server_url.is_empty() {
            return;
        }
        let token = match usable_token(&app).await {
            Ok(t) => t,
            // 没有旧令牌且续期没打通：只让这条解析任务失败，不动登录态
            Err(RefreshOutcome::Transient) => {
                fail(&app, &id, "网络暂不可用，续期未完成，请稍后重试");
                return;
            }
            Err(_) => {
                expire_auth(&app);
                fail(&app, &id, "登录已过期，请重新登录");
                return;
            }
        };
        let url = format!("{}/knowledge/{}", cfg.base(), knowledge_id);
        let mut req = client()
            .get(&url)
            .bearer_auth(&token)
            .header("Accept", "application/json");
        if tenant_id > 0 {
            req = req.header("X-Tenant-ID", tenant_id.to_string());
        }
        let resp = req.send().await;

        let v: Value = match resp {
            Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
                // 已经用新令牌重放过一次：不再刷新，也不全局清盘
                if refreshed {
                    fail(&app, &id, "续期后仍被拒绝，请稍后重试");
                    return;
                }
                refreshed = true;
                match decide_upload_401(refresh_token(&app).await) {
                    Upload401Action::Retry => continue,
                    // 续期请求没打通：这条解析任务先失败，不影响其它条目和登录态
                    Upload401Action::FailTransient => {
                        fail(&app, &id, "网络暂不可用，续期未完成，请稍后重试");
                        return;
                    }
                    Upload401Action::Expire => {
                        // 解析中的条目此前只是 return，状态永远卡在 parsing；现在明确标失败
                        expire_auth(&app);
                        fail(&app, &id, "登录已过期，请重新登录");
                        return;
                    }
                }
            }
            Ok(r) => {
                // 服务端已正常响应过，之后的 401 允许再刷一次，别让 150 轮里
                // 一次刷新把后续所有 401 都锁死成「重放失败」。
                refreshed = false;
                match r.json().await {
                    Ok(v) => v,
                    Err(_) => continue,
                }
            }
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

/// 闸门开启时一个 queued 都不取；抽成纯函数便于单测排队条目确实被原样保留。
fn pick_next(blocked: bool, items: &[UploadItem]) -> Option<String> {
    if blocked {
        return None;
    }
    items
        .iter()
        .find(|i| i.status == "queued")
        .map(|i| i.id.clone())
}

/// 收尾时是否补一次 kick：还有 queued 且闸门未开才继续，否则会无限 spawn。
fn should_resume_kick(blocked: bool, items: &[UploadItem]) -> bool {
    !blocked && items.iter().any(|i| i.status == "queued")
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
                pick_next(
                    st.auth_blocked.load(Ordering::SeqCst),
                    &g.items,
                )
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
        // 收尾瞬间可能刚好又排进来一个，补一次；认证失效时别再自我唤醒，
        // 否则 queued 还在 + blocked 为 true 会无限 spawn kick。
        let resume = {
            let st = app.state::<UploadState>();
            let g = st.inner.lock().unwrap();
            should_resume_kick(st.auth_blocked.load(Ordering::SeqCst), &g.items)
        };
        if resume {
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
    // 本次真正新建的条目 id，回给面板用于跟踪这批文件的真实上传结果
    let mut ids: Vec<String> = Vec::new();

    {
        let st = app.state::<UploadState>();
        let mut g = st.inner.lock().unwrap();
        // 令牌由 Rust 单点维护（登录时 upload_set_cfg 写入、刷新成功时 refresh_token 写入）。
        // 这里只在自己为空时用前端快照补齐（冷启动 / 从未同步过）：前端 localStorage
        // 可能还没收到异步的 auth:updated，无条件覆盖会把刚轮换的新令牌
        // 改回已作废的旧值，下一次请求必定 401。
        if g.cfg.token.is_empty() && !cfg.token.is_empty() {
            g.cfg.token = cfg.token.clone();
            g.cfg.refresh_token = cfg.refresh_token.clone();
        }
        if !cfg.server_url.is_empty() {
            g.cfg.server_url = cfg.server_url.clone();
        }
        // 目标库与身份租户属于「本次提交」的配置，条目会自带，随时可覆盖；
        // 新账号暂时没有自有库时 kbId 为空，此时条目在 upload_one 里直接判失败，
        // 不再回退 g.cfg 里可能属于上一个账号的旧库。
        if cfg.usable() {
            g.cfg.tenant_id = cfg.tenant_id;
            g.cfg.kb_id = cfg.kb_id.clone();
        }
        if g.cfg.token.is_empty() || st.auth_blocked.load(Ordering::SeqCst) {
            return json!({ "queued": 0, "exists": 0, "skipped": 0, "ids": [], "error": "登录已过期，请重新登录" });
        }
        if g.items.len() >= MAX_BATCH {
            return json!({ "queued": 0, "exists": 0, "skipped": 0, "ids": [], "error": "队列太长，先清一下" });
        }
        // 身份租户与目标库只认本次提交的值，绝不回退到 g.cfg：
        // 回退会把新账号的文件传到上一个账号的库里。
        let tenant_id = cfg.tenant_id;
        let kb_id = cfg.kb_id.clone();

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
            let mut item = UploadItem::new(path, rel, size, tenant_id);
            item.kb_id = kb_id.clone();
            ids.push(item.id.clone());
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

    let mut out = json!({ "queued": queued, "exists": exists, "skipped": skipped, "ids": ids });
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
    let valid = !cfg.token.is_empty();
    let has_queued = {
        let st = app.state::<UploadState>();
        let mut g = st.inner.lock().unwrap();
        g.cfg = cfg;
        if valid {
            // 登录成功（前端 await syncRustCfg）时解除过期闸门，让保留的 queued 续跑。
            // 静默续期不走这里：refresh_token() 成功分支会自己清闸并 kick。
            st.auth_blocked.store(false, Ordering::SeqCst);
        }
        g.items.iter().any(|i| i.status == "queued")
    };
    // 过期时特意保留下来的排队条目，恢复令牌后自动续跑，不用用户手动点重试
    if valid && has_queued {
        kick(app);
    }
    json!({ "ok": true })
}

/// refresh_auth 的返回体抽成纯函数：失败时绝不能带 token；
/// transient 必须单独标记，前端据此「不清盘、不跳登录、按网络错误处理」。
fn refresh_result_payload(outcome: RefreshOutcome, cfg: &UploadCfg) -> Value {
    match outcome {
        RefreshOutcome::Rotated => {
            let mut out = json!({ "ok": true });
            if !cfg.token.is_empty() {
                out["token"] = json!(cfg.token);
                // 空 refreshToken 不下发：前端保留旧值，显式空串容易让别的订阅方误清空
                if !cfg.refresh_token.is_empty() {
                    out["refreshToken"] = json!(cfg.refresh_token);
                }
            }
            out
        }
        RefreshOutcome::Invalid => json!({ "ok": false, "reason": "invalid" }),
        RefreshOutcome::Transient => json!({ "ok": false, "transient": true }),
    }
}

/// 前端 401 时的唯一续期入口：刷新仍由 Rust 单飞执行，避免两端各自刷新
/// 把一次性轮换的 refresh_token 互相作废。
/// 直接回传新令牌，而不是只依赖 auth:updated 事件——invoke 返回时 webview
/// 可能还没收到那条异步事件，重放请求会拿到旧 token 再撞一次 401。
///
/// cfg 是前端 localStorage 的快照：冷启动时 Rust 侧还没有任何令牌，不补齐就会把
/// 「access token 过期但 refresh token 仍有效」误判成必须重新登录。
/// 只有 Invalid 才置闸清盘；Transient 保留令牌与排队条目，前端按网络错误处理。
#[tauri::command]
pub async fn refresh_auth(app: AppHandle, cfg: Option<UploadCfg>) -> Value {
    if let Some(snap) = cfg.as_ref() {
        let st = app.state::<UploadState>();
        let mut g = st.inner.lock().unwrap();
        prime_cfg_from_snapshot(&mut g.cfg, snap);
    }
    let outcome = refresh_token(&app).await;
    if outcome == RefreshOutcome::Invalid {
        // 不广播，前端 broadcast('auth:expired') 是唯一事件源
        block_auth(&app);
    }
    refresh_result_payload(outcome, &current_cfg(&app))
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
        // 条目自持目标库：切库后旧条目不能串到新库，序列化名必须是 camelCase
        it.kb_id = "kb-owner".into();
        it.tenant_id = 10016;
        let v2 = serde_json::to_value(&it).unwrap();
        assert_eq!(v2["kbId"], json!("kb-owner"), "缺 kbId: {}", v2);
        assert_eq!(v2["tenantId"], json!(10016), "缺 tenantId: {}", v2);
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

    /* ---------------- 统一认证层（方案 B）回归 ---------------- */

    fn auth_cfg(token: &str, refresh: &str, server: &str) -> UploadCfg {
        UploadCfg {
            token: token.into(),
            refresh_token: refresh.into(),
            server_url: server.into(),
            ..Default::default()
        }
    }

    /// 冷启动：Rust 侧 cfg 全空，前端快照必须把刷新所需的三个字段补齐。
    /// 这是「access 过期但 refresh 有效却被踢去登录」的直接回归。
    #[test]
    fn prime_cfg_fills_empty_fields_on_cold_start() {
        let mut cur = UploadCfg::default();
        let snap = auth_cfg("expired.jwt", "refresh-1", "https://kb.example.com");
        assert!(prime_cfg_from_snapshot(&mut cur, &snap));
        assert_eq!(cur.token, "expired.jwt");
        assert_eq!(cur.refresh_token, "refresh-1");
        assert_eq!(cur.server_url, "https://kb.example.com");
        assert_eq!(cur.base(), "https://kb.example.com/api/v1");
        // 重复同步不改状态；kbId / tenantId 不属于刷新所需字段，不能从别处串进来
        assert!(!prime_cfg_from_snapshot(&mut cur, &snap));
        assert_eq!(cur.tenant_id, 0);
        assert_eq!(cur.kb_id, "");
    }

    /// 另一个窗口刚刷新成功：绝不能被前端的旧快照覆盖回去。
    #[test]
    fn prime_cfg_never_overwrites_a_fresher_token() {
        let mut cur = auth_cfg("new.jwt", "refresh-2", "https://kb.example.com");
        let stale = auth_cfg("old.jwt", "refresh-1", "http://old.example.com");
        assert!(!prime_cfg_from_snapshot(&mut cur, &stale));
        assert_eq!(cur.token, "new.jwt");
        assert_eq!(cur.refresh_token, "refresh-2");
        assert_eq!(cur.server_url, "https://kb.example.com");
    }

    /// 只补缺的那个字段，不能整份覆盖。
    #[test]
    fn prime_cfg_is_field_local() {
        let mut cur = auth_cfg("", "refresh-2", "");
        let snap = auth_cfg("t", "refresh-1", "https://kb.example.com");
        assert!(prime_cfg_from_snapshot(&mut cur, &snap));
        assert_eq!(cur.token, "t");
        assert_eq!(cur.refresh_token, "refresh-2", "非空字段必须保留");
        assert_eq!(cur.server_url, "https://kb.example.com");
    }

    /// 过期瞬间：在途标失败，排队原样保留，已完成的不动。
    #[test]
    fn mark_auth_failure_only_touches_in_flight_items() {
        let mut items: Vec<UploadItem> = (0..6)
            .map(|i| UploadItem::new(format!("/tmp/f{i}"), format!("f{i}"), 1, 10009))
            .collect();
        items[0].status = "queued".into();
        items[1].status = "uploading".into();
        items[2].status = "parsing".into();
        items[3].status = "done".into();
        items[4].status = "exists".into();
        items[5].status = "failed".into();
        items[1].progress = 60;
        items[2].progress = 90;

        let ids = mark_auth_failure(&mut items);
        assert_eq!(ids, vec![items[1].id.clone(), items[2].id.clone()]);
        assert_eq!(items[0].status, "queued", "排队条目必须原样保留等重登续跑");
        for i in [1, 2] {
            assert_eq!(items[i].status, "failed");
            assert_eq!(items[i].progress, 0);
            assert_eq!(items[i].error, "登录已过期，请重新登录");
        }
        assert_eq!(items[3].status, "done");
        assert_eq!(items[4].status, "exists");
        assert_eq!(items[5].status, "failed");
        assert_eq!(items[5].error, "", "本就失败的条目不该被改文案");
        // 二次触发不能再返回同一批 id（否则会重复广播状态）
        assert!(mark_auth_failure(&mut items).is_empty());
    }

    /// 闸门开启后一个 queued 都不取；否则取最早的那个。
    #[test]
    fn pick_next_respects_auth_gate() {
        let mut a = UploadItem::new("/tmp/a".into(), "a".into(), 1, 1);
        let b = UploadItem::new("/tmp/b".into(), "b".into(), 1, 1);
        a.status = "done".into();
        let items = vec![a, b.clone()];
        assert_eq!(pick_next(false, &items), Some(b.id.clone()));
        assert_eq!(pick_next(true, &items), None, "过期闸门开启时不能消费排队条目");
        assert_eq!(items[1].status, "queued", "pick_next 不该改动条目本身");
    }

    /// 收尾补 kick：有 queued 且闸门未开才继续，否则会无限 spawn。
    #[test]
    fn should_resume_kick_only_when_queued_remains() {
        let queued = UploadItem::new("/tmp/q".into(), "q".into(), 1, 1);
        let mut done = UploadItem::new("/tmp/d".into(), "d".into(), 1, 1);
        done.status = "done".into();
        let mut failed = UploadItem::new("/tmp/f".into(), "f".into(), 1, 1);
        failed.status = "failed".into();
        assert!(should_resume_kick(false, &[queued.clone()]));
        assert!(!should_resume_kick(true, &[queued]));
        // 非空 != 还有排队条目。写成 !items.is_empty() 会在这里无限 spawn kick。
        assert!(!should_resume_kick(false, &[done, failed]));
        assert!(!should_resume_kick(false, &[]));
    }

    /// 多个并发 401 只有一个触发者广播 auth:expired；重登清闸后能再次广播。
    #[test]
    fn claim_auth_expiry_fires_once() {
        let flag = AtomicBool::new(false);
        assert!(claim_auth_expiry(&flag));
        assert!(!claim_auth_expiry(&flag));
        assert!(!claim_auth_expiry(&flag));
        flag.store(false, Ordering::SeqCst);
        assert!(claim_auth_expiry(&flag));
    }

    /// refresh_auth 的返回体三态：失败不能泄漏令牌，transient 必须单独标记。
    #[test]
    fn refresh_result_payload_contract() {
        let cur = auth_cfg("t", "r", "s");
        let ok = refresh_result_payload(RefreshOutcome::Rotated, &cur);
        assert_eq!(ok["ok"], json!(true));
        assert_eq!(ok["token"], json!("t"));
        assert_eq!(ok["refreshToken"], json!("r"));

        let invalid = refresh_result_payload(RefreshOutcome::Invalid, &cur);
        assert_eq!(invalid, json!({ "ok": false, "reason": "invalid" }));
        assert!(invalid.get("token").is_none());
        assert!(invalid.get("transient").is_none(), "明确拒绝不能标成暂时故障");

        let transient = refresh_result_payload(RefreshOutcome::Transient, &cur);
        assert_eq!(transient, json!({ "ok": false, "transient": true }));
        assert!(transient.get("token").is_none(), "暂时故障不能下发旧令牌");

        let no_rotation = auth_cfg("t", "", "s");
        let ok2 = refresh_result_payload(RefreshOutcome::Rotated, &no_rotation);
        assert_eq!(ok2["token"], json!("t"));
        assert!(ok2.get("refreshToken").is_none(), "空刷新令牌不能下发");

        assert_eq!(
            refresh_result_payload(RefreshOutcome::Rotated, &UploadCfg::default()),
            json!({ "ok": true })
        );
    }

    #[test]
    fn refresh_status_classifies_transient_vs_invalid() {
        use reqwest::StatusCode;
        for s in [StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN, StatusCode::BAD_REQUEST] {
            assert_eq!(classify_refresh_status(s), RefreshOutcome::Invalid, "{s}");
        }
        for s in [
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            assert_eq!(classify_refresh_status(s), RefreshOutcome::Transient, "{s}");
        }
    }

    #[test]
    fn refresh_reuse_check_needs_a_nonempty_new_token() {
        let before = auth_cfg("old", "r0", "s");
        let rotated = auth_cfg("new", "r1", "s");
        assert!(refresh_was_rotated(&before, &rotated));
        assert!(!refresh_was_rotated(&before, &before), "没人刷新过不能复用结果");
        assert!(
            !refresh_was_rotated(&before, &auth_cfg("", "", "s")),
            "令牌被清空不能当成刷新成功放行"
        );
        assert!(refresh_was_rotated(&UploadCfg::default(), &rotated));
    }

    /// 断网 / 5xx 的续期失败只能让当前条目失败，绝不能置闸清盘。
    #[test]
    fn upload_401_actions_keep_session_on_transient_failure() {
        assert_eq!(decide_upload_401(RefreshOutcome::Rotated), Upload401Action::Retry);
        assert_eq!(decide_upload_401(RefreshOutcome::Transient), Upload401Action::FailTransient);
        assert_eq!(decide_upload_401(RefreshOutcome::Invalid), Upload401Action::Expire);
    }

    /// 空 token 必须触发刷新，否则冷启动 / 身份被清后会直接 expire_auth，
    /// 把一次网络抖动变成全局清盘踢登录。
    #[test]
    fn empty_token_still_attempts_refresh() {
        assert!(should_attempt_refresh(""));
        assert!(should_attempt_refresh("h.eyJleHAiOjEwMDB9.s"));
        assert!(!should_attempt_refresh("h.eyJleHAiOjk5OTk5OTk5OTk5fQ.s"));
    }

    /// 契约守卫：binary crate 构造不了 AppHandle 做集成测试，用源码断言钉住
    /// 三态接线，避免「把接线删了纯函数单测仍全绿」。
    #[test]
    fn refresh_auth_wiring_contract() {
        let src = include_str!("upload.rs");
        assert!(
            src.contains("if outcome == RefreshOutcome::Invalid"),
            "refresh_auth 必须只在 Invalid 时置闸，Transient 不得清盘"
        );
        assert!(
            src.contains("Err(RefreshOutcome::Transient) => {"),
            "usable_token 的 Err 分支必须区分 Transient 与 Invalid"
        );
        assert!(
            src.contains("let mut network_retries = 0;")
                && src.contains("let mut retried_401 = false;"),
            "网络重试与 401 重放必须各自计数，不能共用一个 attempt"
        );
    }
}
