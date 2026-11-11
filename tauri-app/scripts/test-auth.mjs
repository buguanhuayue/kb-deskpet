// 统一认证层（方案 B）运行时回归。
//
// 为什么不用静态检查代替：check-syntax.mjs 只能拦语法错，而认证层的坑全是时序问题——
// 并发 401 各自刷新会把一次性轮换的 refreshToken 互相作废、刷新失败被重复清盘、
// 事件三通道重复、冷启动 Rust 侧没有令牌……这些只有把真实 bridge 跑起来才能验证。
//
// 做法：用 node:vm 加载 src/public/js/tauri-bridge.js 原文，注入 mock 的
// Tauri invoke / DOM / localStorage / BroadcastChannel / fetch，再调 window.pet 的公开方法。
//
// 用法：npm run check（CI 在 tauri build 之前也跑这一步）

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(
  join(HERE, '..', 'src', 'public', 'js', 'tauri-bridge.js'),
  'utf8'
)

const BASE_CFG = () => ({
  serverUrl: 'https://kb.example.com',
  token: 'old.jwt',
  refreshToken: 'refresh-1',
  email: 'zhangsan@company.local',
  user: { id: 'u1', username: 'zhangsan', tenant_id: 10024 },
  homeTenantId: 10024,
  currentTenantId: 10024,
  tenantId: 10024,
  kbId: 'kb-1',
  kbName: '个人库'
})

function jsonRes(status, body) {
  const text = JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => body
  }
}

function createEnv({ cfg = BASE_CFG(), fetchImpl, refreshImpl, label = 'panel', uploadSetCfgFails = false } = {}) {
  const store = new Map([['deskpet_cfg_v2', JSON.stringify(cfg)]])
  const invokes = []
  const busPosts = []
  const listeners = new Map()
  const fetchCalls = []
  let bus = null

  const invokeImpl = async (cmd, args = {}) => {
    invokes.push({ cmd, args })
    if (cmd === 'refresh_auth') return refreshImpl ? refreshImpl(args) : { ok: false }
    if (cmd === 'upload_set_cfg') {
      if (uploadSetCfgFails) throw new Error('IPC failed')
      return { ok: true }
    }
    // emit_event 只记录，不回传给本 context：真实 Rust 用 emit_filter 按 origin
    // 跳过发送方窗口。另一窗口请用 dispatchRemote() 显式模拟。
    return null
  }

  const listen = (evt, cb) => {
    if (!listeners.has(evt)) listeners.set(evt, [])
    listeners.get(evt).push(cb)
    return () => {}
  }

  const windowObj = {
    __TAURI__: {
      core: { invoke: invokeImpl },
      event: { listen },
      // 没有它 SELF_LABEL 会是空串，origin 被 Rust 过滤掉退化成全广播
      window: { getCurrentWindow: () => ({ label }) }
    }
  }

  class MockBroadcastChannel {
    constructor(name) {
      this.name = name
      bus = this
    }
    postMessage(msg) {
      busPosts.push(msg)
    }
  }

  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  }

  const fetchMock = async (url, init = {}) => {
    fetchCalls.push({ url, init })
    return fetchImpl
      ? fetchImpl(url, init, fetchCalls.length)
      : jsonRes(401, { message: 'unauthorized' })
  }

  const sandbox = {
    window: windowObj,
    localStorage,
    document: { addEventListener() {} },
    BroadcastChannel: MockBroadcastChannel,
    fetch: fetchMock,
    console: { log() {}, warn() {}, error() {} },
    AbortSignal,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'tauri-bridge.js' })

  return {
    pet: windowObj.pet,
    invokes,
    busPosts,
    listeners,
    fetchCalls,
    store,
    get cfg() {
      return JSON.parse(store.get('deskpet_cfg_v2') || '{}')
    },
    get bus() {
      return bus
    },
    // 模拟 Rust 把事件投递到「另一个窗口」的同名 Tauri listen 订阅者
    dispatchRemote(evt, payload = {}) {
      for (const cb of listeners.get(evt) || []) cb({ payload })
    }
  }
}

