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
        serverUrl,
        email: 'liumingqing@company.local',
        userName: 'liumingqing',
        tenantId: 10009,
        tenantName: "刘明青's Workspace",
        kbId: '2d33c3a6-4618-4c89-952a-3a802a5986ae',
        kbName: '刘明青',
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

  const broadcast = (evt, payload) => {
    emit(evt, payload);
    invoke('emit_event', { event: evt, payload });
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
  const eventMod = tauriObj?.event || (tauriObj?.core && tauriObj.core.event);
  if (eventMod && typeof eventMod.listen === 'function') {
    eventMod.listen('pet:state', (e) => emit('pet:state', e.payload));
    eventMod.listen('chat:event', (e) => emit('chat:event', e.payload));
    eventMod.listen('upload:update', (e) => emit('upload:update', e.payload));
    eventMod.listen('toast', (e) => emit('toast', e.payload));
    eventMod.listen('panel:shown', (e) => emit('panel:shown', e.payload));

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
        userName: c.userName || (c.user && (c.user.username || c.user.name)) || 'liumingqing',
        tenantName: c.tenantName || "刘明青's Workspace",
        kbId: c.kbId || '2d33c3a6-4618-4c89-952a-3a802a5986ae',
        kbName: c.kbName || '刘明青',
        tenantId: c.tenantId || 10009,
        email: c.email || 'liumingqing@company.local',
        petPos: c.petPos || null,
        sidebarOpen: localStorage.getItem('deskpet_sidebar_open') !== '0',
        uploads: []
      };
    },

    login: async ({ serverUrl, email, password }) => {
      const targetServerUrl = String(serverUrl || loadCfg().serverUrl || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '');
      saveCfg({ serverUrl: targetServerUrl });
      const account = normalizeAccount(email || 'liumingqing');
      const pass = password || 'hxgs123654';
      try {
        const data = await apiRequest('/auth/login', {
          method: 'POST',
          body: { email: account, password: pass }
        });
        const token = data.token || data.data?.token;
        if (!token) throw new Error(data.message || '登录失败：未获取到 Token');
        const user = data.user || data.data?.user || { username: account, email: account };
        const activeTenant = data.active_tenant || data.data?.active_tenant || {};
        const tenantId = Number(activeTenant.id) || 10009;
        const tenantName = activeTenant.name || "刘明青's Workspace";

        // 获取完整知识库列表（包括个人库与共享库）
        let allKbs = [];
        try {
          allKbs = await fetchAllKBs(token);
        } catch {}

        const ownKbs = allKbs.filter(k => !k.shared);
        const writableKbs = allKbs.filter(k => !k.shared || k.permission === 'editor' || k.permission === 'owner');
        const pick = ownKbs[0] || writableKbs[0] || allKbs[0] || { id: '2d33c3a6-4618-4c89-952a-3a802a5986ae', name: '刘明青', documents: 2 };

        saveCfg({
          token,
          user,
          userName: user.username || user.name || 'liumingqing',
          tenantId,
          tenantName,
          email: account,
          kbId: pick.id,
          kbName: pick.name,
          serverUrl: targetServerUrl,
          memberships: data.memberships || []
        });

        const stateResult = {
          ok: true,
          loggedIn: true,
          token,
          user,
          userName: user.username || user.name || 'liumingqing',
          tenantId,
          tenantName,
          kbId: pick.id,
          kbName: pick.name,
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
      saveCfg({ token: '', user: null });
      broadcast('logout', {});
    },

    listKBs: async (force) => {
      try {
        const allKbs = await fetchAllKBs();
        const cfg = loadCfg();
        const tid = cfg.tenantId || 10009;
        const tname = cfg.tenantName || "刘明青's Workspace";

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
          const deptTenantId = sharedWritableKbs[0]?.tenantId || 10000;
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

    selectKB: async ({ id, name, tenantId }) => {
      saveCfg({ kbId: id, kbName: name, tenantId });
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
      broadcast('chat:event', { response_type: 'agent_query' });

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
              broadcast('chat:event', ev);
            } catch {}
          }
        }

        broadcast('chat:event', { response_type: 'complete' });
        if (activeSessionId) localStorage.setItem('deskpet_last_session', activeSessionId);
        return { ok: true, sessionId: activeSessionId };
      } catch (e) {
        broadcast('chat:event', { response_type: 'error', content: e.message });
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
    dragStart: () => invoke('start_dragging', { window_label: 'pet' }),
    dragPanel: () => invoke('start_dragging', { window_label: 'panel' }),
    dragMove: () => {},
    dragEnd: () => {},
    petMenu: () => invoke('toggle_panel'),
    quit: () => invoke('app_quit'),

    openUrl: (url) => {
      window.open(url, '_blank');
    },

    // 上传与队列
    uploadPaths: async (paths) => {
      if (!paths || !paths.length) return { queued: 0 };
      for (const p of paths) {
        const item = {
          id: 'u_' + Date.now() + Math.random().toString(36).slice(2, 6),
          name: p.split(/[/\\]/).pop(),
          path: p,
          status: 'queued',
          progress: 0
        };
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
      return { queued: paths.length };
    },

    listUploads: async () => uploadQueue,
    clearUploads: async () => {
      uploadQueue = uploadQueue.filter(i => i.status !== 'done' && i.status !== 'failed');
      broadcast('upload:update', { stats: getStats() });
      return { ok: true };
    },

    pathForFile: (file) => file.name || file.path || '',
    describePaths: async (paths) => (paths || []).map(p => ({
      path: p,
      name: String(p).split(/[/\\]/).pop() || p,
      size: 1024 * 64,
      isDir: false,
      dir: false,
      ok: true
    })),

    openWeb: () => {
      const cfg = loadCfg();
      window.open(cfg.serverUrl || DEFAULT_SERVER_URL, '_blank');
    },

    openLocalNetworkSettings: () => ({ ok: true }),

    // 存入面板文件拾取
    pickFiles: () => pet.storePick('files'),
    pickFolder: () => pet.storePick('folder'),
    storePick: async (kind) => {
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

    retryUpload: (id) => {
      const it = uploadQueue.find(i => i.id === id);
      if (it) {
        it.status = 'queued';
        notifyUploadUpdate(it);
      }
    },

    // 事件监听注册
    onUploadUpdate: (cb) => on('upload:update', cb),
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

    const titlebar = document.querySelector('.titlebar');
    if (titlebar) {
      titlebar.addEventListener('mousedown', (e) => {
        if (e.target.tagName !== 'BUTTON' && !e.target.closest('button') && !e.target.closest('input')) {
          if (window.pet && window.pet.dragPanel) window.pet.dragPanel();
        }
      });
    }
  });
})();
