const $ = (id) => document.getElementById(id)

const el = {
  loginView: $('loginView'),
  mainView: $('mainView'),
  inServer: $('inServer'),
  inEmail: $('inEmail'),
  inPass: $('inPass'),
  btnLogin: $('btnLogin'),
  loginErr: $('loginErr'),
  btnNetDiag: $('btnNetDiag'),
  btnLocalNet: $('btnLocalNet'),
  kbPick: $('kbPick'),
  kbBtn: $('kbBtn'),
  kbName: $('kbName'),
  kbWhere: $('kbWhere'),
  kbMenu: $('kbMenu'),
  kbMeta: $('kbMeta'),
  chat: $('chat'),
  chatEmpty: $('chatEmpty'),
  queueWrap: $('queueWrap'),
  queue: $('queue'),
  queueTitle: $('queueTitle'),
  input: $('input'),
  btnSend: $('btnSend'),
  btnStore: $('btnStore'),
  storeHint: $('storeHint'),
  storeSheet: $('storeSheet'),
  storeDrop: $('storeDrop'),
  storeList: $('storeList'),
  storeCount: $('storeCount'),
  storeCommit: $('storeCommit'),
  storeCancel: $('storeCancel'),
  btnCloseStore: $('btnCloseStore'),
  dropLayer: $('dropLayer'),
  attachStrip: $('attachStrip'),
  longHint: $('longHint'),
  moreMenu: $('moreMenu'),
  textModal: $('textModal'),
  toast: $('toast'),
  // 会话历史
  sidebar: $('sidebar'),
  sideBackdrop: $('sideBackdrop'),
  btnToggleSidebar: $('btnToggleSidebar'),
  btnSideNew: $('btnSideNew'),
  sessionSearch: $('sessionSearch'),
  sessionList: $('sessionList'),
  sessionEmpty: $('sessionEmpty'),
  sideUser: $('sideUser'),
  sideTenant: $('sideTenant'),
  appVer: $('appVer'),
  btnUpdate: $('btnUpdate'),
  updLabel: $('updLabel'),
  updDot: $('updDot'),
  updModal: $('updModal'),
  updTitle: $('updTitle'),
  updMeta: $('updMeta'),
  updNotes: $('updNotes'),
  updBarWrap: $('updBarWrap'),
  updBar: $('updBar'),
  updTip: $('updTip'),
  updGo: $('updGo'),
  updLater: $('updLater'),
  sessionMenu: $('sessionMenu'),
  confirmModal: $('confirmModal'),
  confirmTitle: $('confirmTitle'),
  confirmBody: $('confirmBody')
}

let state = null
let currentKB = ''
let currentTenant = 0
let kbGroups = []
// 问答范围 = 当前工作区全部知识库，跟 currentKB（上传目标）不是一回事
let askScope = null
let switching = false
let busy = false
let stream = null

// 存入面板里攒着的东西：点了「存入」才真的上传。
// 这样「拖进来」和「存进库」不再是同一件事。
const shelf = []
let shelfSeq = 0
// 本轮提问的临时附件：只对这一问生效，不进任何知识库
let attachList = []

// 会话历史状态。items 是已加载的页拼起来的；page 是「下一次要请求的页码」。
const sessions = {
  items: [],
  total: 0,
  page: 1,
  size: 20,
  keyword: '',
  loading: false,
  activeId: '',
  open: true,     // 宽窗口下侧栏是否展开（落盘）
  drawer: false   // 窄窗口下抽屉是否打开（不落盘，每次启动都是关的）
}

/* ---------------- 通用 ---------------- */

function toast(text, kind = '') {
  el.toast.textContent = text
  el.toast.className = 'toast' + (kind === 'warn' ? ' warn' : '')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), 2600)
}

function show(view) {
  el.loginView.classList.toggle('hidden', view !== 'login')
  el.mainView.classList.toggle('hidden', view !== 'main')
  applySidebar()
}

/* ---------------- 会话历史 ---------------- */

const NARROW = 660 // 窗口窄于这个宽度，侧栏改成抽屉

function applySidebar() {
  const logged = !!(state && state.loggedIn)
  const narrow = window.innerWidth < NARROW
  const shown = narrow ? sessions.drawer : sessions.open
  el.sidebar.classList.toggle('hidden', !logged)
  el.btnToggleSidebar.classList.toggle('hidden', !logged)
  el.sidebar.classList.toggle('drawer', narrow)
  el.sidebar.classList.toggle('open', narrow && shown)
  el.sidebar.classList.toggle('collapsed', !narrow && !shown)
  el.sideBackdrop.classList.toggle('hidden', !(logged && narrow && shown))
}

/** 用户主动开合：宽窗口记配置；窄窗口只开抽屉，不动配置 */
function toggleSidebar(force) {
  const narrow = window.innerWidth < NARROW
  if (narrow) {
    sessions.drawer = typeof force === 'boolean' ? force : !sessions.drawer
  } else {
    sessions.open = typeof force === 'boolean' ? force : !sessions.open
    try {
      if (window.pet.setSidebarOpen) window.pet.setSidebarOpen(sessions.open)
    } catch {}
  }
  applySidebar()
}