const inv = (env, cmd) => env.invokes.filter((i) => i.cmd === cmd)
const events = (env, evt) =>
  env.invokes.filter((i) => i.cmd === 'emit_event' && i.args.event === evt)

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('并发 401 只刷新一次，成功后用新令牌重放且不回推旧快照', async () => {
  const refreshArgs = []
  const env = createEnv({
    // 收紧 mock：只有新令牌能通过，旧令牌 / 空令牌一律 401
    fetchImpl: (_url, init) => {
      if (init.headers?.Authorization !== 'Bearer new.jwt') {
        return jsonRes(401, { message: 'expired' })
      }
      return jsonRes(200, {
        data: [{ id: 'kb-1', name: '个人库', tenant_id: 10024, documents: 3 }]
      })
    },
    refreshImpl: (args) => {
      refreshArgs.push(args)
      return { ok: true, token: 'new.jwt', refreshToken: 'refresh-2' }
    }
  })

  const results = await Promise.all([
    env.pet.listKBs(),
    env.pet.listKBs(),
    env.pet.listKBs()
  ])

  assert.equal(inv(env, 'refresh_auth').length, 1, '刷新必须单飞')
  assert.ok(results.every((r) => r.ok), '三次列表请求都应成功')
  assert.equal(env.cfg.token, 'new.jwt')
  assert.equal(env.cfg.refreshToken, 'refresh-2')

  // 冷启动快照：必须把 localStorage 里的双令牌带给 Rust，
  // 否则 Rust 的 UploadState.cfg 为空，会把「access 过期但 refresh 有效」误判成要重登。
  assert.equal(refreshArgs[0].cfg.refreshToken, 'refresh-1')
  assert.equal(refreshArgs[0].cfg.token, 'old.jwt')
  assert.equal(refreshArgs[0].cfg.serverUrl, 'https://kb.example.com')
  assert.equal(refreshArgs[0].cfg.tenantId, 10024, '身份租户必须是 home 空间')

  const replays = env.fetchCalls.filter(
    (c) => c.init.headers?.Authorization === 'Bearer new.jwt'
  )
  assert.equal(replays.length, 6, '6 个 401 请求应各重放一次，且不沿用旧令牌')

  // 令牌由 Rust 单点维护（refresh_token 成功时写入并清闸）。前端若回推，
  // 迟到的旧快照会把刚轮换出的新令牌覆盖回已作废的旧值。
  env.dispatchRemote('auth:updated', { token: 'new.jwt', refreshToken: 'refresh-2' })
  assert.equal(
    inv(env, 'upload_set_cfg').length,
    0,
    '续期成功 / auth:updated 都不能再回推 upload_set_cfg'
  )
})

test('刷新失败：只清一次盘、只广播一次过期，且保留 email/serverUrl', async () => {
  let expiredCb = 0
  const env = createEnv({
    fetchImpl: () => jsonRes(401, { message: 'expired' }),
    refreshImpl: () => ({ ok: false })
  })
  env.pet.onAuthExpired(() => { expiredCb++ })

  const results = await Promise.all([
    env.pet.listKBs(),
    env.pet.listKBs(),
    env.pet.listKBs()
  ])

  assert.equal(inv(env, 'refresh_auth').length, 1, '失败的刷新也必须单飞')
  assert.ok(results.every((r) => r.ok === false && r.expired === true))
  assert.equal(env.cfg.token, '')
  assert.equal(env.cfg.refreshToken, '')
  assert.equal(env.cfg.user, null)
  assert.equal(env.cfg.kbId, '')
  assert.equal(env.cfg.email, 'zhangsan@company.local', 'email 必须保留供登录页回填')
  assert.equal(env.cfg.serverUrl, 'https://kb.example.com', 'serverUrl 必须保留')
  assert.equal(expiredCb, 1, '本窗口 UI 只切一次登录页')
  assert.equal(events(env, 'auth:expired').length, 1, '跨窗口只广播一次')

  // auth 事件只走 Rust emit_event 单通道；再叠 BroadcastChannel 会让另一窗口收到两遍，
  // 且 bus 的裸 emit 会绕过写盘清身份。
  assert.equal(
    env.busPosts.filter((m) => String(m.evt).startsWith('auth:')).length,
    0
  )
  assert.ok(
    inv(env, 'upload_set_cfg').some((i) => i.args.cfg.token === ''),
    '清盘后要把空令牌推给 Rust，避免上传队列留着旧账号身份'
  )
})

