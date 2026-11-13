// tauri-bridge.js: 知识小助 Tauri 完整后端协议适配层
(function() {
  const DEFAULT_SERVER_URL = 'https://knowledge.xinyeonline.com.cn';
  const EMAIL_DOMAIN = 'company.local';

  function normalizeAccount(input) {
    const s = String(input || '').trim();
    if (!s) return s;
    if (s.includes('@')) return s;
    return `${s}@${EMAIL_DOMAIN}`;
  }

  const invoke = async (cmd, args = {}) => {
    const tauri = window.__TAURI__;
    const core = tauri?.core || tauri;
    if (core && typeof core.invoke === 'function') {
      try {
        return await core.invoke(cmd, args);
      } catch (e) {
        console.error(`[tauri invoke error] ${cmd}:`, e);
        return null;
      }
    }
    return null;
  };

  const STORAGE_KEY = 'deskpet_cfg_v2';
  const loadCfg = () => {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      let serverUrl = data.serverUrl;
      if (!serverUrl || serverUrl.includes('192.168.1.234')) {
        serverUrl = DEFAULT_SERVER_URL;
      }
      return {
        // 身份相关的字段一律没有默认值：账号、租户、知识库都用登录后后端返回的真实值，
        // 否则会出现「没登录却像已登录」「上传打到别人的租户」这类怪事。
        serverUrl,
        ...data,
        serverUrl
      };
    } catch {
      return { serverUrl: DEFAULT_SERVER_URL };
    }
  };

  const saveCfg = (patch) => {
    const cur = loadCfg();
    const next = { ...cur, ...patch };
    if (patch && patch.serverUrl) {
      next.serverUrl = String(patch.serverUrl).trim().replace(/\/+$/, '');
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    broadcast('cfg_change', next);
    return next;
  };

  const bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('deskpet_bus') : null;
  const listeners = new Map();

  const on = (evt, cb) => {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(cb);
    return () => listeners.get(evt).delete(cb);
  };

  const emit = (evt, payload) => {
    const set = listeners.get(evt);
    if (set) set.forEach(cb => { try { cb(payload); } catch (e) { console.error(e); } });
  };

  // 当前窗口的 label（'panel' / 'pet'），emit_event 用它告诉 Rust「别回传给我自己」
  const SELF_LABEL = (() => {
    try {
      const w = window.__TAURI__?.window?.getCurrentWindow?.();
      if (w && w.label) return w.label;
    } catch {}
    try {
      return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || '';
    } catch {}
    return '';
  })();

  const broadcast = (evt, payload) => {
    emit(evt, payload);
    // origin 让 Rust 侧用 emit_filter 跳过发送方窗口：app.emit 是广播给所有窗口（含自己），
    // 同窗口再触发一次 listen 就会把同一个事件处理两遍。
    invoke('emit_event', { event: evt, payload, origin: SELF_LABEL });
    // auth 事件只走 Rust emit_event 这一条跨窗口通道。再叠一层 BroadcastChannel
    // 会让另一窗口收到两遍，且 bus.onmessage 是裸 emit，绕过写盘清身份。
    if (bus && !evt.startsWith('auth:')) {
      try { bus.postMessage({ evt, payload }); } catch {}
    }
  };

  // 只在本窗口（以及浏览器预览的 BroadcastChannel）派发，不绕回 Rust 广播。
  // 用于本窗口产生、本窗口消费的事件（如 chat 流式分片）：桌宠窗口不监听这些事件。
  const emitLocal = (evt, payload) => {
    emit(evt, payload);
    if (bus) {
      try { bus.postMessage({ evt, payload }); } catch {}
    }
  };


  if (bus) {
    bus.onmessage = (e) => {
      const { evt, payload } = e.data || {};
      if (!evt) return;
      // auth 事件必须走统一处理：裸 emit 会绕过写盘清身份和幂等闸门
      if (evt === 'auth:expired') { handleAuthExpiredEvent(); return; }
      if (evt === 'auth:restored') { markAuthRestored(); return; }
      if (evt === 'auth:logout') { emit('auth:logout', {}); return; }
      emit(evt, payload);
    };
  }

  const tauriObj = window.__TAURI__;
  const IS_TAURI = !!tauriObj;
  const eventMod = tauriObj?.event || (tauriObj?.core && tauriObj.core.event);
  if (eventMod && typeof eventMod.listen === 'function') {
    eventMod.listen('pet:state', (e) => emit('pet:state', e.payload));
    eventMod.listen('chat:event', (e) => emit('chat:event', e.payload));
    eventMod.listen('upload:update', (e) => emit('upload:update', e.payload));
    // 自动更新的下载进度由 Rust 侧按 120ms 节流后发过来
    eventMod.listen('update:progress', (e) => emit('update:progress', e.payload));
    // 启动自检的结论（面板加载晚于自检完成时靠这条补上）
    eventMod.listen('update:checked', (e) => emit('update:checked', e.payload));
    eventMod.listen('toast', (e) => emit('toast', e.payload));
    eventMod.listen('panel:shown', (e) => emit('panel:shown', e.payload));
    // 桌宠窗口收到的拖放结果统一转给面板处理（上传只有一个出口）
    eventMod.listen('store:stage', (e) => emit('store:stage', e.payload));

    // 令牌刷新/过期由 Rust 侧判定，回传到前端落盘或提示重新登录
    eventMod.listen('auth:updated', (e) => {
      const p = e.payload || {};
      if (!p.token) return;
      const patch = { token: p.token };
      // 服务端只在轮换时才返回新 refreshToken；空串绝不能把旧值覆盖掉
      if (p.refreshToken) patch.refreshToken = p.refreshToken;
      saveCfg(patch);
      // 不回推 upload_set_cfg：Rust 已经写好新令牌并清了过期闸门，
      // 再推一次可能用上一周期的旧快照覆盖回去。
      markAuthRestored();
      emit('auth:updated', patch);
    });
    eventMod.listen('auth:expired', () => handleAuthExpiredEvent());
    eventMod.listen('auth:restored', () => markAuthRestored());
    // 主动登出的跨窗口接收端：broadcast 对 auth:* 不走 BroadcastChannel，
    // 少了这条 listen，桌宠窗口永远收不到、退出后仍摆着已登录姿态。
    eventMod.listen('auth:logout', () => emit('auth:logout', {}));

    // 原生拖拽支持：Tauri 2 拦截了系统级拖拽事件并转发为 tauri://drag-drop
    eventMod.listen('tauri://drag-drop', (e) => {
      const paths = e.payload?.paths || [];
      if (paths && paths.length) {
        if (typeof window.stagePathsFromTauri === 'function') {
          window.stagePathsFromTauri(paths);
        } else if (typeof window.handlePetDropFromTauri === 'function') {
          window.handlePetDropFromTauri(paths);
        }
      }
    });
  }

  /* ---------------- 统一认证层 ----------------
   * 401 的唯一出口：apiRequest / fetchAllKBs / ask / 启动校验全部收敛到这里。
   * 先静默刷新，刷新失败才清身份并广播 auth:expired。
   * refreshToken 是一次性的，并发 401 必须由单飞锁串成一个刷新请求，
   * 否则后到的请求拿已作废的旧 refreshToken 去换，会把所有人一起踢去登录。
   */
  let authExpired = false;
  let refreshFlight = null;

  function buildUploadCfg() {
    const c = loadCfg();
    return {
      serverUrl: c.serverUrl || DEFAULT_SERVER_URL,
      token: c.token || '',
      refreshToken: c.refreshToken || '',
      // 上传永远以登录身份租户发起；绝不退回可能被旧版污染成 10000 的 cfg.tenantId
      tenantId: Number(c.homeTenantId) || Number(c.user && c.user.tenant_id) || 0,
      kbId: c.kbId || ''
    };
  }

  // 换账号 / 换配置时把当前登录态推给 Rust 的上传队列。
  // 注意：静默续期不走这里 —— 令牌由 Rust refresh_token() 单点写入并清闸，
  // 前端回推的旧快照乱序到达会把刚轮换的新令牌覆盖回已作废的旧值。
  // 返回 Promise，登录时 await 它，确保上传队列不会留着上一个账号的身份。
  function syncRustCfg() {
    if (!IS_TAURI) return Promise.resolve();
    return invoke('upload_set_cfg', { cfg: buildUploadCfg() }).catch(() => {});
  }

  function kbHeaders(tokenOverride, tenantIdOverride) {
    const cfg = loadCfg();
    const token = (tokenOverride !== undefined && tokenOverride !== null && tokenOverride !== '')
      ? tokenOverride : cfg.token;
    const headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // 身份租户显式传，别让服务端按 JWT 里的 active_tenant 去猜（zhangzhangyi 事故）。
    const hasOverride = tenantIdOverride !== undefined && tenantIdOverride !== null;
    const identityTenantId = hasOverride
      ? (Number(tenantIdOverride) || 0)
      : (Number(cfg.homeTenantId) || Number(cfg.user && cfg.user.tenant_id) || 0);
    if (identityTenantId > 0) headers['X-Tenant-ID'] = String(identityTenantId);
    return headers;
  }

  // 只清身份字段，保留 email / serverUrl 供登录页回填。
  // 必须写盘：state() 每次从 localStorage 重读，只改内存的话重启又会判成已登录，
  // 回到主界面继续 401 静默失败 —— 这是旧实现最致命的一处。
  function clearIdentity() {
    saveCfg({
      token: '', refreshToken: '', user: null,
      homeTenantId: 0, currentTenantId: 0, tenantId: 0,
      tenantName: '', kbId: '', kbName: '',
      userName: '', memberships: []
    });
    cachedAskKbIds = [];
    activeSessionId = '';
    // 返回 Promise：主链路（onUnauthorized）会 await，确保空身份先推给 Rust，
    // 不会晚到把随后重登写入的新令牌覆盖掉。
    return syncRustCfg();
  }

  // 收到过期事件（Rust 广播 / 另一窗口广播 / 本窗口检测到 401）时的统一动作。
  // 这里不再往外广播：Rust 的 app.emit 会到所有窗口，broadcast 带 origin 只到别的窗口，
  // 再广播一次就会形成事件环。
  function handleAuthExpiredEvent() {
    if (authExpired) return;
    authExpired = true;
    clearIdentity();
    emit('auth:expired', {});
  }

  function markAuthRestored() {
    authExpired = false;
    emit('auth:restored', {});
  }

  function broadcastAuthRestored() {
    authExpired = false;
    broadcast('auth:restored', {});
  }

  async function doRefresh() {
    const cfg = loadCfg();
    if (!cfg.refreshToken || !cfg.serverUrl) return false;
    try {
      let patch;
      if (IS_TAURI) {
        // 刷新收敛到 Rust 单飞执行（refresh_auth 与 usable_token 共一把锁）：
        // 两端各刷一次会把一次性轮换的 refreshToken 互相作废，把所有人误踢到登录页。
        // 命令直接回传新令牌，不等 auth:updated 事件异步到达。
        // 带上 localStorage 令牌快照：冷启动时 Rust 的 UploadState.cfg 还是空的，
        // 不补齐就会把「access 过期但 refresh 有效」误判成必须重新登录。
        const r = await invoke('refresh_auth', { cfg: buildUploadCfg() });
        if (r && r.transient) throw new TransientRefreshError();
        if (!r || !r.ok || !r.token) return false;
        patch = { token: r.token };
        if (r.refreshToken) patch.refreshToken = r.refreshToken;
      } else {
        // 纯浏览器预览（没有 Tauri 运行时）时才自己发请求
        let res;
        try {
          res = await fetch(`${normalizeBase()}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ refreshToken: cfg.refreshToken }),
            signal: AbortSignal.timeout(10000)
          });
        } catch {
          throw new TransientRefreshError();
        }
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) throw new TransientRefreshError();
          return false;
        }
        let body;
        try { body = await res.json(); } catch { throw new TransientRefreshError(); }
        const nested = body && body.data ? body.data : null;
        const pick = (...keys) => {
          for (const src of [nested, body]) {
            if (!src) continue;
            for (const k of keys) {
              const v = src[k];
              if (typeof v === 'string' && v) return v;
            }
          }
          return '';
        };
        const token = pick('token', 'accessToken', 'access_token');
        if (!token) return false;
        const newRefresh = pick('refreshToken', 'refresh_token');
        patch = { token };
        if (newRefresh) patch.refreshToken = newRefresh;
      }
      saveCfg(patch);
      // 令牌由 Rust 单点维护：这里只把新令牌写进 localStorage 供 HTTP 请求使用，
      // 不再回推 upload_set_cfg（旧快照乱序到达会覆盖刚轮换的新令牌）。
      markAuthRestored();
      emit('auth:updated', patch);
      return true;
    } catch (e) {
      // 暂时性故障必须冒泡，不能当成「刷新失败」去清盘踢登录
      if (e instanceof TransientRefreshError) throw e;
      return false;
    }
  }

  function refreshOnce() {
    if (refreshFlight) return refreshFlight;
    refreshFlight = doRefresh().finally(() => { refreshFlight = null; });
    return refreshFlight;
  }

  // 返回 true = 刷新成功，调用方重放一次原请求；false = 已过期，全窗口回登录页。
  async function onUnauthorized(canRetry) {
    if (authExpired) return false;
    if (canRetry && await refreshOnce()) return true;
    // 5 个并发 401 共享同一个失败的 flight，await 之后必须重查一次，
    // 否则 5 个 waiter 会各清一次盘、各广播一次过期事件。
    if (authExpired) return false;
    authExpired = true;
    // clearIdentity 里 saveCfg 是同步的，身份已立即写盘。先广播让 UI 立刻切登录页，
    // 再等 IPC 完成（保住「清盘 → 重登」的顺序），别把界面切换绑在 Rust 往返上。
    const synced = clearIdentity();
    // broadcast 内部已在本窗口 emit 一次，同时经 Rust emit_filter 送到另一个窗口；
    // 不要再调 handleAuthExpiredEvent，否则本窗口会收到两遍事件。
    broadcast('auth:expired', {});
    await synced;
    return false;
  }

  class AuthExpiredError extends Error {
    constructor() {
      super('登录已过期，请重新登录');
      this.name = 'AuthExpiredError';
    }
  }

  // 续期请求本身没打通（断网 / 5xx）：refreshToken 可能仍然有效。
  // 绝不能清盘、不能跳登录页，否则一次网络抖动就不可逆地把用户踢下线。
  // 作为普通错误冒泡：apiRequest 显示网络错误，启动校验按 degraded 放行。
  class TransientRefreshError extends Error {
    constructor() {
      super('网络暂不可用，无法完成登录续期');
      this.name = 'TransientRefreshError';
    }
  }

  function normalizeBase() {
    const cfg = loadCfg();
    const s = (cfg.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
    return `${s}/api/v1`;
  }

  async function apiRequest(path, options = {}, retried = false) {
    const { skipAuthRefresh, ...fetchOptions } = options;
    const doFetch = async () => {
      const cfg = loadCfg();
      const headers = { 'Accept': 'application/json', ...(options.headers || {}) };
      if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
      const rawBody = options.body;
      const isForm = typeof FormData !== 'undefined' && rawBody instanceof FormData;
      const body = (rawBody && !isForm && typeof rawBody !== 'string')
        ? JSON.stringify(rawBody) : rawBody;
      if (body && !isForm) headers['Content-Type'] = 'application/json';
      return fetch(`${normalizeBase()}${path}`, { ...fetchOptions, headers, ...(body !== undefined ? { body } : {}) });
    };

    let res = await doFetch();
    // 登录接口的 401 是「账号或密码不对」，不是 token 过期，别去刷新
    if (res.status === 401 && !retried && !skipAuthRefresh) {
      if (await onUnauthorized(true)) return apiRequest(path, options, true);
      throw new AuthExpiredError();
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }

    if (!res.ok) {
      // 重放后仍是 401：新令牌也被拒，同样按过期处理，不能留着旧身份继续静默失败
      if (res.status === 401 && !skipAuthRefresh) {
        await onUnauthorized(false);
        throw new AuthExpiredError();
      }
      const msg = json?.message || json?.error || text || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json;
  }

  // 真实上传跑在 Rust 侧（队列 + 轮询 + 令牌刷新），这里只做转发。
  // 浏览器里直接开（没有 Tauri 运行时）时退回本地模拟，方便调样式。
  let uploadQueue = [];
  const getStats = () => {
    const s = { total: uploadQueue.length, queued: 0, running: 0, done: 0, failed: 0, exists: 0 };
    for (const item of uploadQueue) {
      if (item.status === 'queued') s.queued++;
      else if (item.status === 'uploading' || item.status === 'parsing') s.running++;
      else if (item.status === 'done') s.done++;
      else if (item.status === 'failed') s.failed++;
      else if (item.status === 'exists') s.exists++;
    }
    return s;
  };

  const notifyUploadUpdate = (item) => {
    broadcast('upload:update', { item, stats: getStats() });
  };

  let activeSessionId = '';
  let cachedAskKbIds = [];

  // 知识库列表原先连 res.ok 都不判：401 时 .json() 照样解析错误体，data 取不到
  // 就返回空数组，界面显示「没有可用知识库，找管理员开通」，属于完全静默的失败。
  async function getKbJson(path, tokenOverride, tenantIdOverride, retried = false, opts = {}) {
    const res = await fetch(`${normalizeBase()}${path}`, {
      headers: kbHeaders(tokenOverride, tenantIdOverride)
    });
    if (res.status === 401 && !opts.skipAuth && !retried) {
      if (await onUnauthorized(true)) {
        // 用刷新后落盘的新令牌重放，不能再沿用调用方传入的旧 token
        return getKbJson(path, null, tenantIdOverride, true, opts);
      }
      throw new AuthExpiredError();
    }
    if (res.status === 401 && !opts.skipAuth) {
      await onUnauthorized(false);
      throw new AuthExpiredError();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchAllKBs(tokenOverride, tenantIdOverride, opts = {}) {
    const [ownRes, sharedRes] = await Promise.allSettled([
      getKbJson('/knowledge-bases', tokenOverride, tenantIdOverride, false, opts),
      getKbJson('/shared-knowledge-bases', tokenOverride, tenantIdOverride, false, opts)
    ]);
    // 认证过期不能被 allSettled 吞掉：上层据此回到登录页
    for (const r of [ownRes, sharedRes]) {
      if (r.status === 'rejected' && r.reason instanceof AuthExpiredError) throw r.reason;
    }
    // 两个请求都失败（断网 / 5xx）：别把故障伪装成「没有可用知识库，找管理员开通」，
    // 让 listKBs 返回 ok:false，面板显示「知识库读取失败」。
    if (ownRes.status === 'rejected' && sharedRes.status === 'rejected') {
      throw new Error(ownRes.reason?.message || '知识库列表读取失败');
    }

    let own = [];
    if (ownRes.status === 'fulfilled' && ownRes.value) {
      const d = ownRes.value.data || ownRes.value;
      own = Array.isArray(d) ? d : [];
    }

    let shared = [];
    if (sharedRes.status === 'fulfilled' && sharedRes.value) {
      const items = sharedRes.value.data || sharedRes.value;
      if (Array.isArray(items)) {
        shared = items.map(it => ({
          ...(it.knowledge_base || {}),
          shared: true,
          sharePermission: it.permission || 'viewer',
          orgName: it.org_name || ''
        }));
      }
    }

    // 按 id 合并，而不是「own 优先、把同 id 的 shared 直接丢掉」：
    // 同一个库可能既在自有列表又在共享列表（自己共享出去的库、或部门主租户
    // 自有库被组织共享）。旧写法会吃掉 shared/permission 标记，于是 editor
    // 权限库被误判成只读、下拉分组也塌成一组。
    const byId = new Map();
    for (const k of own) {
      if (!k || !k.id) continue;
      byId.set(k.id, { ...k, shared: false, sharePermission: 'owner' });
    }
    for (const k of shared) {
      if (!k || !k.id) continue;
      const prev = byId.get(k.id);
      if (!prev) {
        byId.set(k.id, k);
        continue;
      }
      // 自有身份优先，但保留组织名与共享权限，供分组/文案使用。
      byId.set(k.id, {
        ...prev,
        sharePermission: k.sharePermission || prev.sharePermission,
        orgName: k.orgName || prev.orgName
      });
    }
    const merged = [...byId.values()];

    return merged.map(k => {
      const docs = k.knowledge_count !== undefined ? k.knowledge_count : (k.documents ?? k.chunk_count ?? 0);
      return {
        id: k.id,
        name: k.name,
        documents: docs,
        docCount: docs,
        shared: !!k.shared,
        permission: k.sharePermission || (k.shared ? 'viewer' : 'owner'),
        orgName: k.orgName || '',
        tenantId: k.tenant_id
      };
    });
  }

  // 引用图片取回：走 KB 文件代理（Bearer + 身份租户头，与 403 修复同一套规则）。
  // 引用里的 image_info.url 是 resource:// 存储句柄，浏览器不能直接当 <img src>，
  // 必须经代理转成 blob → objectURL。401 时与 ask 同策略：静默续期后重放一次。
  const refImageCache = new Map(); // storageUrl -> Promise<{ok, objectUrl}>
  const REF_IMAGE_CACHE_MAX = 60;

  async function fetchRefImageOnce(kbId, filePath) {
    const url = `${normalizeBase()}/knowledge-bases/${encodeURIComponent(kbId)}/files?file_path=${encodeURIComponent(filePath)}`;
    const doFetch = async (authToken, retried) => {
      const r = await fetch(url, { headers: kbHeaders(authToken) });
      if (r.status === 401 && !retried && await onUnauthorized(true)) {
        return doFetch(loadCfg().token, true);
      }
      if (!r.ok) throw new Error(`图片请求失败: HTTP ${r.status}`);
      const blob = await r.blob();
      return URL.createObjectURL(blob);
    };
    return doFetch(loadCfg().token, false).then((objectUrl) => ({ ok: true, objectUrl }));
  }

  window.pet = {
    state: async () => {
      const c = loadCfg();
      const hasLogin = !!(c.token && c.user);
      return {
        ok: true,
        loggedIn: hasLogin,
        serverUrl: c.serverUrl || DEFAULT_SERVER_URL,
        token: c.token || '',
        user: c.user || null,
        userName: c.userName || (c.user && (c.user.username || c.user.name)) || '',
        tenantName: c.tenantName || '',
        kbId: c.kbId || '',
        kbName: c.kbName || '',
        tenantId: Number(c.homeTenantId) ||
          Number(c.user && c.user.tenant_id) || Number(c.tenantId) || 0,
        homeTenantId: Number(c.homeTenantId) || 0,
        currentTenantId: Number(c.currentTenantId) || 0,
        email: c.email || '',
        petPos: c.petPos || null,
        sidebarOpen: localStorage.getItem('deskpet_sidebar_open') !== '0',
        uploads: []
      };
    },

    // 启动校验：只有「明确的 401」才算会话过期。网络故障 / 5xx / 超时一律放行，
    // 否则离线打开桌宠会被误踢到登录页。
    // 探针复用已确定存在的 GET /knowledge-bases，不引入未验证的新接口。
    validateSession: async () => {
      const cfg = loadCfg();
      if (!cfg.token || !cfg.user) return { ok: false, loggedIn: false, expired: true };
      const probe = () => fetch(`${normalizeBase()}/knowledge-bases`, {
        headers: kbHeaders(),
        signal: AbortSignal.timeout(6000)
      });
      try {
        let res = await probe();
        if (res.status === 401 && await onUnauthorized(true)) res = await probe();
        if (res.status === 401) {
          await onUnauthorized(false);
          return { ok: false, expired: true };
        }
        return { ok: true, degraded: !res.ok };
      } catch (e) {
        if (e instanceof AuthExpiredError) return { ok: false, expired: true };
        return { ok: true, degraded: true, error: e.message };
      }
    },

    login: async ({ serverUrl, email, password }) => {
      // 不再带任何默认账号/密码：账号密码只能由用户自己输入。
      const account = normalizeAccount(String(email || '').trim());
      const pass = String(password || '');
      if (!account || !pass) return { ok: false, error: '请输入账号和密码' };
      const targetServerUrl = String(serverUrl || loadCfg().serverUrl || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '');
      saveCfg({ serverUrl: targetServerUrl });
      try {
        const data = await apiRequest('/auth/login', {
          method: 'POST',
          body: { email: account, password: pass },
          // 登录接口的 401 是「账号或密码不对」，不是会话过期
          skipAuthRefresh: true
        });
        // 后端登录返回的令牌字段在不同版本里分别是 token / access_token，
        // 刷新令牌则是新增的，没有它 access token 一天后过期就只能重新登录。
        const token = data.token || data.data?.token || data.access_token;
        if (!token) throw new Error(data.message || '登录失败：未获取到 Token');
        const user = data.user || data.data?.user || { username: account, email: account };
        const activeTenant = data.active_tenant || data.data?.active_tenant || {};
        // home 租户 = 账号归属的 workspace（user.tenant_id），永远不变；
        // current 租户 = 本次登录落点（active_tenant），只用于显示。
        // 早期把 active_tenant 直接当 homeTenantId：账号被落到部门主租户(10000)时，
        // 上传把 X-Tenant-ID 发成 10000，知识库列表也把主租户的库当成个人空间。
        // 绝不写死某个租户号——写死过一次（10000），表现为所有上传都 403。
        const homeTenantId = Number(user.tenant_id) || 0;
        const currentTenantId = Number(activeTenant.id) || homeTenantId || 0;
        const tenantName = activeTenant.name || '';
        const refreshToken =
          data.refreshToken || data.refresh_token ||
          data.data?.refreshToken || data.data?.refresh_token || '';

        // 登录这一刻 cfg 里还存着上一个账号的身份，必须显式把本次的 home 租户传进去
        let allKbs = [];
        try {
          // 此刻身份还没落盘，cfg 里可能仍是上一个账号的 refreshToken；
          // 登录阶段的列表请求不参与续期，401 就按「取不到库」处理。
          allKbs = await fetchAllKBs(token, homeTenantId, { skipAuth: true });
        } catch {}

        const writableKbs = allKbs.filter(k => !k.shared || k.permission === 'editor' || k.permission === 'owner');
        // 默认上传目标只从「home 租户下的自有库」里挑。
        // 旧写法 ownKbs[0] 盲选第一个：账号落到部门主租户时，把别人建的 lgf
        // 设成了默认上传目标（2026-11-07 事故）。取不到就留空，让面板显式选。
        const homeOwnKbs = allKbs.filter(k =>
          !k.shared && homeTenantId > 0 && Number(k.tenantId) === homeTenantId
        );
        const pick = homeOwnKbs[0] || null;

        saveCfg({
          token,
          // 刷新令牌用于 access token 过期后自动续期（有效期 1 天，原来过期就只能重新登录）
          refreshToken,
          user,
          userName: user.username || user.name || account,
          tenantId: homeTenantId,
          // 身份租户单独存一份，切知识库/切空间都不许改它。
          // 上传要发的 X-Tenant-ID 只认这个值（与官方 Web 前端一致：永远发自己所在空间），
          // 早期把「共享库属主租户」当成租户头发给服务端，认证层直接 403。
          homeTenantId,
          currentTenantId,
          tenantName,
          email: account,
          kbId: pick ? pick.id : '',
          kbName: pick ? pick.name : '',
          serverUrl: targetServerUrl,
          memberships: data.memberships || []
        });

        const stateResult = {
          ok: true,
          loggedIn: true,
          token,
          user,
          userName: user.username || user.name || account,
          tenantId: homeTenantId,
          homeTenantId,
          currentTenantId,
          tenantName,
          kbId: pick ? pick.id : '',
          kbName: pick ? pick.name : '',
          kbs: writableKbs,
          serverUrl: targetServerUrl,
          email: account
        };

        // 新身份落盘后同步给 Rust 上传队列：既清掉上一个账号的旧令牌，
        // 也让 token 过期时保留下来的排队条目自动续跑。必须 await，
        // 否则用户立刻拖文件时 Rust 里可能还是上一个账号的身份。
        await syncRustCfg();
        broadcastAuthRestored();
        broadcast('login_success', stateResult);
        return stateResult;
      } catch (err) {
        return { ok: false, error: err.message || '登录异常' };
      }
    },

    logout: async () => {
      // 换账号时把身份、空间、上次选的库全部清掉，否则新账号会沿用上一个账号的
      // kbId / tenantName，出现「张三的界面挂着李四的库」。
      // 只保留 email 作为登录页回填，方便重新输入密码。
      saveCfg({
        token: '', refreshToken: '', user: null,
        homeTenantId: 0, currentTenantId: 0, tenantId: 0,
        tenantName: '', kbId: '', kbName: '',
        userName: '', memberships: []
      });
      cachedAskKbIds = [];
      activeSessionId = '';
      // 把空身份推给 Rust，否则上传队列会一直揣着上一个账号的 token
      await syncRustCfg();
      authExpired = false;
      broadcast('logout', {});
      // 桌宠窗口也要同步回「未登录」姿态，否则主动退出后它仍显示已登录
      broadcast('auth:logout', {});
    },

    listKBs: async (force) => {
      try {
        const allKbs = await fetchAllKBs();
        const cfg = loadCfg();
        // 身份租户只从 homeTenantId / user.tenant_id 取，绝不退回 cfg.tenantId：
        // 旧版 selectKB 会把 cfg.tenantId 污染成共享库属主租户 10000。
        const tid = Number(cfg.homeTenantId) || Number(cfg.user && cfg.user.tenant_id) || 0;
        const homeName = cfg.tenantName || '个人空间';

        const ownKbs = allKbs.filter(k => !k.shared);
        // 共享可写库：技术部门知识库等 editor 权限库
        const sharedWritableKbs = allKbs.filter(k => k.shared && (k.permission === 'editor' || k.permission === 'owner'));
        // 自有库按库的真实 tenant_id 分开，不再一律贴「个人空间 / 创建者」。
        // 账号被落到部门主租户时，旧写法把 10000 里别人建的库显示成自己的。
        const homeOwnKbs = ownKbs.filter(k => tid > 0 && Number(k.tenantId) === tid);
        const foreignOwnKbs = ownKbs.filter(k => !(tid > 0 && Number(k.tenantId) === tid));

        const groups = [];
        if (homeOwnKbs.length) {
          groups.push({
            tenantId: tid,
            tenantName: homeName,
            role: 'owner',
            kbs: homeOwnKbs.map(k => ({
              id: k.id,
              name: k.name,
              documents: k.documents,
              shared: false,
              permission: 'owner',
              tenantId: tid,
              tenantName: homeName
            }))
          });
        }
        if (foreignOwnKbs.length) {
          // 库不在 home 租户：属于别的空间，标成「其他空间 / 成员」，不谎称创建者。
          // 正常状态下这一组应该为空；它出现就说明账号又被落到错误空间了。
          const foreignTenantId = Number(foreignOwnKbs[0].tenantId) || 0;
          const foreignName = `其他空间（${foreignTenantId || '未知'}）`;
          groups.push({
            tenantId: foreignTenantId,
            tenantName: foreignName,
            role: 'member',
            kbs: foreignOwnKbs.map(k => ({
              id: k.id,
              name: k.name,
              documents: k.documents,
              shared: false,
              permission: 'member',
              tenantId: Number(k.tenantId) || foreignTenantId,
              tenantName: foreignName
            }))
          });
        }
        if (sharedWritableKbs.length) {
          // 共享库的租户号取后端返回的那一个；万一没带，退回当前登录用户自己的租户。
          // 这里曾经写死过 10000，导致切到共享库后上传一律 403。
          const deptTenantId = sharedWritableKbs[0]?.tenantId || tid || 0;
          const deptName = sharedWritableKbs[0]?.orgName ? `${sharedWritableKbs[0].orgName}部门` : '部门空间';
          groups.push({
            tenantId: deptTenantId,
            tenantName: deptName,
            role: 'editor',
            kbs: sharedWritableKbs.map(k => ({
              id: k.id,
              name: k.name,
              documents: k.documents,
              shared: true,
              permission: k.permission,
              tenantId: deptTenantId,
              tenantName: deptName
            }))
          });
        }

        const totalDocs = allKbs.reduce((acc, cur) => acc + (cur.documents || 0), 0);
        const sortedNames = allKbs.slice().sort((a, b) => (b.documents || 0) - (a.documents || 0)).map(k => k.name);
        // 问答范围保留全部可访问库（含只读共享），服务端本来就按组织共享授权放行读取；
        // 只是把口径如实报给 UI，避免出现「11 个库 vs 下拉 2 个」的困惑。
        cachedAskKbIds = allKbs.map(k => k.id);
        const readOnlyCount = allKbs.filter(k => k.shared && k.permission === 'viewer').length;
        const writableCount = groups.reduce((n, g) => n + g.kbs.length, 0);

        return {
          ok: true,
          groups,
          current: cfg.kbId,
          tenantId: tid,
          ask: {
            count: allKbs.length,
            total: allKbs.length,
            docs: totalDocs,
            names: sortedNames,
            readOnly: readOnlyCount,
            writable: writableCount
          }
        };
      } catch (err) {
        // 认证过期时统一认证层已把界面切回登录页；这里只如实回报，别再显示「找管理员开通」
        return { ok: false, expired: err instanceof AuthExpiredError, groups: [], error: err.message };
      }
    },

    selectKB: async ({ id, name }) => {
      // 只落知识库选择，绝不写 tenantId：部门空间组的 tenantId 是「共享库属主租户」，
      // 只用来给 UI 分组，写回 cfg 会把上传的 X-Tenant-ID 污染成 10000 而触发 403。
      // 身份租户固定取 homeTenantId，跨租户写入由服务端按组织共享授权放行。
      saveCfg({ kbId: id, kbName: name });
      return { ok: true };
    },

    // 问答流
    ask: async ({ query, attachmentIds = [] }) => {
      const cfg = loadCfg();
      const base = normalizeBase();

      if (!activeSessionId) {
        try {
          const sRes = await apiRequest('/sessions', {
            method: 'POST',
            body: { title: query.slice(0, 20) }
          });
          activeSessionId = sRes.data?.id || sRes.id || '';
        } catch (e) {
          if (e instanceof AuthExpiredError) return { error: e.message };
          // 续期请求没打通时别造一个假 sessionId 再发一次注定失败的 SSE；
          // 旧写法会落进下面的兜底，凭空多出 /knowledge-chat/s_<timestamp> 请求。
          if (e instanceof TransientRefreshError) return { error: e.message };
          activeSessionId = 's_' + Date.now();
        }
      }

      const url = `${base}/knowledge-chat/${encodeURIComponent(activeSessionId)}`;
      emitLocal('chat:event', { response_type: 'agent_query' });

      try {
        const poolIds = (cachedAskKbIds && cachedAskKbIds.length) ? cachedAskKbIds : (cfg.kbId ? [cfg.kbId] : []);
        const payload = {
          query,
          knowledge_base_ids: poolIds
        };
        if (attachmentIds && attachmentIds.length) {
          payload.attachment_ids = attachmentIds;
        }

        // SSE 开始前若拿到 401 就静默续期并重放一次；流中途不会再返回 HTTP 401。
        // 重放必须用刚落盘的新令牌，不能用函数开头的 cfg 快照。
        const askFetch = async (authToken, retried) => {
          const r = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${authToken}`,
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream'
            },
            body: JSON.stringify(payload)
          });
          if (r.status === 401 && !retried && await onUnauthorized(true)) {
            return askFetch(loadCfg().token, true);
          }
          return r;
        };
        const res = await askFetch(loadCfg().token, false);

        if (res.status === 401) {
          await onUnauthorized(false);
          throw new AuthExpiredError();
        }
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`问答请求失败: ${errText || res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            try {
              const ev = JSON.parse(line.slice(5).trim());
              emitLocal('chat:event', ev);
            } catch {}
          }
        }

        emitLocal('chat:event', { response_type: 'complete' });
        if (activeSessionId) localStorage.setItem('deskpet_last_session', activeSessionId);
        return { ok: true, sessionId: activeSessionId };
      } catch (e) {
        emitLocal('chat:event', { response_type: 'error', content: e.message });
        return { error: e.message };
      }
    },

    // 引用图片取回：走 KB 文件代理（Bearer + 身份租户头，与 403 修复同一套规则）。
    // 引用里的 image_info.url 是 resource:// 存储句柄，浏览器不能直接当 <img src>，
    // 必须经代理转成 blob → objectURL。401 时与 ask 同策略：静默续期后重放一次。
    fetchRefImage: async ({ kbId, filePath }) => {
      const key = String(filePath || '');
      if (!key || !kbId) return { error: '缺少知识库或文件句柄' };
      let entry = refImageCache.get(key);
      if (!entry) {
        entry = fetchRefImageOnce(kbId, key);
        refImageCache.set(key, entry);
        // 容量上限：驱逐最早缓存的 objectURL，防长时间使用泄漏内存
        if (refImageCache.size > REF_IMAGE_CACHE_MAX) {
          const oldest = refImageCache.keys().next().value;
          const evicted = refImageCache.get(oldest);
          refImageCache.delete(oldest);
          evicted.then((res) => { if (res.ok) URL.revokeObjectURL(res.objectUrl); }).catch(() => {});
        }
      }
      try {
        return await entry;
      } catch (e) {
        // 失败不缓存，下次点开还能重试
        refImageCache.delete(key);
        return { error: e.message };
      }
    },

    // 会话历史
    currentSession: async () => {
      if (!activeSessionId) {
        activeSessionId = localStorage.getItem('deskpet_last_session') || '';
      }
      return { ok: true, id: activeSessionId || '' };
    },

    listSessions: async (payload = {}) => {
      try {
        const page = Number(payload && payload.page) || 1;
        const pageSize = Number(payload && payload.pageSize) || 20;
        const keyword = String((payload && payload.keyword) || '').trim();
        const q = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
        if (keyword) q.set('keyword', keyword);

        const r = await apiRequest(`/sessions?${q.toString()}`);
        const list = Array.isArray(r.data) ? r.data : (Array.isArray(r) ? r : []);
        const total = Number(r.total) || list.length;

        const items = list.map(s => ({
          id: s.id,
          title: s.title || '',
          pinned: !!s.is_pinned,
          updatedAt: s.updated_at || s.created_at || '',
          createdAt: s.created_at || ''
        }));

        return { ok: true, items, total, page, pageSize };
      } catch (err) {
        return { ok: false, error: err.message, items: [], total: 0 };
      }
    },

    loadSession: async (id) => {
      if (!id) return { ok: false, error: '会话不存在' };
      try {
        const r = await apiRequest(`/messages/${encodeURIComponent(id)}/load?limit=60`);
        const rows = Array.isArray(r.data) ? r.data : (Array.isArray(r) ? r : []);
        const messages = rows
          .map(m => {
            if (!m) return null;
            let role = m.role;
            if (role === 'human') role = 'user';
            if (role === 'ai') role = 'assistant';
            if (role !== 'user' && role !== 'assistant') return null;
            return {
              id: m.id,
              role,
              content: m.content || '',
              refs: Array.isArray(m.knowledge_references) ? m.knowledge_references : [],
              at: m.created_at || ''
            };
          })
          .filter(Boolean);

        messages.sort((a, b) => {
          const ta = a.at ? new Date(a.at).getTime() : 0;
          const tb = b.at ? new Date(b.at).getTime() : 0;
          return ta - tb;
        });

        activeSessionId = id;
        localStorage.setItem('deskpet_last_session', id);
        return { ok: true, id, messages };
      } catch (err) {
        if (err.message && err.message.includes('404')) {
          activeSessionId = '';
          localStorage.removeItem('deskpet_last_session');
          return { ok: false, error: '这条会话已不存在', gone: true };
        }
        return { ok: false, error: err.message };
      }
    },

    selectSession: async (id) => {
      if (!id) return { ok: false, error: '会话 ID 为空' };
      activeSessionId = id;
      localStorage.setItem('deskpet_last_session', id);
      return { ok: true, id };
    },

    newSession: async () => {
      activeSessionId = '';
      localStorage.removeItem('deskpet_last_session');
      return { ok: true, id: '' };
    },

    renameSession: async (payload = {}) => {
      const id = payload && payload.id;
      const title = String((payload && payload.title) || '').trim();
      if (!id) return { ok: false, error: '会话 ID 为空' };
      if (!title) return { ok: false, error: '标题不能为空' };
      try {
        await apiRequest(`/sessions/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: { title: title.slice(0, 120) }
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    pinSession: async (payload = {}) => {
      const id = payload && payload.id;
      if (!id) return { ok: false, error: '会话 ID 为空' };
      try {
        await apiRequest(`/sessions/${encodeURIComponent(id)}/pin`, {
          method: 'POST',
          body: { pinned: !!(payload && payload.pinned) }
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    deleteSession: async (id) => {
      if (!id) return { ok: false, error: '会话 ID 为空' };
      try {
        await apiRequest(`/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE'
        });
        if (activeSessionId === id) {
          activeSessionId = '';
          localStorage.removeItem('deskpet_last_session');
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    setSidebarOpen: (open) => {
      localStorage.setItem('deskpet_sidebar_open', open ? '1' : '0');
    },

    // 网络自检
    netDiag: async (serverUrl) => {
      const target = (serverUrl || loadCfg().serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
      const t0 = Date.now();
      try {
        const res = await fetch(`${target}/health`, { signal: AbortSignal.timeout(5000) });
        return { ok: res.ok, ms: Date.now() - t0, status: res.status };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: e.message };
      }
    },

    // 知识库管理
    listKnowledge: async (kbId) => {
      try {
        const id = kbId || loadCfg().kbId;
        const res = await apiRequest(`/knowledge-bases/${encodeURIComponent(id)}/knowledge?page=1&page_size=50`);
        return { ok: true, data: res.data || res.items || [] };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    deleteKnowledge: async (id) => {
      try {
        await apiRequest(`/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    uploadText: async ({ title, content }) => {
      const cfg = loadCfg();
      if (!cfg.kbId) return { ok: false, error: '未选择知识库' };
      try {
        const res = await apiRequest(`/knowledge-bases/${encodeURIComponent(cfg.kbId)}/knowledge/manual`, {
          method: 'POST',
          body: {
            title: title || '粘贴内容',
            content: content || '',
            status: 'publish',
            channel: 'deskpet'
          }
        });
        return { ok: true, data: res.data || res };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // 窗口控制与拖拽联动
    showPanel: () => invoke('show_panel'),
    hidePanel: () => invoke('hide_panel'),
    togglePanel: () => invoke('toggle_panel'),
    dragStart: () => {},
    dragPanel: () => invoke('start_dragging', { windowLabel: 'panel' }),
    dragMove: (dx, dy) => {
      // 参数名必须是 windowLabel：Tauri v2 的命令参数默认按 camelCase 反序列化，
      // 写成 window_label 会被忽略，window_label 落空后 Rust 侧一律回退成 "pet"——
      // 于是「拖面板」实际拖的是桌宠，表现为面板纹丝不动。
      // 不在这里取整：整数化交给调用方按余量攒，Rust 侧再按 scale_factor 换算成物理像素
      if (dx || dy) {
        invoke('move_window', { windowLabel: 'pet', dx: dx || 0, dy: dy || 0 });
      }
    },
    dragEnd: () => {},
    petMenu: () => invoke('toggle_panel'),
    quit: () => invoke('app_quit'),

    // 拖到桌宠身上的文件交给面板统一「存入」，避免两个窗口各自上传同一批文件
    stagePathsInPanel: (paths) => {
      if (!paths || !paths.length) return
      broadcast('store:stage', { paths })
    },
    onStoreStage: (cb) => on('store:stage', cb),

    openUrl: (url) => {
      window.open(url, '_blank');
    },

    // 上传与队列：真实上传在 Rust 侧完成（流式读盘 + multipart + 解析轮询 + 令牌刷新），
    // 这里只负责把当前登录态连同路径交过去。队列本身也只有一份，两个窗口共用。
    uploadPaths: async (paths) => {
      if (!paths || !paths.length) return { queued: 0, exists: 0 };
      const cfg = loadCfg();
      if (IS_TAURI) {
        // 令牌 / 身份租户 / 目标库统一由 buildUploadCfg() 取，
        // 绝不退回可能被旧版污染成 10000 的 cfg.tenantId（403 事故的根因）。
        const r = await invoke('upload_enqueue', { paths, cfg: buildUploadCfg() });
        if (!r) return { queued: 0, exists: 0, error: '上传服务不可用' };
        return r;
      }

      // 非 Tauri（纯浏览器预览）时的降级实现，仅用于调样式
      const known = new Map(
        uploadQueue.filter(i => i.status !== 'failed').map(i => [i.path, i])
      );
      let exists = 0;
      let added = 0;
      const ids = [];
      for (const p of paths) {
        if (!p) continue;
        if (known.has(p)) { exists++; continue; }
        const item = {
          id: 'u_' + Date.now() + Math.random().toString(36).slice(2, 6),
          name: p.split(/[/\\]/).pop(),
          path: p,
          status: 'queued',
          progress: 0
        };
        known.set(p, item);
        added++;
        ids.push(item.id);
        uploadQueue.push(item);
        notifyUploadUpdate(item);

        setTimeout(() => {
          item.status = 'uploading';
          notifyUploadUpdate(item);
          setTimeout(() => {
            item.status = 'done';
            notifyUploadUpdate(item);
          }, 1500);
        }, 500);
      }
      return { queued: added, exists, ids };
    },

    listUploads: async () => {
      if (!IS_TAURI) return uploadQueue;
      const r = await invoke('upload_list');
      return Array.isArray(r) ? r : [];
    },
    clearUploads: async () => {
      if (IS_TAURI) return (await invoke('upload_clear')) || { ok: true };
      uploadQueue = uploadQueue.filter(i => i.status !== 'done' && i.status !== 'failed');
      broadcast('upload:update', { stats: getStats() });
      return { ok: true };
    },

    pathForFile: (file) => file.name || file.path || '',
    describePaths: async (paths) => {
      const list = paths || [];
      if (IS_TAURI) {
        const r = await invoke('describe_paths', { paths: list });
        if (Array.isArray(r) && r.length) return r;
      }
      return list.map(p => ({
        path: p,
        name: String(p).split(/[/\\]/).pop() || p,
        size: 0,
        isDir: false,
        dir: false,
        ok: true
      }));
    },

    openWeb: () => {
      const cfg = loadCfg();
      window.open(cfg.serverUrl || DEFAULT_SERVER_URL, '_blank');
    },

    openLocalNetworkSettings: () => ({ ok: true }),

    /* ---------------- 自动更新 ----------------
       校验、下载、替换包都在 Rust 侧（src-tauri/src/update.rs），
       这里只负责把状态和进度转给面板。 */
    appVersion: async () => {
      const v = await invoke('app_version');
      return typeof v === 'string' ? v : '';
    },
    updateCheck: async () => {
      if (!IS_TAURI) return { ok: true, info: { hasUpdate: false }, canInstall: false, canAutoRestart: false };
      const r = await invoke('update_check');
      return r || { ok: false, error: '更新服务不可用' };
    },
    // 启动自检的结论（Rust 在 setup 里查完缓存，面板加载时直接取，不重新联网）
    updateAutoResult: async () => {
      if (!IS_TAURI) return { pending: false, result: null };
      const r = await invoke('update_auto_result');
      return r || { pending: false, result: null };
    },
    onUpdateChecked: (cb) => on('update:checked', cb),
    updateInstall: async () => {
      if (!IS_TAURI) return { ok: false, error: '只有桌面端支持自动更新' };
      const r = await invoke('update_install');
      return r || { ok: false, error: '更新服务不可用' };
    },
    updateRestart: async () => {
      if (IS_TAURI) await invoke('update_restart');
    },
    onUpdateProgress: (cb) => on('update:progress', cb),

    // 存入面板文件拾取
    pickFiles: () => pet.storePick('files'),
    pickFolder: () => pet.storePick('folder'),
    storePick: async (kind) => {
      // 桌面端必须走系统对话框：webview 的 <input type="file"> 只给 File.name，
      // 拿不到绝对路径（File.path 是 Electron 的私货），describe_paths 会把每一项
      // 都判成「读不到」，于是「选文件」能选、却永远存不进去。
      if (IS_TAURI) {
        try {
          const r = await invoke('pick_paths', { kind: kind === 'folder' ? 'folder' : 'files' });
          if (r && Array.isArray(r.items)) return r;
          return { canceled: true, items: [] };
        } catch (e) {
          return { canceled: true, items: [], error: String(e && e.message ? e.message : e) };
        }
      }
      return new Promise((resolve) => {
        const inp = document.createElement('input');
        inp.type = 'file';
        if (kind === 'folder') {
          inp.webkitdirectory = true;
        } else {
          inp.multiple = true;
        }
        inp.onchange = () => {
          if (!inp.files || !inp.files.length) {
            resolve({ canceled: true });
            return;
          }
          const items = Array.from(inp.files).map(f => {
            const fullPath = f.path || f.name;
            return {
              path: fullPath,
              name: f.name,
              size: f.size || 1024 * 64,
              isDir: kind === 'folder',
              dir: kind === 'folder',
              ok: true
            };
          });
          resolve({ canceled: false, items });
        };
        inp.oncancel = () => resolve({ canceled: true });
        inp.click();
      });
    },

    uploadAttachment: async (filePath) => {
      return { ok: true, id: 'att_' + Date.now(), name: String(filePath).split(/[/\\]/).pop() };
    },

    hasClipboardImage: async () => false,
    tempImage: async () => null,

    retryUpload: async (id) => {
      if (IS_TAURI) {
        const r = await invoke('upload_retry', { id });
        if (r) return r;
      }
      const it = uploadQueue.find(i => i.id === id);
      if (it) {
        it.status = 'queued';
        notifyUploadUpdate(it);
      }
    },

    // 事件监听注册
    onUploadUpdate: (cb) => on('upload:update', cb),
    // 令牌过期（自动续期也失败）：面板需要退回登录页；桌宠窗口同步提示
    onAuthExpired: (cb) => on('auth:expired', cb),
    // 重新登录成功 / 静默续期成功：桌宠窗口从 alert 恢复
    onAuthRestored: (cb) => on('auth:restored', cb),
    // 主动退出：桌宠窗口同步回未登录姿态
    onAuthLogout: (cb) => on('auth:logout', cb),
    onChatEvent: (cb) => on('chat:event', cb),
    onPetState: (cb) => on('pet:state', cb),
    setPetState: (s) => broadcast('pet:state', s),
    onPanelShown: (cb) => on('panel:shown', cb),
    onToast: (cb) => on('toast', cb),
    onStoreOpen: (cb) => on('store:open', cb),
    onSmokeAsk: (cb) => on('smoke:ask', cb),
    onShotDemo: (cb) => on('shot:demo', cb),
    onShotMenu: (cb) => on('shot:menu', cb),
    onShotStore: (cb) => on('shot:store', cb),
    onShotDrop: (cb) => on('shot:drop', cb),
    smokeDone: () => {}
  };

  document.addEventListener('DOMContentLoaded', () => {
    const btnClose = document.getElementById('btnClose');
    if (btnClose) {
      btnClose.addEventListener('click', (e) => {
        e.preventDefault();
        window.pet.hidePanel();
      });
    }

    // 面板拖动交给 Tauri 原生的 data-tauri-drag-region（见 panel.html 的 .titlebar）。
    // 这里以前又手写了一份 mousedown → start_dragging，同一次按下会触发两次原生拖动、
    // 互相打断；而且参数名 window_label 不匹配 Tauri 的 camelCase，
    // 被忽略后窗口标签回退成 "pet" —— 表现就是拖面板却把桌宠拖走了。
  });
})();