function closeDrawerIfNarrow() {
  if (window.innerWidth < NARROW && sessions.drawer) {
    sessions.drawer = false
    applySidebar()
  }
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function sessionTime(iso) {
  const t = new Date(iso)
  if (!iso || Number.isNaN(t.getTime())) return ''
  const now = new Date()
  const sameDay = t.toDateString() === now.toDateString()
  if (sameDay) return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`
  const y = new Date(now.getTime() - 86400000)
  if (t.toDateString() === y.toDateString()) return '昨天'
  return `${t.getMonth() + 1}-${pad2(t.getDate())}`
}

function sessionGroup(iso) {
  const t = new Date(iso)
  if (!iso || Number.isNaN(t.getTime())) return '更早'
  const now = new Date()
  if (t.toDateString() === now.toDateString()) return '今天'
  const y = new Date(now.getTime() - 86400000)
  if (t.toDateString() === y.toDateString()) return '昨天'
  const week = new Date(now.getTime() - 7 * 86400000)
  if (t >= week) return '本周'
  return '更早'
}

function showChatEmpty(title, sub) {
  el.chat.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'empty'
  box.id = 'chatEmpty'
  const t = document.createElement('div')
  t.className = 'empty-title'
  t.textContent = title
  const s = document.createElement('div')
  s.className = 'empty-sub'
  s.textContent = sub || ''
  box.appendChild(t)
  if (sub) box.appendChild(s)
  el.chat.appendChild(box)
  el.chatEmpty = box
}

function skeleton(rows = 5) {
  const box = document.createElement('div')
  box.className = 'side-skel'
  for (let i = 0; i < rows; i++) box.appendChild(document.createElement('i'))
  return box
}

function renderSessions() {
  const list = el.sessionList
  list.innerHTML = ''
  if (sessions.loading && !sessions.items.length) {
    list.appendChild(skeleton())
    el.sessionEmpty.classList.add('hidden')
    return
  }
  if (!sessions.items.length) {
    el.sessionEmpty.classList.remove('hidden')
    el.sessionEmpty.querySelector('div').textContent = sessions.keyword
      ? '没有匹配的会话'
      : '还没有会话'
    el.sessionEmpty.querySelector('.side-empty-sub').textContent = sessions.keyword
      ? '换个关键词试试'
      : '问点什么，这里会自动记下来'
    return
  }
  el.sessionEmpty.classList.add('hidden')

  let group = ''
  for (const s of sessions.items) {
    const g = s.pinned ? '置顶' : sessionGroup(s.updatedAt)
    if (g !== group) {
      const h = document.createElement('div')
      h.className = 'side-group'
      h.textContent = g
      list.appendChild(h)
      group = g
    }
    list.appendChild(sessionRow(s))
  }
  // 还有下一页时，底部给个可点击的「加载更多」，滚动也会触发
  if (sessions.items.length < sessions.total) {
    const more = document.createElement('div')
    more.className = 'side-group'
    more.style.textAlign = 'center'
    more.textContent = sessions.loading ? '加载中…' : '加载更多'
    more.addEventListener('click', () => loadSessions())
    list.appendChild(more)
  }
}

function sessionRow(s) {
  const row = document.createElement('div')
  row.className = 'side-item' + (s.id === sessions.activeId ? ' active' : '')
  row.dataset.id = s.id
  row.setAttribute('role', 'listitem')

  const t = document.createElement('span')
  t.className = 't'
  t.textContent = s.title || '未命名会话'
  t.title = s.title || '未命名会话'

  const tm = document.createElement('span')
  tm.className = 'tm'
  tm.textContent = sessionTime(s.updatedAt)

  const more = document.createElement('button')
  more.className = 'more'
  more.type = 'button'
  more.textContent = '⋯'
  more.title = '重命名 / 置顶 / 删除'
  more.addEventListener('click', (e) => {
    e.stopPropagation()
    openSessionMenu(s, more)
  })

  row.appendChild(t)
  row.appendChild(tm)
  row.appendChild(more)
  row.addEventListener('click', () => switchSession(s.id))
  return row
}

/** 行内重命名：Enter 提交，Esc 取消，失焦也算提交（和网页端习惯一致） */
function startRename(s) {
  const row = el.sessionList.querySelector(`.side-item[data-id="${CSS.escape(s.id)}"]`)
  if (!row) return
  const input = document.createElement('input')
  input.className = 'rename'
  input.value = s.title || ''
  input.placeholder = '会话标题'
  row.innerHTML = ''
  row.appendChild(input)
  input.focus()
  input.select()

  let done = false
  const finish = async (ok) => {
    if (done) return
    done = true
    const v = input.value.trim()
    if (!ok || !v || v === (s.title || '')) {
      renderSessions()
      return
    }
    const r = await window.pet.renameSession({ id: s.id, title: v })
    if (!r.ok) {
      toast(r.error || '重命名失败', 'warn')
      renderSessions()
      return
    }
    s.title = v
    renderSessions()
    toast('已重命名')
  }
  input.addEventListener('click', (e) => e.stopPropagation())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(true))
}

let menuTarget = null

function openSessionMenu(s, anchor) {
  menuTarget = s
  const pin = $('smiPin')
  pin.textContent = s.pinned ? '取消置顶' : '置顶'
  el.sessionMenu.classList.remove('hidden')
  const r = anchor.getBoundingClientRect()
  const w = 132
  el.sessionMenu.style.left = `${Math.max(8, Math.min(r.right + 4, window.innerWidth - w - 8))}px`
  el.sessionMenu.style.top = `${r.bottom + 4}px`
}

function hideSessionMenu() {
  el.sessionMenu.classList.add('hidden')
  menuTarget = null
}

let confirmResolve = null

function confirmBox(title, body, okText = '删除') {
  el.confirmTitle.textContent = title
  el.confirmBody.textContent = body
  $('confirmOk').textContent = okText
  el.confirmModal.classList.remove('hidden')
  return new Promise((resolve) => {
    confirmResolve = resolve
  })
}

$('confirmCancel').addEventListener('click', () => {
  el.confirmModal.classList.add('hidden')
  if (confirmResolve) confirmResolve(false)
  confirmResolve = null
})

$('confirmOk').addEventListener('click', () => {
  el.confirmModal.classList.add('hidden')
  if (confirmResolve) confirmResolve(true)
  confirmResolve = null
})

$('smiRename').addEventListener('click', (e) => {
  e.stopPropagation()
  const s = menuTarget
  hideSessionMenu()
  if (s) startRename(s)
})

$('smiPin').addEventListener('click', async (e) => {
  e.stopPropagation()
  const s = menuTarget
  hideSessionMenu()
  if (!s) return
  const r = await window.pet.pinSession({ id: s.id, pinned: !s.pinned })
  if (!r.ok) return toast(r.error || '操作失败', 'warn')
  await loadSessions({ reset: true })
  toast(s.pinned ? '已取消置顶' : '已置顶')
})

$('smiDelete').addEventListener('click', async (e) => {
  e.stopPropagation()
  const s = menuTarget
  hideSessionMenu()
  if (!s) return
  const ok = await confirmBox(
    '删除会话',
    `「${s.title || '未命名会话'}」将被删除，对话记录无法恢复。`,
    '删除'
  )
  if (!ok) return
  const r = await window.pet.deleteSession(s.id)
  if (!r.ok) return toast(r.error || '删除失败', 'warn')
  if (sessions.activeId === s.id) {
    sessions.activeId = ''
    showChatEmpty('新对话', '问点什么？我会翻遍本工作区的知识库')
  }
  await loadSessions({ reset: true })
  toast('已删除')
})

el.sessionMenu.addEventListener('click', (e) => e.stopPropagation())
document.addEventListener('click', () => hideSessionMenu())

let pendingReload = false

async function loadSessions({ reset = false } = {}) {
  if (!state || !state.loggedIn) return
  // 正在加载时来的「重置」请求（比如边加载边搜）不能直接丢掉，记下来稍后补跑
  if (sessions.loading) {
    if (reset) pendingReload = true
    return
  }
  sessions.loading = true
  if (reset) {
    sessions.page = 1
    sessions.items = []
  }
  renderSessions()
  const page = sessions.page
  const r = await window.pet.listSessions({
    page,
    pageSize: sessions.size,
    keyword: sessions.keyword
  })
  sessions.loading = false
  if (!r.ok) {
    toast(r.error || '会话列表读取失败', 'warn')
    renderSessions()
  } else {
    sessions.total = r.total || 0
    sessions.items = reset ? r.items : sessions.items.concat(r.items)
    if (r.items.length) sessions.page = page + 1
    renderSessions()
  }
  if (pendingReload) {
    pendingReload = false
    loadSessions({ reset: true })
  }
}

let sessRefreshTimer = 0

/** 首问之后服务端会异步生成标题，隔一会儿再拉一次列表把标题刷出来 */
function scheduleSessionRefresh(delay = 1600) {
  clearTimeout(sessRefreshTimer)
  sessRefreshTimer = setTimeout(() => {
    if (!busy) loadSessions({ reset: true })
  }, delay)
}

function renderHistory(messages) {
  el.chat.innerHTML = ''
  if (!messages.length) {
    showChatEmpty('这条会话还没有内容', '在下面继续问点什么吧')
    return
  }
  for (const m of messages) {
    if (m.role === 'user') {
      addUser(m.content)
      continue
    }
    const s = addAssistantStatic()
    s.text.innerHTML = mdToHtml(m.content || '（没有内容）')
    if (m.refs && m.refs.length) renderRefs(s, m.refs)
  }
  scrollToBottom()
}

async function switchSession(id, { silent = false } = {}) {
  if (!id) return
  if (busy) {
    toast('正在回答，请稍候')
    return
  }
  clearAttachments(true)
  if (!silent && id === sessions.activeId && el.chat && el.chat.children.length > 0) {
    closeDrawerIfNarrow()
    return
  }
  const r = await window.pet.loadSession(id)
  if (!r.ok) {
    if (r.gone) {
      sessions.activeId = ''
      showChatEmpty('新对话', '问点什么？我会翻遍本工作区的知识库')
      await loadSessions({ reset: true })
    }
    toast(r.error || '会话读取失败', 'warn')
    return
  }
  sessions.activeId = id
  renderSessions()
  renderHistory(r.messages)
  closeDrawerIfNarrow()
}

async function newChat() {
  if (busy) {
    toast('正在回答，请稍候')
    return
  }
  clearAttachments(true)
  await window.pet.newSession()
  sessions.activeId = ''
  renderSessions()
  showChatEmpty('新对话', '问点什么？我会翻遍本工作区的知识库')
  el.input.focus()
  closeDrawerIfNarrow()
}

async function initSessions() {
  sessions.open = state.sidebarOpen !== false
  el.sideUser.textContent = state.userName || state.email || ''
  el.sideTenant.textContent = state.tenantName || ''
  applySidebar()
  await loadSessions({ reset: true })
  const cur = await window.pet.currentSession()
  if (cur && cur.id) await switchSession(cur.id, { silent: true })
}

/* ---------------- 启动 ---------------- */

async function init() {
  initVersion()
  state = await window.pet.state()
  el.inServer.value = state.serverUrl || 'https://knowledge.xinyeonline.com.cn'
  el.inEmail.value = state.email || ''
  if (state.loggedIn) {
    await enterMain()
    // 启动后静默探一次新版本：只在按钮上点个红点，不弹窗不打扰
    setTimeout(() => checkUpdate({ silent: true }), 2500)
  } else {
    show('login')
    el.inEmail.focus()
    // 先静默探一次内网：macOS 的「本地网络」授权弹窗只会在真正发起局域网
    // 连接时出现，早点触发，用户填完账号点登录时就不会卡在这里。
    if (window.pet.netDiag) {
      setTimeout(() => Promise.resolve(window.pet.netDiag(el.inServer.value.trim())).catch(() => {}), 600)
    }
  }
}

async function enterMain() {
  show('main')
  currentKB = state.kbId || ''
  currentTenant = Number(state.tenantId) || 0
  await refreshKBs()
  const ups = await window.pet.listUploads()
  // 必须回填 queueItems：否则重开面板时列表画的是旧数组，下一次 upload:update
  // 只会渲染「新来的那一条」，之前的历史看起来凭空消失了。
  queueItems = Array.isArray(ups) ? ups : []
  renderQueue(queueItems)
  await initSessions()
}

const ROLE_TEXT = {
  owner: '创建者',
  admin: '管理员',
  editor: '可编辑',
  viewer: '只读',
  member: '成员'
}

function flatKBs() {
  return kbGroups.flatMap((g) =>
    g.kbs.map((k) => ({ ...k, tenantId: g.tenantId, tenantName: g.tenantName }))
  )
}

async function refreshKBs(force = false) {
  const r = await window.pet.listKBs(force)
  if (!r.ok) {
    el.kbName.textContent = '知识库读取失败'
    el.kbWhere.textContent = ''
    el.kbMeta.textContent = ''
    renderKBMenu([])
    toast(r.error || '知识库列表拉取失败', 'warn')
    return
  }
  kbGroups = r.groups || []
  askScope = r.ask || null
  const all = flatKBs()
  if (!all.length) {
    el.kbName.textContent = '没有可用知识库'
    el.kbWhere.textContent = ''
    el.kbMeta.textContent = '找管理员开通'
    renderKBMenu([])
    return
  }
  let cur = all.find((k) => k.id === currentKB)
  if (!cur) {
    // 上次选的库被删了 / 换了账号：挑文档最多的那个，静默落定
    cur = all.slice().sort((a, b) => (b.documents || 0) - (a.documents || 0))[0]
  }
  currentKB = cur.id
  currentTenant = Number(cur.tenantId) || 0
  applyKBLabel(cur)
  renderKBMenu(all)
  renderScope()
  if (cur.id !== (state && state.kbId)) await window.pet.selectKB({ id: cur.id, name: cur.name, tenantId: cur.tenantId })
}

function applyKBLabel(kb) {
  el.kbName.textContent = kb.name || '未选择知识库'
  el.kbWhere.textContent = kbGroups.length > 1 ? kb.tenantName || '' : ''
  el.kbBtn.title = kb.tenantName
    ? `上传到：${kb.tenantName} / ${kb.name}（提问不受限，会翻遍本工作区所有库）`
    : `上传到：${kb.name}（提问不受限，会翻遍本工作区所有库）`
}

/** 顶部右侧：说明问答到底覆盖了几个库，别让人以为只查选中的那个 */
function renderScope() {
  const n = (askScope && askScope.count) || 0
  if (!n) {
    el.kbMeta.textContent = ''
    return
  }
  const total = (askScope && askScope.total) || n
  el.kbMeta.textContent = n < total ? `回答基于 ${n}/${total} 个库` : `回答基于全部 ${n} 个库`
  el.kbMeta.title = `会同时检索：\n${(askScope.names || []).join('\n')}` +
    (n < total ? '\n（空库不参与检索）' : '')
  const sub = el.chatEmpty && el.chatEmpty.querySelector('.empty-sub')
  if (sub && !el.chatEmpty.classList.contains('hidden')) {
    const names = (askScope.names || []).slice(0, 3).join('、')
    const more = (askScope.names || []).length > 3 ? ' 等' : ''
    sub.textContent = `覆盖本工作区的 ${names}${more}，共 ${n} 个库`
  }
}

function renderKBMenu(all) {
  el.kbMenu.innerHTML = ''
  if (!kbGroups.length) {
    const e = document.createElement('div')
    e.className = 'kb-empty'
    e.textContent = '还没有可用的知识库'
    el.kbMenu.appendChild(e)
    return
  }
  const multi = kbGroups.length > 1
  for (const g of kbGroups) {
    const box = document.createElement('div')
    box.className = 'kb-group'

    if (multi || !g.kbs.length) {
      const head = document.createElement('div')
      head.className = 'kb-group-head'
      const hn = document.createElement('span')
      hn.textContent = g.tenantName || '工作区'
      const role = document.createElement('span')
      role.className = 'role'
      role.textContent = ROLE_TEXT[g.role] || g.role || ''
      head.append(hn, role)
      box.appendChild(head)
    }

    if (!g.kbs.length) {
      const e = document.createElement('div')
      e.className = 'kb-empty'
      e.textContent = g.error ? `读取失败：${g.error}` : '这个空间还没有知识库'
      box.appendChild(e)
    }

    for (const kb of g.kbs) {
      const on = kb.id === currentKB
      const b = document.createElement('button')
      b.className = 'kb-item' + (on ? ' on' : '')
      b.setAttribute('role', 'option')
      b.setAttribute('aria-selected', on ? 'true' : 'false')
      b.dataset.id = kb.id
      b.dataset.tenant = g.tenantId

      const n = document.createElement('span')
      n.className = 'n'
      n.textContent = kb.name
      const c = document.createElement('span')
      c.className = 'c'
      c.textContent = `${kb.documents || 0} 篇`
      const tick = document.createElement('span')
      tick.className = 'tick'
      tick.textContent = on ? '✓' : ''
      b.append(n, c, tick)

      b.addEventListener('click', () =>
        pickKB({ id: kb.id, name: kb.name, tenantId: g.tenantId, tenantName: g.tenantName })
      )
      box.appendChild(b)
    }
    el.kbMenu.appendChild(box)
  }
}

function openKBMenu() {
  if (switching) return
  el.kbMenu.classList.remove('hidden')
  el.kbBtn.setAttribute('aria-expanded', 'true')
  const on = el.kbMenu.querySelector('.kb-item.on')
  if (on) on.scrollIntoView({ block: 'nearest' })
}

function closeKBMenu() {
  el.kbMenu.classList.add('hidden')
  el.kbBtn.setAttribute('aria-expanded', 'false')
}

function isKBMenuOpen() {
  return !el.kbMenu.classList.contains('hidden')
}

/** 切库：跨工作区时主进程会顺手把 token 换过去 */
async function pickKB(kb) {
  if (switching) return
  const sameTenant = Number(kb.tenantId) === currentTenant
  if (kb.id === currentKB && sameTenant) {
    closeKBMenu()
    return
  }
  if (busy) {
    closeKBMenu()
    toast('这条回答还没结束，等它答完再切', 'warn')
    return
  }
  switching = true
  el.kbBtn.disabled = true
  const prevName = el.kbName.textContent
  el.kbName.textContent = '切换中…'
  const r = await window.pet.selectKB({ id: kb.id, name: kb.name, tenantId: kb.tenantId })
  switching = false
  el.kbBtn.disabled = false
  if (!r || !r.ok) {
    el.kbName.textContent = prevName
    toast((r && r.error) || '切换知识库失败', 'warn')
    return
  }
  state = { ...state, ...r }
  askScope = r.ask || askScope
  const movedWorkspace = !sameTenant
  currentKB = kb.id
  currentTenant = Number(kb.tenantId) || 0
  applyKBLabel(kb)
  renderKBMenu(flatKBs())
  renderScope()
  renderShelf()
  closeKBMenu()

  if (movedWorkspace) {
    // 换空间是真换了检索范围（token 也换了），对话得重开
    resetChatSurface(
      `已切到「${kb.tenantName || '另一个空间'}」`,
      `${kb.name} · 上传进这个库；回答改看这个空间的 ${(askScope && askScope.count) || 0} 个库`
    )
    renderScope()
    queueItems = await window.pet.listUploads()
    renderQueue(queueItems)
    toast(`已切换到 ${kb.tenantName || ''} · ${kb.name}`)
  } else {
    // 同空间内换库只影响上传，问答范围没变，对话不用清
    toast(`上传目标已切到 ${kb.name}`)
  }
}

function resetChatSurface(title, sub) {
  el.chat.innerHTML = ''
  const empty = document.createElement('div')
  empty.className = 'empty'
  empty.id = 'chatEmpty'
  const t = document.createElement('div')
  t.className = 'empty-title'
  t.textContent = title
  const s = document.createElement('div')
  s.className = 'empty-sub'
  s.textContent = sub
  empty.append(t, s)
  el.chat.appendChild(empty)
  el.chatEmpty = empty
  stream = null
}

/** 刷新问答范围（走主进程 60s 缓存，不重扫全部空间） */
async function refreshKnowledgeMeta() {
  const r = await window.pet.listKBs()
  if (!r.ok) return
  kbGroups = r.groups || kbGroups
  askScope = r.ask || askScope
  renderKBMenu(flatKBs())
  renderScope()
}

/* ---------------- 登录 ---------------- */

// 网络自检：一次 /health 探活，把「权限问题 / 端口问题 / 超时」分清楚。
// macOS 15+ 最常见的是本地网络权限没给，连接在 socket 层就被拒。
async function runNetDiag(auto = false) {
  const serverUrl = el.inServer.value.trim()
  if (!serverUrl) {
    el.loginErr.textContent = '先填服务器地址'
    return
  }
  el.btnNetDiag.disabled = true
  el.btnNetDiag.textContent = '正在检测…'
  const r = await window.pet.netDiag(serverUrl)
  el.btnNetDiag.disabled = false
  el.btnNetDiag.textContent = '连不上？网络自检'

  if (r && r.ok) {
    el.loginErr.textContent = r.hint || '网络正常'
    el.btnLocalNet.classList.add('hidden')
    return
  }
  const code = (r && r.code) || 'unknown'
  el.loginErr.textContent = `${(r && r.hint) || '连不上'}${auto ? '' : `（${code}）`}`
  el.btnLocalNet.classList.toggle('hidden', !(r && r.needLocalNetwork))
}

el.btnNetDiag.addEventListener('click', () => runNetDiag(false))

el.btnLocalNet.addEventListener('click', async () => {
  const r = await window.pet.openLocalNetworkSettings()
  if (!r || !r.ok) {
    el.loginErr.textContent = '打不开系统设置：请手动去「系统设置 → 隐私与安全性 → 本地网络」勾选「知识小助」，然后完全退出重开'
  }
})

el.btnLogin.addEventListener('click', async () => {
  const serverUrl = el.inServer.value.trim()
  const email = el.inEmail.value.trim()
  const password = el.inPass.value
  if (!serverUrl || !email || !password) {
    el.loginErr.textContent = '三项都要填'
    return
  }
  el.btnLogin.disabled = true
  el.loginErr.textContent = '正在登录…'
  el.btnLocalNet.classList.add('hidden')
  const r = await window.pet.login({ serverUrl, email, password })
  el.btnLogin.disabled = false
  if (!r.ok) {
    el.loginErr.textContent = r.error || '登录失败'
    // 网络类错误直接跑一次自检，省得用户干瞪眼
    if (r.code === 'network') runNetDiag(true)
    return
  }
  el.loginErr.textContent = ''
  el.inPass.value = ''
  state = r
  if (!r.kbs || !r.kbs.length) {
    toast('登录成功，但你还看不到知识库，找管理员开通', 'warn')
  }
  await enterMain()
})

el.inPass.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnLogin.click()
})

/* ---------------- 知识库切换 ---------------- */

el.kbBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  if (el.kbBtn.disabled) return
  if (isKBMenuOpen()) closeKBMenu()
  else openKBMenu()
})

el.kbBtn.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!isKBMenuOpen()) openKBMenu()
    const items = [...el.kbMenu.querySelectorAll('.kb-item')]
    const on = el.kbMenu.querySelector('.kb-item.on') || items[0]
    if (on) on.focus()
  }
})

el.kbMenu.addEventListener('keydown', (e) => {
  const items = [...el.kbMenu.querySelectorAll('.kb-item')]
  if (!items.length) return
  const i = items.indexOf(document.activeElement)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    items[Math.min(i + 1, items.length - 1)].focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    items[Math.max(i - 1, 0)].focus()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeKBMenu()
    el.kbBtn.focus()
  }
})

document.addEventListener('click', (e) => {
  if (!el.kbPick.contains(e.target)) closeKBMenu()
})

$('btnRefreshKB').addEventListener('click', async (e) => {
  e.stopPropagation()
  toast('正在刷新知识库…')
  await refreshKBs(true)
  toast('已刷新')
})

/* ---------------- 聊天 ---------------- */

function hideEmpty() {
  if (el.chatEmpty) el.chatEmpty.classList.add('hidden')
}

function nearBottom() {
  return el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < 80
}

function scrollToBottom() {
  el.chat.scrollTop = el.chat.scrollHeight
}

function addUser(text, files) {
  hideEmpty()
  const wrap = document.createElement('div')
  wrap.className = 'msg user'
  const b = document.createElement('div')
  b.className = 'bubble-q'
  b.textContent = text
  wrap.appendChild(b)
  if (files && files.length) {
    const f = document.createElement('div')
    f.className = 'msg-files'
    f.textContent = '用附件：' + files.join('、')
    f.title = '这些文件只对这一问生效，没有存进任何知识库'
    wrap.appendChild(f)
  }
  el.chat.appendChild(wrap)
  scrollToBottom()
}

function addAssistant() {
  hideEmpty()
  const wrap = document.createElement('div')
  wrap.className = 'msg'
  const b = document.createElement('div')
  b.className = 'bubble-a'
  const status = document.createElement('div')
  status.className = 'status'
  const n = (askScope && askScope.count) || 0
  status.textContent = n > 1 ? `正在检索 ${n} 个知识库…` : '正在检索知识库…'
  const text = document.createElement('span')
  b.appendChild(status)
  b.appendChild(text)
  const refs = document.createElement('div')
  refs.className = 'refs'
  b.appendChild(refs)
  wrap.appendChild(b)
  el.chat.appendChild(wrap)
  scrollToBottom()
  return { wrap, b, status, text, refs, refData: [], finished: false }
}

/** 历史消息用：不要「正在检索…」占位，直接是成品气泡 */
function addAssistantStatic() {
  hideEmpty()
  const wrap = document.createElement('div')
  wrap.className = 'msg'
  const b = document.createElement('div')
  b.className = 'bubble-a'
  const text = document.createElement('span')
  b.appendChild(text)
  const refs = document.createElement('div')
  refs.className = 'refs'
  b.appendChild(refs)
  wrap.appendChild(b)
  el.chat.appendChild(wrap)
  return { wrap, b, status: null, text, refs, refData: [], finished: true }
}

function renderRefs(s, refs) {
  s.refData = refs || []
  s.refs.innerHTML = ''
  // 引用正文是 refs 的兄弟节点，innerHTML 清不掉，必须显式摘掉
  if (s.refBody) {
    s.refBody.remove()
    s.refBody = null
  }
  s.refData.slice(0, 6).forEach((r, i) => {
    const chip = document.createElement('button')
    chip.className = 'ref-chip'
    chip.textContent = `[${i + 1}] ${r.knowledge_title || '片段'}`
    chip.title = '点开看原文'
    chip.addEventListener('click', () => toggleRefBody(s, i))
    s.refs.appendChild(chip)
  })
}

function toggleRefBody(s, i) {
  // ref-body 插在 .refs 之后，是兄弟节点；s.refs.querySelector 永远找不到它，
  // 曾经导致每点一次 chip 就多插一份（v0.8.4 及之前的 bug）
  if (s.refBody) {
    const same = s.refBody.dataset.idx === String(i)
    s.refBody.remove()
    s.refBody = null
    if (same) return
  }
  const r = s.refData[i]
  const body = document.createElement('div')
  body.className = 'ref-body'
  body.dataset.idx = String(i)
  // 片段原文同样走 Markdown 渲染（mdToHtml 先转义，安全）；在 .bubble-a 内，样式复用
  body.innerHTML = mdToHtml((r.content || '').slice(0, 1200))
  s.refs.after(body)
  s.refBody = body
}

function renderRefusal(query, kbCount) {
  hideEmpty()
  const wrap = document.createElement('div')
  wrap.className = 'msg'
  const card = document.createElement('div')
  card.className = 'refuse'
  const where = kbCount > 1 ? `这个工作区的 ${kbCount} 个知识库` : '知识库'
  card.innerHTML = `<div>${where}里都没找到跟这个问题相关的内容。</div>
    <div class="row">
      <button class="link-btn" data-act="upload">存一份相关资料</button>
      <button class="link-btn" data-act="rephrase">换个问法</button>
    </div>`
  // 不再直接上传：先拉开存入面板，让他看清存的是什么、存到哪
  card.querySelector('[data-act="upload"]').addEventListener('click', () => openStore())
  card.querySelector('[data-act="rephrase"]').addEventListener('click', () => {
    el.input.value = query
    el.input.focus()
  })
  wrap.appendChild(card)
  el.chat.appendChild(wrap)
  scrollToBottom()
}

/**
 * Markdown 渲染（完整版）：先整篇转义再生成标签，杜绝模型输出造成注入。
 * 支持：标题、粗斜体、删除线、行内代码、代码块、有序/无序列表（含缩进层级）、
 * 引用、分隔线、表格、链接（http/https，点击交给系统浏览器）。
 */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function safeHref(url) {
  const u = String(url || '').trim()
  return /^https?:\/\//i.test(u) ? u : ''
}

/** 行内元素：调用方保证传入的文本已转义 */
function mdInline(t) {
  const codes = []
  // 行内代码先占位，里面的 **、[] 不再参与解析
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    codes.push('<code>' + c + '</code>')
    return '\u0000' + (codes.length - 1) + '\u0000'
  })
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    const h = safeHref(url)
    return h ? '<a class="md-link" href="' + h + '" title="图片链接，点击在浏览器打开">' + alt + ' 🖼</a>' : alt
  })
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const h = safeHref(url)
    return h ? '<a class="md-link" href="' + h + '">' + text + '</a>' : text + '（' + url + '）'
  })
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[\s(（[>，。；：、])\*([^*\n]+)\*(?=$|[\s)），。；：、.,!?])/g, '$1<em>$2</em>')
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i])
  return t
}

function mdToHtml(src) {
  let text = String(src || '')
    .replace(/<kb\b[^>]*\/?>/gi, '')
    .replace(/<\/?kb\b[^>]*>/gi, '')
    .replace(/\r/g, '')
  const lines = text.split('\n')
  const out = []
  let i = 0

  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}[-\s|:]*\|?\s*$/.test(l) && l.includes('-') && (l.includes('|') || l.includes(':'))
  const liLevel = (l) => Math.min(3, Math.floor((l.match(/^\s*/)[0].length || 0) / 2))

  while (i < lines.length) {
    const line = lines[i]

    // 代码块（流式期间允许未闭合：余下全部当代码）
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim()
      const body = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++ // 跳过闭合 ```
      out.push(
        '<div class="md-code">' +
          (lang ? '<div class="md-code-lang">' + escapeHtml(lang) + '</div>' : '') +
          '<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre></div>'
      )
      continue
    }

    // 分隔线
    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      out.push('<div class="md-hr"></div>')
      i++
      continue
    }

    // 标题 # ~ ######（# 和 ## 都按 h2 处理，聊天里没有比它更大的层级）
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const cls = h[1].length <= 2 ? 'md-h2' : h[1].length === 3 ? 'md-h3' : 'md-h4'
      out.push('<div class="' + cls + '">' + mdInline(escapeHtml(h[2])) + '</div>')
      i++
      continue
    }

    // 表格：当前行含 |，下一行是 |---|---| 分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      out.push(
        '<table class="md-table"><thead><tr>' +
          head.map((c) => '<th>' + mdInline(escapeHtml(c)) + '</th>').join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(escapeHtml(c)) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table>'
      )
      continue
    }

    // 引用块（连续 > 行合并）
    if (/^\s*>\s?/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push('<div class="md-quote">' + mdInline(escapeHtml(body.join('\n'))).replace(/\n/g, '<br>') + '</div>')
      continue
    }

    // 列表（无序 / 有序，支持 2 空格一层的缩进）
    const li = line.match(/^(\s*)([-*·•]|\d+[.、)])\s+(.*)$/)
    if (li) {
      const ordered = /\d/.test(li[2])
      const level = liLevel(line)
      const items = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*·•]|\d+[.、)])\s+(.*)$/)
        if (!m) break
        items.push({ lv: liLevel(lines[i]), ordered: /\d/.test(m[2]), raw: m[2], text: m[3] })
        i++
        // 列表中间的续行（缩进的非列表行）并进上一项；顶格的 > ``` # 等一律不算续行
        while (i < lines.length && /^[ \t]/.test(lines[i]) && lines[i].trim() && !/^(\s*)([-*·•]|\d+[.、)])\s+/.test(lines[i])) {
          items[items.length - 1].text += ' ' + lines[i].trim()
          i++
        }
      }
      out.push(
        items
          .map(
            (it) =>
              '<div class="md-li lv' + it.lv + '">' +
              (it.ordered ? '<span class="md-li-n">' + escapeHtml(it.raw) + '</span> ' : '<span class="md-li-b">•</span> ') +
              mdInline(escapeHtml(it.text)) +
              '</div>'
          )
          .join('')
      )
      continue
    }

    // 空行
    if (!line.trim()) {
      i++
      continue
    }

    // 普通段落：连续行合并，行内软换行用 <br>
    const para = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*([-*_]\s*){3,}$/.test(lines[i]) &&
      !/^(\s*)([-*·•]|\d+[.、)])\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i])
      i++
    }
    out.push('<div class="md-p">' + mdInline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br>') + '</div>')
  }
  return out.join('')
}