test('登录接口 401 是账号密码错，不触发续期也不清已有身份', async () => {
  const env = createEnv({
    fetchImpl: () => jsonRes(401, { message: '账号或密码错误' })
  })
  const r = await env.pet.login({
    serverUrl: 'https://kb.example.com',
    email: 'zhangsan',
    password: 'bad'
  })
  assert.equal(r.ok, false)
  assert.equal(inv(env, 'refresh_auth').length, 0)
  assert.equal(env.cfg.token, 'old.jwt')
})

test('启动校验：断网放行，不误踢登录页', async () => {
  const env = createEnv({
    fetchImpl: () => { throw new Error('network down') }
  })
  const v = await env.pet.validateSession()
  assert.equal(v.ok, true)
  assert.equal(v.degraded, true)
  assert.notEqual(v.expired, true)
  assert.equal(inv(env, 'refresh_auth').length, 0)
})

test('启动校验：明确 401 且续期失败 → expired 并写盘清身份', async () => {
  const env = createEnv({
    fetchImpl: () => jsonRes(401, {}),
    refreshImpl: () => ({ ok: false })
  })
  const v = await env.pet.validateSession()
  assert.equal(v.ok, false)
  assert.equal(v.expired, true)
  assert.equal(inv(env, 'refresh_auth').length, 1)
  assert.equal(env.cfg.token, '')
})

test('启动校验：401 后续期成功 → 放行、写回新令牌、探针只重放一次', async () => {
  let n = 0
  const env = createEnv({
    fetchImpl: () => {
      n++
      return n === 1 ? jsonRes(401, {}) : jsonRes(200, { data: [] })
    },
    refreshImpl: () => ({ ok: true, token: 'new.jwt', refreshToken: 'refresh-2' })
  })
  const v = await env.pet.validateSession()
  assert.equal(v.ok, true)
  assert.equal(env.cfg.token, 'new.jwt')
  assert.equal(inv(env, 'refresh_auth').length, 1)
  assert.equal(n, 2)
})

test('真实跨窗口通道：auth:expired 走统一清盘而不是裸 emit', async () => {
  let expiredCb = 0
  const env = createEnv({ fetchImpl: () => jsonRes(200, { data: [] }) })
  env.pet.onAuthExpired(() => { expiredCb++ })
  // 生产路径是 emit_event → Rust emit_filter → 另一窗口 eventMod.listen，
  // 不是 BroadcastChannel（broadcast 对 auth:* 明确不 postMessage）。
  env.dispatchRemote('auth:expired', {})
  assert.equal(expiredCb, 1)
  assert.equal(env.cfg.token, '', '必须写盘清身份，只改内存重启又会判成已登录')
  assert.equal(env.cfg.email, 'zhangsan@company.local')
})

test('真实跨窗口通道：重复投递 auth:expired 只清一次盘', async () => {
  let expiredCb = 0
  const env = createEnv({ fetchImpl: () => jsonRes(200, { data: [] }) })
  env.pet.onAuthExpired(() => { expiredCb++ })
  env.dispatchRemote('auth:expired', {})
  env.dispatchRemote('auth:expired', {})
  assert.equal(expiredCb, 1, '幂等闸门必须拦住重复事件')
  assert.equal(env.cfg.token, '')
})

test('真实跨窗口通道：auth:restored 解除过期态', async () => {
  let restoredCb = 0
  const env = createEnv({
    fetchImpl: () => jsonRes(401, {}),
    refreshImpl: () => ({ ok: false })
  })
  env.pet.onAuthRestored(() => { restoredCb++ })
  await env.pet.validateSession()
  assert.equal(env.cfg.token, '')
  env.dispatchRemote('auth:restored', {})
  assert.equal(restoredCb, 1)
})

