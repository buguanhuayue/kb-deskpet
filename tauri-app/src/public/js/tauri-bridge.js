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
    if (bus) {
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
      if (evt) emit(evt, payload);
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
      if (p.token) {
        saveCfg(p.refreshToken ? { token: p.token, refreshToken: p.refreshToken } : { token: p.token });
        emit('auth:updated', p);
      }
    });
    eventMod.listen('auth:expired', () => emit('auth:expired', {}));

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

  function normalizeBase() {
    const cfg = loadCfg();
    const s = (cfg.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
    return `${s}/api/v1`;
  }

  async function apiRequest(path, options = {}) {
    const cfg = loadCfg();
    const base = normalizeBase();
    const url = `${base}${path}`;
    const headers = { 'Accept': 'application/json', ...options.headers };
    if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }

    if (!res.ok) {
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

  async function fetchAllKBs(tokenOverride) {
    const cfg = loadCfg();
    const token = tokenOverride || cfg.token;
    const base = normalizeBase();
    const headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const [ownRes, sharedRes] = await Promise.allSettled([
      fetch(`${base}/knowledge-bases`, { headers }).then(r => r.json()),
      fetch(`${base}/shared-knowledge-bases`, { headers }).then(r => r.json())
    ]);

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

    const seen = new Set(own.map(k => k.id));
    const merged = [...own, ...shared.filter(k => k.id && !seen.has(k.id))];

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
        tenantId: Number(c.tenantId) || 0,
        email: c.email || '',
        petPos: c.petPos || null,
        sidebarOpen: localStorage.getItem('deskpet_sidebar_open') !== '0',
        uploads: []
      };
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
          body: { email: account, password: pass }
        });
        // 后端登录返回的令牌字段在不同版本里分别是 token / access_token，
        // 刷新令牌则是新增的，没有它 access token 一天后过期就只能重新登录。
        const token = data.token || data.data?.token || data.access_token;
        if (!token) throw new Error(data.message || '登录失败：未获取到 Token');
        const user = data.user || data.data?.user || { username: account, email: account };
        const activeTenant = data.active_tenant || data.data?.active_tenant || {};
        // 租户以登录返回的 active_tenant 为准；后端没给就退回用户自己的 tenant_id，
        // 绝不写死某个租户号——写死过一次（10000），表现为所有上传都 403。
        const tenantId = Number(activeTenant.id) || Number(user.tenant_id) || 0;
        const tenantName = activeTenant.name || '';
        const refreshToken =
          data.refreshToken || data.refresh_token ||
          data.data?.refreshToken || data.data?.refresh_token || '';

        // 获取完整知识库列表（包括个人库与共享库）
        let allKbs = [];
        try {
          allKbs = await fetchAllKBs(token);
        } catch {}

        const ownKbs = allKbs.filter(k => !k.shared);
        const writableKbs = allKbs.filter(k => !k.shared || k.permission === 'editor' || k.permission === 'owner');
        // 不再兜底到某个人的知识库：一个都读不到就先登录进去，让用户在面板里自己选
        const pick = ownKbs[0] || writableKbs[0] || allKbs[0] || null;

        saveCfg({
          token,
          // 刷新令牌用于 access token 过期后自动续期（有效期 1 天，原来过期就只能重新登录）
          refreshToken,
          user,
          userName: user.username || user.name || account,
          tenantId,
          // 身份租户单独存一份，切知识库/切空间都不许改它。
          // 上传要发的 X-Tenant-ID 只认这个值（与官方 Web 前端一致：永远发自己所在空间），
          // 早期把「共享库属主租户」当成租户头发给服务端，认证层直接 403。
          homeTenantId: tenantId,
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
          tenantId,
          tenantName,
          kbId: pick ? pick.id : '',
          kbName: pick ? pick.name : '',
          kbs: writableKbs,
          serverUrl: targetServerUrl,
          email: account
        };

        broadcast('login_success', stateResult);
        return stateResult;
      } catch (err) {
        return { ok: false, error: err.message || '登录异常' };
      }
    },

    logout: async () => {
      // 身份租户一起清掉，避免换账号后残留上一个用户的空间号
      saveCfg({ token: '', user: null, homeTenantId: 0 });
      broadcast('logout', {});
    },

    listKBs: async (force) => {
      try {
        const allKbs = await fetchAllKBs();
        const cfg = loadCfg();
        // 没有默认租户：登录后由后端返回的 active_tenant 落盘，读不到就留 0
        const tid = Number(cfg.tenantId) || 0;
        const tname = cfg.tenantName || '';

        // 个人空间：自己创建的库
        const ownKbs = allKbs.filter(k => !k.shared);
        // 共享可写库：技术部门知识库等 editor 权限库
        const sharedWritableKbs = allKbs.filter(k => k.shared && (k.permission === 'editor' || k.permission === 'owner'));

        const groups = [];
        if (ownKbs.length) {
          groups.push({
            tenantId: tid,
            tenantName: '个人空间',
            role: 'owner',
            kbs: ownKbs.map(k => ({
              id: k.id,
              name: k.name,
              documents: k.documents,
              shared: false,
              permission: 'owner',
              tenantId: tid,
              tenantName: '个人空间'
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
        cachedAskKbIds = allKbs.map(k => k.id);

        return {
          ok: true,
          groups,
          current: cfg.kbId,
          tenantId: cfg.tenantId,
          ask: {
            count: allKbs.length,
            total: allKbs.length,
            docs: totalDocs,
            names: sortedNames
          }
        };
      } catch (err) {
        return { ok: false, groups: [], error: err.message };
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
        } catch {
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

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.token}`,
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream'
          },
          body: JSON.stringify(payload)
        });

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
        const r = await invoke('upload_enqueue', {
          paths,
          cfg: {
            serverUrl: cfg.serverUrl || DEFAULT_SERVER_URL,
            token: cfg.token || '',
            refreshToken: cfg.refreshToken || '',
            // 上传永远以登录身份租户发起：跨租户的共享库写入由服务端路由守卫
            // （KBAccessWrite → 组织共享判定）放行，不需要、也不能发共享库属主租户。
            // 老配置没有 homeTenantId：先从登录时存下的 user.tenant_id 自愈；
            // 都取不到就发 0（Rust 不带租户头，服务端按 JWT 解析身份租户）。
            // 绝不退回 cfg.tenantId —— 旧版切过共享库会把它污染成属主租户 10000，
            // 那样老用户不重新登录就还是 403。
            tenantId: Number(cfg.homeTenantId) || Number(cfg.user && cfg.user.tenant_id) || 0,
            kbId: cfg.kbId || ''
          }
        });
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
    // 令牌过期（自动续期也失败）：面板需要退回登录页
    onAuthExpired: (cb) => on('auth:expired', cb),
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