function addLowConfidence(s) {
  if (s.lowConf) return
  const d = document.createElement('div')
  d.className = 'lowconf'
  d.textContent = '库里相关内容较少，这条答案建议点开引用核对原文'
  s.b.appendChild(d)
  s.lowConf = true
}

function renderError(text) {  hideEmpty()
  const wrap = document.createElement('div')
  wrap.className = 'msg'
  const card = document.createElement('div')
  card.className = 'refuse'
  card.textContent = text
  wrap.appendChild(card)
  el.chat.appendChild(wrap)
  scrollToBottom()
}

async function send() {
  const typed = el.input.value.trim()
  // 只挂了附件、没写问题：给一个能对上话的默认问法
  const query = typed || (attachList.length ? '这份文件讲了什么？' : '')
  if (!query || busy) return
  if (!state.loggedIn) return show('login')
  busy = true
  el.btnSend.disabled = true
  el.input.value = ''
  autoGrow()
  updateLongHint()
  try {
    window.pet.setPetState('thinking')
  } catch {}

  const files = attachList.slice()
  addUser(query, files.map((a) => a.name))
  const s = addAssistant()
  stream = s

  const r = await window.pet.ask({ query, attachmentIds: files.map((a) => a.id) })
  if (!s.finished) finishStream(s)
  if (!r.ok) {
    renderError(r.error || '问答失败')
  } else if (r.refused) {
    s.wrap.remove()
    renderRefusal(query, r.kbCount)
  } else if (r.references && r.references.length) {
    renderRefs(s, r.references)
  }
  if (r.ok && !r.refused) {
    // 附件只用一次：答完就撤掉，别让下一条问题带着它
    attachList = []
    renderAttachStrip()
    if (r.sessionId) sessions.activeId = r.sessionId
    renderSessions()
    // 首问之后服务端会异步生成标题，稍后再刷新一次列表
    scheduleSessionRefresh()
  }
  if (r.ok && !r.refused && r.lowConfidence) addLowConfidence(s)
  stream = null
  busy = false
  el.btnSend.disabled = false
  try {
    window.pet.setPetState('idle')
  } catch {}
  el.input.focus()
  try {
    window.pet.smokeDone()
  } catch {}
}