test('防御路径：BroadcastChannel 收到 auth 事件也要走统一清盘', async () => {
  // 生产上这条通道不可达，保留用例防止以后有人误把 auth:* 加回 bus.postMessage。
  let expiredCb = 0
  const env = createEnv({ fetchImpl: () => jsonRes(200, { data: [] }) })
  env.pet.onAuthExpired(() => { expiredCb++ })
  env.bus.onmessage({ data: { evt: 'auth:expired', payload: {} } })
  assert.equal(expiredCb, 1)
  assert.equal(env.cfg.token, '')
})

test('续期失败广播带非空 origin，Rust 才能跳过发送方窗口', async () => {
  const env = createEnv({
    fetchImpl: () => jsonRes(401, {}),
    refreshImpl: () => ({ ok: false })
  })
  await env.pet.validateSession()
  const e = events(env, 'auth:expired')
  assert.equal(e.length, 1)
  assert.equal(
    e[0].args.origin,
    'panel',
    'origin 为空会被 Rust 过滤掉、退化成全广播，造成同窗口重复处理'
  )
})

test('续期请求网络故障：不清盘、不跳登录、启动校验 degraded 放行', async () => {
  let expiredCb = 0
  const env = createEnv({
    fetchImpl: () => jsonRes(401, {}),
    refreshImpl: () => ({ ok: false, transient: true })
  })
  env.pet.onAuthExpired(() => { expiredCb++ })
  const v = await env.pet.validateSession()
  assert.equal(v.ok, true, '探针 401 但续期请求没打通，不能判会话过期')
  assert.equal(v.degraded, true)
  assert.notEqual(v.expired, true)
  assert.equal(expiredCb, 0)
  assert.equal(env.cfg.token, 'old.jwt', 'refreshToken 可能仍有效，身份必须原样保留')
  assert.equal(env.cfg.refreshToken, 'refresh-1')
  assert.equal(events(env, 'auth:expired').length, 0)
})

test('续期网络故障下 listKBs 报网络错误而非「登录已过期」', async () => {
  const env = createEnv({
    fetchImpl: () => jsonRes(401, {}),
    refreshImpl: () => ({ ok: false, transient: true })
  })
  const r = await env.pet.listKBs()
  assert.equal(r.ok, false)
  assert.equal(r.expired, false)
  assert.match(r.error, /网络/)
})

test('启动校验：服务端 5xx 放行，不误踢登录页', async () => {
  const env = createEnv({ fetchImpl: () => jsonRes(503, { message: 'upstream' }) })
  const v = await env.pet.validateSession()
  assert.equal(v.ok, true)
  assert.equal(v.degraded, true)
  assert.notEqual(v.expired, true)
  assert.equal(inv(env, 'refresh_auth').length, 0)
})

test('一次性轮换：刷新在途期间又来 401 也必须共用同一请求', async () => {
  const usedRefresh = new Set()
  let release
  const gate = new Promise((r) => { release = r })
  let calls = 0
  const env = createEnv({
    fetchImpl: (_url, init) =>
      init.headers?.Authorization === 'Bearer new.jwt'
        ? jsonRes(200, { data: [] })
        : jsonRes(401, {}),
    refreshImpl: (args) => {
      calls++
      usedRefresh.add(args.cfg.refreshToken)
      // 服务端轮换过一次后，旧 refreshToken 再拿来刷必然被拒
      if (args.cfg.refreshToken !== 'refresh-1') return Promise.resolve({ ok: false })
      return gate.then(() => ({ ok: true, token: 'new.jwt', refreshToken: 'refresh-2' }))
    }
  })
  const requests = [0, 1, 2, 3].map(() => env.pet.listKBs())
  // 让 8 个 401 都进入 onUnauthorized 并挂到同一个 flight 上，再放行刷新
  await new Promise((r) => setTimeout(r, 0))
  release()
  await Promise.all(requests)
  assert.equal(calls, 1, '刷新必须单飞，否则第二个请求会拿已作废的旧 refreshToken')
  assert.deepEqual([...usedRefresh], ['refresh-1'])
})