function finishStream(s) {
  s.finished = true
  if (s.status) {
    s.status.remove()
    s.status = null
  }
  if (!s.text.textContent.trim()) {
    s.text.textContent = '（没有返回内容）'
  }
}

el.btnSend.addEventListener('click', send)

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
})

// 回答里的链接一律交给系统浏览器，绝不在面板窗口内跳转
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a.md-link')
  if (!a) return
  e.preventDefault()
  window.pet.openUrl(a.href)
})

function autoGrow() {
  el.input.style.height = 'auto'
  el.input.style.height = Math.min(el.input.scrollHeight, 160) + 'px'
}
el.input.addEventListener('input', () => {
  autoGrow()
  updateLongHint()
})

/* 长文提示：只提示，不拦、不改提交行为。
   入口已经分开了，输入框里再长也还是一个「问题」；但值得提醒一句。 */
const LONG_TEXT = 400

function updateLongHint() {
  const long = el.input.value.trim().length >= LONG_TEXT
  const ok = !!(state && state.loggedIn)
  el.longHint.classList.toggle('hidden', !(long && ok))
}

$('longHintGo').addEventListener('click', () => {
  const body = el.input.value.trim()
  if (!body) return
  el.input.value = ''
  autoGrow()
  updateLongHint()
  openStore()
  stageText('粘贴的内容', body)
})