test('auth:updated 空 refreshToken 不覆盖旧值，也不回推 Rust', async () => {
  const env = createEnv({ fetchImpl: () => jsonRes(200, { data: [] }) })
  env.dispatchRemote('auth:updated', { token: 'new.jwt' })
  assert.equal(env.cfg.token, 'new.jwt')
  assert.equal(env.cfg.refreshToken, 'refresh-1')
  assert.equal(inv(env, 'upload_set_cfg').length, 0)
})

test('登录成功会同步 Rust cfg，避免队列留着上一个账号身份', async () => {
  const env = createEnv({
    fetchImpl: (url) => {
      if (url.includes('/auth/login')) {
        return jsonRes(200, {
          token: 'login.jwt',
          refresh_token: 'login-refresh',
          user: { username: 'zhangsan', tenant_id: 10024 },
          active_tenant: { id: 10024, name: '个人空间' }
        })
      }
      return jsonRes(200, { data: [] })
    }
  })
  const r = await env.pet.login({
    serverUrl: 'https://kb.example.com',
    email: 'zhangsan',
    password: 'ok'
  })
  assert.equal(r.ok, true)
  const pushed = inv(env, 'upload_set_cfg')
  assert.ok(pushed.length >= 1, '登录必须 await 同步 Rust 上传队列')
  assert.equal(pushed.at(-1).args.cfg.token, 'login.jwt')
})

test('主动登出：写盘清身份、同步 Rust、跨窗口广播 auth:logout', async () => {
  let logoutCb = 0
  const env = createEnv({ fetchImpl: () => jsonRes(200, { data: [] }) })
  env.pet.onAuthLogout(() => { logoutCb++ })
  await env.pet.logout()
  assert.equal(env.cfg.token, '')
  assert.equal(env.cfg.email, 'zhangsan@company.local')
  const pushed = inv(env, 'upload_set_cfg')
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].args.cfg.token, '')
  assert.equal(events(env, 'auth:logout').length, 1)
  assert.equal(logoutCb, 1, '本窗口本地 emit')
  // 单窗口 vm 里本地 emit 会「假装」成功；必须再验真实的跨窗口接收端，
  // 否则缺 eventMod.listen('auth:logout') 时桌宠窗口永远收不到。
  env.dispatchRemote('auth:logout', {})
  assert.equal(logoutCb, 2, '缺 Tauri listen 注册，桌宠退出后仍显示已登录')
})

test('ask() 续期网络故障：不造假 sessionId、不发起注定失败的 SSE', async () => {
  const urls = []
  const env = createEnv({
    fetchImpl: (url) => {
      urls.push(url)
      return jsonRes(401, {})
    },
    refreshImpl: () => ({ ok: false, transient: true })
  })
  const r = await env.pet.ask({ query: 'hi' })
  assert.equal(r.error, '网络暂不可用，无法完成登录续期')
  assert.equal(urls.filter((u) => u.includes('/knowledge-chat/')).length, 0)
})

test('upload_set_cfg 调用失败不阻断登录返回', async () => {
  const env = createEnv({
    uploadSetCfgFails: true,
    fetchImpl: (url) => {
      if (url.includes('/auth/login')) {
        return jsonRes(200, {
          token: 'login.jwt',
          refresh_token: 'login-refresh',
          user: { username: 'zhangsan', tenant_id: 10024 },
          active_tenant: { id: 10024, name: '个人空间' }
        })
      }
      return jsonRes(200, { data: [] })
    }
  })
  const r = await env.pet.login({
    serverUrl: 'https://kb.example.com',
    email: 'zhangsan',
    password: 'ok'
  })
  assert.equal(r.ok, true, 'invoke 包装吞掉异常后 syncRustCfg 必须仍 resolve')
  assert.equal(r.token, 'login.jwt')
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n${(e.stack || String(e)).split('\n').slice(0, 8).join('\n')}`)
  }
}
if (failed) {
  console.error(`\n${failed}/${tests.length} 个认证层回归失败，禁止打包`)
  process.exit(1)
}
console.log(`✓ ${tests.length} 个统一认证层回归通过`)