$('longHintNo').addEventListener('click', () => el.longHint.classList.add('hidden'))

/* ---------------- 附件（只对这一问生效，不进库） ---------------- */

function renderAttachStrip() {
  el.attachStrip.innerHTML = ''
  el.attachStrip.classList.toggle('hidden', !attachList.length)
  for (const a of attachList) {
    const chip = document.createElement('span')
    chip.className = 'attach-chip'
    const n = document.createElement('span')
    n.className = 'an'
    n.textContent = a.name
    n.title = '只对这一问生效，没有存进任何知识库'
    const x = document.createElement('button')
    x.className = 'ax'
    x.textContent = '✕'
    x.title = '移除'
    x.addEventListener('click', () => {
      attachList = attachList.filter((z) => z.key !== a.key)
      renderAttachStrip()
    })
    chip.append(n, x)
    el.attachStrip.appendChild(chip)
  }
}

/* 附件是会话级的：换会话/新对话之后，旧 ID 在服务端就查不到了，
   再拿去提问会报「attachment was not found in this session」。
   所以切会话时主动清掉，并告诉用户为什么。 */
function clearAttachments(notify) {
  if (!attachList.length) return
  attachList = []
  renderAttachStrip()
  if (notify) toast('换了会话，之前挂的附件已失效，重新拖一次就好', 'warn')
}

async function attachPaths(paths) {
  let added = 0
  for (const p of paths) {
    const name = String(p).split('/').pop() || p
    const r = await window.pet.uploadAttachment(p)
    if (!r || !r.ok) {
      toast((r && r.error) || `「${name}」没能读进来`, 'warn')
      continue
    }
    attachList.push({ key: 'a' + ++shelfSeq, id: r.id, name: r.name || name })
    added++
  }
  renderAttachStrip()
  if (added) {
    toast(`已挂上 ${added} 个附件，只对这一问生效`)
    el.input.focus()
  }
}

async function handleClipboardImage() {
  try {
    const r = await window.pet.tempImage()
    if (!r || !r.ok) return toast((r && r.error) || '剪贴板里没有图片', 'warn')
    if (isStoreOpen()) await stagePaths([r.path])
    else await attachPaths([r.path])
  } catch {
    toast('粘贴截图失败', 'warn')
  }
}

/* 粘贴：放哪儿按哪儿的语义走 —— 存入面板开着就当资料，否则当这一问的附件 */
async function pasteFilesOrImage(e) {
  const cd = e.clipboardData
  if (!cd) return

  const files = Array.from(cd.files || [])
  const items = Array.from(cd.items || [])
  const imageItem = items.find((it) => it.kind === 'file' && (it.type || '').startsWith('image/'))
  const text = (() => {
    try {
      return cd.getData('text/plain') || ''
    } catch {
      return ''
    }
  })()

  // 没有任何文件：可能是截图，也可能就是一段文字
  if (!files.length && !imageItem) {
    if (text.trim()) return // 纯文字，交给默认粘贴
    const probe = await window.pet.hasClipboardImage().catch(() => null)
    if (!probe || !probe.hasImage) return
    await handleClipboardImage()
    return
  }

  e.preventDefault()

  const paths = files.map((f) => window.pet.pathForFile(f)).filter(Boolean)
  if (!paths.length) return handleClipboardImage()
  if (isStoreOpen()) await stagePaths(paths)
  else await attachPaths(paths)
}

// 挂在 document 上：光标不在输入框里时粘贴图片也能接住
document.addEventListener('paste', pasteFilesOrImage, true)

/* ---------------- 存入面板 ---------------- */

function isStoreOpen() {
  return !el.storeSheet.classList.contains('hidden')
}

function kbTargetName() {
  return el.kbName.textContent || '知识库'
}

function openStore() {
  if (!state || !state.loggedIn) return show('login')
  el.storeSheet.classList.remove('hidden')
  closeKBMenu()
  renderShelf()
}

function closeStore() {
  el.storeSheet.classList.add('hidden')
  closeKBMenu()
  el.input.focus()
}

const stagingPaths = new Set()

function stagePaths(paths) {
  // 拖到「存入」落点时要顺手把面板拉开：光进清单但不显示，等于什么都没发生
  if (!isStoreOpen()) openStore()
  // 原生拖放 + 桌宠转发 + BroadcastChannel 回环可能把同一批路径送来两三次，
  // 而 describePaths 是异步的：两次调用都可能在对方 push 之前通过 shelf 检查，
  // 所以除了 shelf 去重，还要挡住「正在解析中」的同一路径。
  const batch = (paths || []).filter((p) => p && !stagingPaths.has(p))
  if (!batch.length) return Promise.resolve()
  batch.forEach((p) => stagingPaths.add(p))
  return window.pet.describePaths(batch).then((items) => {
    let added = 0
    for (const it of items || []) {
      // 同一路径只进清单一遍：原生拖放 + 桌宠转发可能把同一批文件送进来两次，
      // 不去重就会「放进来 1 项」但清点出两条、提交两次。
      if (shelf.some((s) => s.kind === 'file' && s.path === it.path)) continue
      shelf.push({
        key: 's' + ++shelfSeq,
        kind: 'file',
        path: it.path,
        name: it.name,
        size: it.size,
        dir: it.dir,
        ok: it.ok !== false
      })
      added++
    }
    renderShelf()
    if (added) toast(`放进来 ${added} 项，点「存入」才会上传`)
  }).finally(() => {
    batch.forEach((p) => stagingPaths.delete(p))
  })
}

// 暴露给 Tauri 原生事件调用
window.stagePathsFromTauri = (paths) => {
  if (paths && paths.length) stagePaths(paths)
}

// 桌宠窗口把拖到它身上的文件转过来，由面板统一收口
window.pet.onStoreStage((payload) => {
  const paths = (payload && payload.paths) || []
  if (paths.length) stagePaths(paths)
})

function stageText(title, content) {
  shelf.push({ key: 's' + ++shelfSeq, kind: 'text', title: title || '粘贴的内容', content })
  renderShelf()
}

function humanSize(n) {
  const v = Number(n) || 0
  if (!v) return ''
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB'
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

function renderShelf() {
  el.storeList.innerHTML = ''
  for (const it of shelf) {
    const row = document.createElement('div')
    row.className = 'store-item' + (it.kind === 'file' && !it.ok ? ' bad' : '')
    const n = document.createElement('span')
    n.className = 'si-name'
    n.textContent = it.kind === 'text' ? `${it.title}（文字）` : it.name
    n.title = n.textContent
    const m = document.createElement('span')
    m.className = 'si-meta'
    if (it.kind === 'text') m.textContent = `${(it.content || '').length} 字`
    else if (!it.ok) m.textContent = '读不到'
    else m.textContent = it.dir ? '文件夹' : humanSize(it.size)
    const x = document.createElement('button')
    x.className = 'si-x'
    x.textContent = '✕'
    x.title = '不放这个了'
    x.addEventListener('click', () => {
      const i = shelf.findIndex((z) => z.key === it.key)
      if (i >= 0) shelf.splice(i, 1)
      renderShelf()
    })
    row.append(n, m, x)
    el.storeList.appendChild(row)
  }
  const total = shelf.length
  const bad = shelf.filter((s) => s.kind === 'file' && !s.ok).length
  el.storeCommit.disabled = !total || total === bad
  el.storeCommit.textContent = total ? `存入 ${total} 项` : '存入'
  el.storeCount.textContent = !total
    ? '还没放东西进来'
    : bad
      ? `${total} 项里有 ${bad} 项读不到，会被跳过`
      : `将存入「${kbTargetName()}」`
}

async function commitStore() {
  if (busy) return toast('这条回答还没结束，等它答完再存', 'warn')
  const files = shelf.filter((s) => s.kind === 'file' && s.ok && !s.dir).map((s) => s.path)
  const dirs = shelf.filter((s) => s.kind === 'file' && s.ok && s.dir).map((s) => s.path)
  const texts = shelf.filter((s) => s.kind === 'text')
  const total = files.length + dirs.length + texts.length
  if (!total) return

  const kb = kbTargetName()
  el.storeCommit.disabled = true
  el.storeCommit.textContent = '提交中…'
  let failed = 0
  let queued = 0
  let existed = 0
  try {
    if (files.length || dirs.length) {
      const r = (await window.pet.uploadPaths([...files, ...dirs])) || {}
      if (r.error) {
        failed++
        toast(r.error, 'warn')
      }
      // 真实上传在 Rust 侧排队：queued 是这次真正进队的数量，
      // exists 是库里已经有、被去重掉的数量
      queued += r.queued || 0
      existed += r.exists || 0
    }
    for (const t of texts) {
      const r = await window.pet.uploadText({ title: t.title, content: t.content })
      if (r && r.error) {
        failed++
        toast(r.error, 'warn')
      }
    }
  } finally {
    shelf.length = 0
    renderShelf()
  }
  closeStore()
  if (!failed) {
    let note = `已提交 ${queued + texts.length} 项到「${kb}」`
    if (existed) note += `，另外 ${existed} 项库里已经有`
    sysNote(`${note}，解析完成后就能搜到`)
  } else {
    sysNote(`有 ${failed} 组没能提交成功，重试一次试试`)
  }
}

function sysNote(text) {
  hideEmpty()
  const wrap = document.createElement('div')
  wrap.className = 'msg sys'
  const box = document.createElement('div')
  box.className = 'sys-note'
  box.textContent = text
  wrap.appendChild(box)
  el.chat.appendChild(wrap)
  scrollToBottom()
}

// 首次使用提示：按钮上的绿点，点过一次就永久收起（localStorage 随 userData 持久）
const STORE_HINT_KEY = 'storeHintSeen'
const storeHintSeen = () => {
  try {
    return localStorage.getItem(STORE_HINT_KEY) === '1'
  } catch {
    return false
  }
}
if (storeHintSeen()) el.storeHint?.classList.add('hidden')

el.btnStore.addEventListener('click', () => {
  try {
    localStorage.setItem(STORE_HINT_KEY, '1')
  } catch {}
  el.storeHint?.classList.add('hidden')
  if (isStoreOpen()) closeStore()
  else openStore()
})
el.btnCloseStore.addEventListener('click', closeStore)
el.storeCancel.addEventListener('click', () => {
  if (shelf.length) {
    confirmBox('清空待存入？', `已经放进来的 ${shelf.length} 项会被丢掉，不会上传。`, '清空').then((ok) => {
      if (!ok) return
      shelf.length = 0
      renderShelf()
      closeStore()
    })
    return
  }
  closeStore()
})
el.storeCommit.addEventListener('click', commitStore)

// 「选文件 / 选文件夹」拿回来的 items 里已经有真实路径和文件信息（Rust 侧 stat 过），
// 直接进清单，不再 describe 一次。
function stageItems(items) {
  if (!isStoreOpen()) openStore()
  let added = 0
  let bad = 0
  for (const it of items || []) {
    const path = it && it.path
    if (!path) continue
    // 只有文件名、没有目录分隔符 = webview 没给绝对路径，存了也是 404
    if (!/[\\/]/.test(path)) {
      bad++
      continue
    }
    if (shelf.some((s) => s.kind === 'file' && s.path === path)) continue
    shelf.push({
      key: 's' + ++shelfSeq,
      kind: 'file',
      path,
      name: it.name || path.split(/[/\\]/).pop(),
      size: it.size,
      dir: !!(it.dir || it.isDir),
      ok: it.ok !== false
    })
    added++
  }
  renderShelf()
  if (bad && !added) return toast('系统只给到了文件名，改用「拖进来」试试', 'warn')
  if (added) toast(`放进来 ${added} 项，点「存入」才会上传`)
}

async function stagePick(kind) {
  const r = await window.pet.storePick(kind)
  if (!r || r.canceled) return
  if (r.error) return toast(r.error, 'warn')
  const items = r.items || []
  if (!items.length) return
  if (items.every((i) => i && i.path && /[\\/]/.test(i.path))) return stageItems(items)
  // 老路径（拿不到绝对路径）兜底：交给 describePaths 再判断一次
  await stagePaths(items.map((i) => i.path))
}

el.storeDrop.addEventListener('click', () => stagePick('files'))
$('btnFile').addEventListener('click', (e) => {
  e.stopPropagation()
  stagePick('files')
})
$('btnFolder').addEventListener('click', (e) => {
  e.stopPropagation()
  stagePick('folder')
})
$('btnText').addEventListener('click', (e) => {
  e.stopPropagation()
  el.textModal.classList.remove('hidden')
  $('textTitle').focus()
})
el.textModal.addEventListener('click', (e) => {
  if (e.target === el.textModal) el.textModal.classList.add('hidden')
})
$('textCancel').addEventListener('click', () => el.textModal.classList.add('hidden'))
$('textSave').addEventListener('click', () => {
  const title = $('textTitle').value.trim()
  const body = $('textBody').value.trim()
  if (!body) return toast('内容不能为空', 'warn')
  el.textModal.classList.add('hidden')
  $('textTitle').value = ''
  $('textBody').value = ''
  if (!isStoreOpen()) openStore()
  stageText(title || '未命名内容', body)
})

/* ---------------- 拖拽：用落点表达意图 ---------------- */

let dragDepth = 0
let dragActive = false

function hasFiles(e) {
  const dt = e.dataTransfer
  if (!dt) return false
  return Array.from(dt.types || []).includes('Files')
}

function showDropLayer() {
  // 存入面板已经开着，意图很明确，不用再让他选一次
  if (dragActive || isStoreOpen()) return
  dragActive = true
  el.dropLayer.classList.remove('hidden')
}

function hideDropLayer() {
  dragActive = false
  dragDepth = 0
  el.dropLayer.classList.add('hidden')
  el.dropLayer.querySelectorAll('.dz').forEach((d) => d.classList.remove('over'))
  el.storeDrop.classList.remove('over')
}

function zoneAt(x, y) {
  const zones = el.dropLayer.querySelectorAll('.dz')
  for (const z of zones) {
    const r = z.getBoundingClientRect()
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return z.dataset.zone
  }
  return ''
}

document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  showDropLayer()
})

document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  const inStore = el.storeDrop.contains(e.target)
  el.storeDrop.classList.toggle('over', inStore && isStoreOpen())
  const zone = zoneAt(e.clientX, e.clientY)
  el.dropLayer.querySelectorAll('.dz').forEach((d) => {
    d.classList.toggle('over', !!zone && d.dataset.zone === zone)
  })
})

document.addEventListener('dragleave', () => {
  if (!dragActive) return
  dragDepth--
  if (dragDepth <= 0) hideDropLayer()
})

document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  // 桌面端走原生拖放（能拿到真实路径）；HTML5 drop 只给文件名，
  // 而且与原生事件同时处理会把同一批文件收两遍。
  if (window.__TAURI__) return
  const zone = zoneAt(e.clientX, e.clientY)
  const storeOpen = isStoreOpen()
  hideDropLayer()

  const files = Array.from(e.dataTransfer.files || [])
  const paths = files.map((f) => window.pet.pathForFile(f)).filter(Boolean)
  if (!paths.length) return toast('没拿到文件路径，改用「选文件」试试', 'warn')
  if (storeOpen || zone === 'store') return stagePaths(paths)
  if (zone === 'ask') return attachPaths(paths)
  toast('松在空白处了，这次什么都没动')
})

// 从访达/桌面拖进来的文件不弹浏览器默认行为
document.addEventListener('dragover', (e) => e.preventDefault())

/* ---------------- 自动更新 ---------------- */

// 状态机：idle → checking → (uptodate | available) → downloading → ready → restarting
const UPD = { state: 'idle', info: null, canInstall: true, total: 0 }

function updLabel(text, { dot = false, busy = false } = {}) {
  if (!el.updLabel) return
  el.updLabel.textContent = text
  el.btnUpdate.disabled = busy
  el.btnUpdate.classList.toggle('busy', busy)
  el.updDot?.classList.toggle('hidden', !dot)
}

function closeUpdate() {
  el.updModal.classList.add('hidden')
}

async function initVersion() {
  try {
    const v = await window.pet.appVersion()
    if (v) el.appVer.textContent = `v${v}`
  } catch {}
}

function fmtMB(n) {
  const v = Number(n) || 0
  return v > 0 ? `${(v / 1024 / 1024).toFixed(1)} MB` : ''
}

function openUpdateModal() {
  const info = UPD.info || {}
  el.updTitle.textContent = `发现新版本 v${info.version || ''}`
  const bits = []
  if (info.current) bits.push(`当前 v${info.current}`)
  if (info.date) bits.push(String(info.date).slice(0, 10))
  el.updMeta.textContent = bits.join(' · ')
  const notes = String(info.notes || '').trim()
  el.updNotes.textContent = notes
  el.updNotes.classList.toggle('hidden', !notes)
  el.updBarWrap.classList.add('hidden')
  el.updBar.style.width = '0%'
  el.updGo.disabled = !UPD.canInstall
  el.updGo.textContent = '立即更新'
  el.updLater.disabled = false
  el.updLater.textContent = '稍后'
  const win = /windows/i.test(String(info.target || ''))
  if (!UPD.canInstall) {
    el.updTip.textContent = '当前程序不在「应用程序」文件夹里，没法原地替换。先把「知识小助」拖进去，再打开它更新。'
  } else if (win) {
    el.updTip.textContent = '开始安装后应用会自动退出，装完会自己重新打开。'
  } else {
    el.updTip.textContent = '下载完会提示重启，重启后就是新版本。'
  }
  el.updModal.classList.remove('hidden')
}

async function checkUpdate({ silent = false } = {}) {
  if (UPD.state === 'checking' || UPD.state === 'downloading' || UPD.state === 'restarting') return
  UPD.state = 'checking'
  updLabel(silent ? '检查更新' : '检查中…', { busy: !silent })
  const r = await window.pet.updateCheck()
  if (!r || r.ok === false) {
    UPD.state = 'idle'
    updLabel('检查更新')
    if (!silent) toast((r && r.error) || '检查更新失败', 'warn')
    return
  }
  const info = r.info || {}
  if (!info.hasUpdate) {
    UPD.state = 'idle'
    updLabel('检查更新')
    if (!silent) toast(`已是最新版本${info.current ? ' v' + info.current : ''}`)
    return
  }
  UPD.info = info
  UPD.canInstall = r.canInstall !== false
  UPD.state = 'available'
  updLabel('有新版本', { dot: true })
  openUpdateModal()
}

async function doInstall() {
  if (UPD.state === 'downloading' || UPD.state === 'restarting') return
  UPD.state = 'downloading'
  UPD.total = 0
  el.updGo.disabled = true
  el.updGo.textContent = '下载中…'
  el.updLater.disabled = true
  el.updLater.textContent = '更新中…'
  el.updBarWrap.classList.remove('hidden')
  el.updBar.style.width = '0%'
  el.updTip.textContent = '正在下载更新包…'
  updLabel('下载中', { busy: true })

  const r = await window.pet.updateInstall()
  if (!r || r.ok === false) {
    UPD.state = 'available'
    updLabel('检查更新')
    el.updGo.disabled = !UPD.canInstall
    el.updGo.textContent = '重试'
    el.updLater.disabled = false
    el.updLater.textContent = '稍后'
    el.updBarWrap.classList.add('hidden')
    el.updTip.textContent = (r && r.error) || '更新失败'
    return
  }
  // Windows 上安装器会把应用接管走，一般走不到这里；macOS 需要用户点重启
  UPD.state = 'ready'
  updLabel('待重启')
  el.updTitle.textContent = '更新已下载'
  el.updMeta.textContent = `重启后生效 · v${r.version || UPD.info?.version || ''}`
  el.updBar.style.width = '100%'
  el.updTip.textContent = '重启后会运行新版本。'
  el.updGo.disabled = false
  el.updGo.textContent = '重启并安装'
  el.updLater.disabled = false
  el.updLater.textContent = '稍后'
}

async function doRestart() {
  UPD.state = 'restarting'
  el.updGo.disabled = true
  el.updGo.textContent = '正在重启…'
  await window.pet.updateRestart()
}

window.pet.onUpdateProgress((p) => {
  if (!p || UPD.state !== 'downloading') return
  const total = Number(p.total) || 0
  const done = Number(p.downloaded) || 0
  if (total) {
    UPD.total = total
    const pct = Math.max(1, Math.min(100, Math.round((done / total) * 100)))
    el.updBar.style.width = pct + '%'
    el.updGo.textContent = `下载中 ${pct}%`
  } else {
    el.updGo.textContent = `下载中 ${fmtMB(done)}`
  }
  if (p.finished) el.updTip.textContent = '下载完成，正在安装…'
})

el.btnUpdate.addEventListener('click', () => {
  if (UPD.state === 'ready') {
    el.updModal.classList.remove('hidden')
    return
  }
  if (UPD.state === 'available') {
    openUpdateModal()
    return
  }
  checkUpdate()
})
el.updGo.addEventListener('click', () => {
  if (UPD.state === 'downloading') return
  if (UPD.state === 'ready') return doRestart()
  doInstall()
})
el.updLater.addEventListener('click', closeUpdate)
el.updModal.addEventListener('click', (e) => {
  if (e.target === el.updModal && UPD.state !== 'downloading') closeUpdate()
})

/* ---------------- SSE 事件 ---------------- */

window.pet.onChatEvent((ev) => {
  const s = stream
  if (!s) return
  const t = ev.response_type
  if (t === 'heartbeat') return
  if (t === 'agent_query') {
    if (s.status) s.status.textContent = '正在理解问题…'
  } else if (t === 'tool_call') {
    if (s.status) s.status.textContent = '正在检索知识库…'
  } else if (t === 'references') {
    renderRefs(s, ev.knowledge_references || [])
  } else if (t === 'answer') {
    if (s.status) {
      s.status.remove()
      s.status = null
    }
    const stick = nearBottom()
    s.raw = (s.raw || '') + (ev.content || '')
    s.text.innerHTML = mdToHtml(s.raw)
    if (stick) scrollToBottom()
  } else if (t === 'error') {
    finishStream(s)
    renderError('问答出错：' + (ev.content || '未知错误'))
  } else if (t === 'complete') {
    finishStream(s)
  }
})

/* ---------------- 上传 ---------------- */

const STATUS_TEXT = {
  queued: '排队中',
  uploading: '上传中',
  parsing: '解析中',
  done: '已入库',
  exists: '已存在',
  failed: '失败'
}

/** 「解析中」其实分两段：processing 在切片+向量化，finalizing 在生成摘要/标签 */
function parseLabel(it) {
  if (it.status !== 'parsing') return STATUS_TEXT[it.status] || it.status
  const base = it.parseStatus === 'finalizing' ? '整理中' : '解析中'
  const secs = Number(it.parseElapsed) || 0
  if (!secs) return base
  const t = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}分${secs % 60}s`
  return `${base} · ${t}`
}

function renderQueue(items) {
  const list = Array.isArray(items) ? items : []
  const showQueue = list.length > 0
  el.queueWrap.classList.toggle('hidden', !showQueue)
  if (!showQueue) {
    el.queue.innerHTML = ''
    return
  }
  const doneCount = list.filter((i) => i.status === 'done' || i.status === 'exists').length
  el.queueTitle.textContent = `上传队列 ${doneCount}/${list.length}`

  el.queue.innerHTML = ''
  for (const it of list) {
    const row = document.createElement('div')
    row.className = 'q-item'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = it.rel || it.name
    name.title = it.rel || it.name
    const st = document.createElement('div')
    st.className = 'st ' + (it.status === 'parsing' && it.parseStatus === 'finalizing' ? 'finalizing' : it.status)
    let text = parseLabel(it)
    if (it.status === 'queued' && it.tenantId && currentTenant && Number(it.tenantId) !== currentTenant) {
      text = '换回该空间后继续'
    }
    st.textContent = it.status === 'failed' ? `失败 · ${it.error || ''}` : text
    row.appendChild(name)
    row.appendChild(st)
    if (it.status === 'failed') {
      const btn = document.createElement('button')
      btn.textContent = '重试'
      btn.addEventListener('click', () => window.pet.retryUpload(it.id))
      row.appendChild(btn)
    } else if (it.knowledgeId) {
      // 存错了就地撤销：这也顺便覆盖「拖错落点」的情形
      const btn = document.createElement('button')
      btn.textContent = '移除'
      btn.title = '从知识库里删掉这一篇'
      btn.addEventListener('click', async () => {
        const ok = await confirmBox('从知识库删除？', `「${it.rel || it.name}」会从库里删掉，同事将搜不到它。`, '删除')
        if (!ok) return
        const r = await window.pet.deleteKnowledge(it.knowledgeId)
        if (r && r.ok === false) return toast(r.error || '删除失败', 'warn')
        queueItems = queueItems.filter((x) => x.id !== it.id)
        renderQueue(queueItems)
        toast('已删除')
      })
      row.appendChild(btn)
    }
    el.queue.appendChild(row)
  }
}

let queueItems = []
window.pet.onUploadUpdate(({ item }) => {
  if (item && item.id && item.id !== 'all') {
    // 先按 id 合并；找不到再按路径合并 —— 桌宠窗口和面板窗口各有自己的队列，
    // 同一文件若从两个窗口都上传过，id 不同但 path 相同，只按 id 去重会画成两行。
    let i = queueItems.findIndex((x) => x.id === item.id)
    if (i < 0 && item.path) i = queueItems.findIndex((x) => x.path === item.path)
    if (i >= 0) queueItems[i] = item
    else queueItems.push(item)
  } else {
    window.pet.listUploads().then((l) => {
      queueItems = l
      renderQueue(l)
    })
    return
  }
  renderQueue(queueItems)
  if (item && item.status === 'done' && item.knowledgeId) refreshKnowledgeMeta()
})

$('btnClearQueue').addEventListener('click', async () => {
  await window.pet.clearUploads()
  queueItems = await window.pet.listUploads()
  renderQueue(queueItems)
})

// 令牌彻底过期（自动续期也失败）：退回登录页，否则接下来每个操作都只会静默失败
window.pet.onAuthExpired?.(() => {
  toast('登录已过期，请重新登录', 'warn')
  state = { ...(state || {}), loggedIn: false, token: '' }
  show('login')
})

/* ---------------- 更多菜单 / 关闭 ---------------- */

$('btnMore').addEventListener('click', (e) => {
  e.stopPropagation()
  el.moreMenu.classList.toggle('hidden')
})
document.addEventListener('click', () => el.moreMenu.classList.add('hidden'))

$('miStore').addEventListener('click', () => {
  el.moreMenu.classList.add('hidden')
  openStore()
})
$('miWeb').addEventListener('click', () => window.pet.openWeb())
$('miQuit').addEventListener('click', () => window.pet.quit())
$('miLogout').addEventListener('click', async () => {
  await window.pet.logout()
  state = await window.pet.state()
  el.chat.innerHTML = ''
  sessions.items = []
  sessions.total = 0
  sessions.activeId = ''
  el.sessionList.innerHTML = ''
  shelf.length = 0
  attachList = []
  renderShelf()
  renderAttachStrip()
  el.storeSheet.classList.add('hidden')
  show('login')
})

$('btnClose').addEventListener('click', () => window.pet.hidePanel())
$('btnNewChat')?.addEventListener('click', () => newChat())
$('btnSideNew').addEventListener('click', () => newChat())

/* ---- 侧栏交互 ---- */

el.btnToggleSidebar.addEventListener('click', (e) => {
  e.stopPropagation()
  toggleSidebar()
})

el.sideBackdrop.addEventListener('click', () => toggleSidebar(false))

let searchTimer = 0
el.sessionSearch.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    sessions.keyword = el.sessionSearch.value.trim()
    loadSessions({ reset: true })
  }, 300)
})

el.sessionList.addEventListener('scroll', () => {
  if (sessions.loading || sessions.items.length >= sessions.total) return
  const box = el.sessionList
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) loadSessions()
})

window.addEventListener('resize', () => {
  if (window.innerWidth >= NARROW) sessions.drawer = false
  applySidebar()
})

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!el.textModal.classList.contains('hidden')) {
    el.textModal.classList.add('hidden')
    return
  }
  if (isStoreOpen()) {
    closeStore()
    return
  }
  window.pet.hidePanel()
})

window.pet.onPanelShown(() => {
  refreshKnowledgeMeta()
  // 网页端可能刚聊过，或首问的标题刚生成好，重新拉一次列表
  if (state && state.loggedIn && !busy) loadSessions({ reset: true })
  setTimeout(() => el.input.focus(), 60)
})

// ⌘⇧U：不进输入框，直接把存入面板拉开
window.pet.onStoreOpen(() => openStore())

window.pet.onToast(({ text, kind }) => toast(text, kind))

window.pet.onSmokeAsk((q) => {
  el.input.value = q
  send()
})

/* 截图模式下的假数据（不写库） */
window.pet.onShotDemo(() => {
  show('main')
  kbGroups = [
    {
      tenantId: 10000,
      tenantName: '技术部',
      role: 'editor',
      kbs: [
        { id: 'kb1', name: '技术部门知识库', documents: 8 },
        { id: 'kb2', name: '接口文档', documents: 0 }
      ]
    },
    { tenantId: 10002, tenantName: '我的空间', role: 'owner', kbs: [] }
  ]
  currentTenant = 10000
  currentKB = 'kb1'
  askScope = { count: 2, total: 2, docs: 8, names: ['技术部门知识库', '接口文档'] }
  applyKBLabel({ ...kbGroups[0].kbs[0], tenantName: '技术部' })
  renderKBMenu(flatKBs())
  // 侧栏假数据：截图用，覆盖「置顶 / 今天 / 昨天」三种分组
  state = { loggedIn: true, userName: '李高峰', tenantName: '技术部', sidebarOpen: true }
  sessions.open = true
  sessions.activeId = 's1'
  sessions.total = 5
  const iso = (days, h = 10, m = 20) => {
    const d = new Date(Date.now() - days * 86400000)
    d.setHours(h, m, 0, 0)
    return d.toISOString()
  }
  sessions.items = [
    { id: 's1', title: '差旅报销的住宿上限是多少', pinned: true, updatedAt: iso(0, 9, 41), createdAt: iso(0, 9, 38) },
    { id: 's2', title: '调课申请审批流程有哪几步', pinned: false, updatedAt: iso(0, 8, 12), createdAt: iso(0, 8, 5) },
    { id: 's3', title: '知识库里现在有哪些模块的内容', pinned: false, updatedAt: iso(1, 17, 36), createdAt: iso(1, 17, 15) },
    { id: 's4', title: '排课引擎的约束规则怎么配', pinned: false, updatedAt: iso(1, 14, 2), createdAt: iso(1, 13, 50) },
    { id: 's5', title: '新生入学登记的字段说明', pinned: false, updatedAt: iso(6, 11, 24), createdAt: iso(6, 11, 20) }
  ]
  el.sideUser.textContent = '李高峰'
  el.sideTenant.textContent = '技术部'
  applySidebar()
  renderSessions()
  el.chatEmpty && el.chatEmpty.classList.add('hidden')
  addUser('去上海出差，住宿费一晚最多报多少？')
  const s = addAssistant()
  s.status.remove()
  s.status = null
  s.text.textContent =
    '按《差旅报销管理办法》第 12 条，上海属于一类地区，住宿费上限 600 元/晚；\n超过部分需要部门负责人书面审批后才能报销。'
  renderRefs(s, [
    { knowledge_title: '差旅报销管理办法.md', content: '# 差旅报销管理办法\n第十二条 一类地区（北京、上海、广州、深圳）住宿费标准为每人每晚 600 元…' },
    { knowledge_title: '财务制度汇编.pdf', content: '第三章 费用标准 … 住宿费超标部分需部门负责人审批。' }
  ])
  queueItems = [
    { id: 'd1', rel: '人事制度/考勤/2026年10月考勤.xlsx', status: 'done' },
    { id: 'd2', rel: '技术部/接口文档/v2 接口说明.md', status: 'parsing' },
    { id: 'd3', rel: '技术部/报价单.pdf', status: 'exists' }
  ]
  renderQueue(queueItems)
  renderScope()
})

window.pet.onShotMenu(() => openKBMenu())

window.pet.onShotStore(() => {
  el.dropLayer.classList.add('hidden')
  openStore()
  shelf.length = 0
  shelf.push({ key: 's1', kind: 'file', path: '/tmp/a.txt', name: '上线检查清单.txt', size: 202, dir: false, ok: true })
  shelf.push({ key: 's2', kind: 'file', path: '/tmp/b.pdf', name: '接口文档 v2.pdf', size: 1468006, dir: false, ok: true })
  shelf.push({ key: 's3', kind: 'text', title: '10 月值班安排', content: '十月排班…' })
  renderShelf()
})

window.pet.onShotDrop(() => {
  el.storeSheet.classList.add('hidden')
  el.dropLayer.classList.remove('hidden')
  el.dropLayer.querySelectorAll('.dz')[0].classList.add('over')
})

init()
