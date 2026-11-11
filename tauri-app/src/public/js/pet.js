const petEl = document.getElementById('pet')
const petAnim = document.getElementById('petAnim')
const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubbleText')
const dropHint = document.getElementById('dropHint')

const layerA = document.getElementById('petA')
const layerB = document.getElementById('petB')
const eyeL = document.getElementById('eyeL')
const eyeR = document.getElementById('eyeR')
const bookEl = document.getElementById('petBook')
const scrollEl = document.getElementById('petScroll')

/* ---------- 形象 ---------- */

// 一套四张，都是同比例抠好的 512×512 透明图
const ART = {
  idle: '/assets/pet/pet-idle.png',
  eating: '/assets/pet/pet-work.png',
  thinking: '/assets/pet/pet-think.png',
  alert: '/assets/pet/pet-think.png', // 没有单独的“警觉”姿势，借用叉腰那张，靠抖动区分
  party: '/assets/pet/pet-party.png'
}

// 眼睛拆分成独立图层的两个姿势（base 是眼睛已填平的底图）。
// x/y/w/h 是眼睛在 512 画布里的百分比位置，由 tools/rig-eyes.swift 生成，
// 用来设置 transform-origin —— 眨眼必须绕眼睛自己的中心压缩，否则会歪。
const RIG = {
  idle: {
    // 底图上眼睛、书、卷轴的位置都已填平/挖空，这三层负责各自动
    base: '/assets/pet/rig/idle-base2.png',
    eyes: [
      { src: '/assets/pet/rig/idle-eye0.png', x: 22.85, y: 44.34, w: 9.77, h: 11.72 },
      { src: '/assets/pet/rig/idle-eye1.png', x: 43.36, y: 44.92, w: 10.74, h: 12.30 }
    ],
    // ox/oy 是摆动支点（书绕书脊、卷轴绕手腕），由 tools/rig-parts.swift 算出
    parts: [
      { el: bookEl, src: '/assets/pet/rig/idle-book.png', ox: 48.14, oy: 32.61 },
      { el: scrollEl, src: '/assets/pet/rig/idle-scroll.png', ox: 71.96, oy: 75.31 }
    ]
  },
  eating: {
    base: '/assets/pet/rig/work-base.png',
    eyes: [
      { src: '/assets/pet/rig/work-eye0.png', x: 29.10, y: 29.30, w: 8.40, h: 11.72 },
      { src: '/assets/pet/rig/work-eye1.png', x: 47.46, y: 29.88, w: 10.55, h: 12.30 }
    ]
  }
}

const layers = [layerA, layerB]
let front = 0
// 初始底图用的就是「眼睛已填平」的那张，眼睛由独立图层补上
let currentArt = RIG.idle.base

// 预热，避免第一次切换时白一下
Object.values(ART).forEach((src) => {
  const img = new Image()
  img.src = src
})
Object.values(RIG).forEach((r) => {
  const b = new Image()
  b.src = r.base
  r.eyes.forEach((e) => {
    const i = new Image()
    i.src = e.src
  })
  ;(r.parts || []).forEach((p) => {
    const i = new Image()
    i.src = p.src
  })
})

// 肢体图层只有待机姿势有（其他姿势是整张图，书和卷轴画在图里）
const ALL_PARTS = []
Object.values(RIG).forEach((r) => (r.parts || []).forEach((p) => ALL_PARTS.push(p)))
ALL_PARTS.forEach((p) => {
  p.el.src = p.src
  // 摆动支点：书绕书脊、卷轴绕手腕，不设就绕画布中心转，会飞出去
  p.el.style.transformOrigin = `${p.ox}% ${p.oy}%`
})

function setPartsVisible(list) {
  ALL_PARTS.forEach((p) => p.el.classList.toggle('on', !!list && list.includes(p)))
}

function artFor(pose) {
  const rig = RIG[pose]
  return rig ? rig.base : ART[pose] || ART.idle
}

let eyeTimer = null
let blinkTimer = null
let eyesReady = false

function setEyesVisible(on) {
  eyeL.classList.toggle('on', on)
  eyeR.classList.toggle('on', on)
  if (!on) eyesReady = false
}

// 换姿势后挂上新姿势的眼睛：先淡出、等底图交叉淡入结束再上，
// 看起来就是换动作时顺势眨了一下，也不会出现「新眼睛配旧底图」
function mountEyes(rig) {
  const els = [eyeL, eyeR]
  rig.eyes.forEach((e, i) => {
    const el = els[i]
    el.src = e.src
    // 压缩中心对准眼睛中心（百分比相对整张 512 画布）
    el.style.transformOrigin = `${e.x + e.w / 2}% ${e.y + e.h / 2}%`
  })
  setEyesVisible(true)
  eyesReady = true
  scheduleBlink()
}

function setArt(pose) {
  const rig = RIG[pose] || null
  const src = artFor(pose)
  setPartsVisible(rig ? rig.parts : null)
  if (src === currentArt) return

  const cur = layers[front]
  const next = layers[1 - front]
  next.src = src
  next.classList.add('on')
  cur.classList.remove('on')
  front = 1 - front
  currentArt = src

  clearTimeout(eyeTimer)
  clearTimeout(blinkTimer)
  setEyesVisible(false)
  if (rig) eyeTimer = setTimeout(() => mountEyes(rig), 320)
}

/* ---------- 眨眼 ---------- */

// 压缩到 6% 就是一条缝；底图上眼睛位置已填平，露出来的是面板色
const BLINK_FRAMES = [
  { transform: 'scaleY(1)' },
  { transform: 'scaleY(0.06)', offset: 0.45 },
  { transform: 'scaleY(1)' }
]

function blinkOnce(duration = 125) {
  if (!eyesReady) return
  const opts = { duration, easing: 'ease-in-out' }
  eyeL.animate(BLINK_FRAMES, opts)
  eyeR.animate(BLINK_FRAMES, opts)
}

function scheduleBlink() {
  clearTimeout(blinkTimer)
  const wait = 2400 + Math.random() * 4200
  blinkTimer = setTimeout(() => {
    if (eyesReady && !dragging && !document.body.classList.contains('dragover')) {
      const double = Math.random() < 0.22
      blinkOnce(double ? 110 : 130)
      if (double) setTimeout(() => blinkOnce(110), 190)
    }
    scheduleBlink()
  }, wait)
}

let press = null
let dragging = false
let bubbleTimer = null
let partyTimer = null
let uploading = false
let uploadStallTimer = null

function setState(s) {
  document.body.dataset.state = s
  setArt(s)
}

function say(text, ms = 4000) {
  bubbleText.textContent = text
  bubble.classList.remove('hidden')
  clearTimeout(bubbleTimer)
  if (ms > 0) bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), ms)
}

function hideBubble() {
  bubble.classList.add('hidden')
}

/* ---------- 点击 / 拖动 ---------- */

// 按下时先压扁一点，松开弹回来 —— 让“点到了”有手感
function squish(on) {
  petEl.style.transform = on ? 'scale(1.07, 0.92)' : ''
}

let lastScreenX = 0
let lastScreenY = 0
let tilt = 0
// 位移的亚像素余量：screenX 可能是小数，攒够 1px 再发。
// 不然极慢拖动时每次增量都被取整吃掉，窗口干脆不动。
let accX = 0
let accY = 0

petEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  press = { x: e.clientX, y: e.clientY }
  lastScreenX = e.screenX
  lastScreenY = e.screenY
  dragging = false
  squish(true)
  try { petEl.setPointerCapture(e.pointerId) } catch (_) {}
})

window.addEventListener('pointermove', (e) => {
  if (!press) return
  const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y)
  if (!dragging && dist > 4) {
    dragging = true
    document.body.classList.add('dragging')
    petEl.style.transform = ''
    if (window.pet.dragStart) window.pet.dragStart()
  }
  if (!dragging) return

  const dx = e.screenX - lastScreenX
  const dy = e.screenY - lastScreenY
  lastScreenX = e.screenX
  lastScreenY = e.screenY

  tilt = Math.max(-8, Math.min(8, tilt * 0.55 + dx * 1.1))
  petEl.style.transform = `rotate(${tilt}deg)`

  // 攒够整像素再交给 Rust，余量留到下一次，避免亚像素被反复截断
  accX += dx
  accY += dy
  const mx = Math.trunc(accX)
  const my = Math.trunc(accY)
  if (mx !== 0 || my !== 0) {
    accX -= mx
    accY -= my
    window.pet.dragMove(mx, my)
  }
})

// 只有真正的「按下-松开」才算点击。拖拽收尾时浏览器还会补发 click，
// 早期版本用 click 打开面板，结果每次拖完都会弹一次面板。
function endPress(openPanel) {
  if (!press) return
  if (dragging) {
    document.body.classList.remove('dragging')
    tilt = 0
    petEl.style.transform = 'rotate(0deg)'
    window.pet.dragEnd()
  } else {
    squish(false)
    if (openPanel) window.pet.showPanel()
  }
  press = null
  dragging = false
  accX = 0
  accY = 0
}

window.addEventListener('pointerup', () => endPress(true))
// 取消 / 失焦都不该顺手把面板弹出来
window.addEventListener('pointercancel', () => endPress(false))
window.addEventListener('blur', () => endPress(false))

window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  window.pet.petMenu()
})

/* ---------- 拖文件进来 ---------- */

let dragDepth = 0

document.addEventListener('dragenter', (e) => {
  e.preventDefault()
  dragDepth++
  document.body.classList.add('dragover')
  dropHint.classList.remove('hidden')
})

document.addEventListener('dragover', (e) => {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
})

document.addEventListener('dragleave', (e) => {
  e.preventDefault()
  dragDepth--
  if (dragDepth <= 0) {
    dragDepth = 0
    document.body.classList.remove('dragover')
    dropHint.classList.add('hidden')
  }
})

document.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  document.body.classList.remove('dragover')
  dropHint.classList.add('hidden')

  // 桌面端只认原生拖放（能拿到真实路径），HTML5 的 drop 只能给到文件名，
  // 而且两条链路都处理会导致同一批文件被提交两次 —— 所以这里直接让路。
  if (window.__TAURI__) return

  const files = Array.from(e.dataTransfer.files || [])
  const paths = files.map((f) => window.pet.pathForFile(f)).filter(Boolean)
  if (!paths.length) {
    say('拖文件夹请用右键菜单里的「上传文件夹」', 5000)
    return
  }

  handlePetUpload(paths)
})

// 拖到桌宠身上的文件不再自己上传，转给面板统一「存入」：
// 上传只保留一个出口，否则面板一份、桌宠一份，同一个文件会在队列里出现两行。
window.handlePetDropFromTauri = (paths) => {
  if (!paths || !paths.length) return
  window.pet.showPanel()
  window.pet.stagePathsInPanel(paths)
  say(`收到 ${paths.length} 个，去面板点「存入」`, 4500)
  setState('idle')
}

async function handlePetUpload(paths) {
  if (!paths || !paths.length) return
  say(`收到 ${paths.length} 个，正在读…`, 0)
  setState('eating')
  const r = (await window.pet.uploadPaths(paths)) || {}
  if (r.error) {
    say(r.error, 6000)
    setState('alert')
    return
  }
  if (!r.queued) {
    say(r.exists ? '这些文件库里已经都有了' : '这些文件读不到', 5000)
    setState('alert')
    return
  }
  say(`已加入上传队列（${r.queued} 项）`, 3000)
  setState('idle')
}

/* ---------- 上传进度 ---------- */

window.pet.onUploadUpdate(({ stats }) => {
  if (!stats) return
  const active = stats.queued + stats.running
  uploading = active > 0

  if (uploading) {
    clearTimeout(partyTimer)
    setState('eating')
    const total = stats.total
    const done = stats.done + stats.exists + stats.failed
    // 上传和解析是两个阶段，进度条数字一样但含义不同，用户在等的时候需要知道在等什么
    const phase = stats.parsing > 0 && !stats.uploading && !stats.queued ? '解析中' : '上传中'
    say(`${phase} ${done}/${total}`, 0)
    // 45 秒没有任何状态变化（Rust 每 2 秒会推一次解析进度）说明卡住了，别再让气泡假装在跑
    clearTimeout(uploadStallTimer)
    uploadStallTimer = setTimeout(() => {
      if (uploading) say('这会儿有点慢，点我看进度', 8000)
    }, 45000)
    return
  }
  clearTimeout(uploadStallTimer)
  if (stats.failed > 0) {
    setState('alert')
    say(`${stats.failed} 个没成功，点我看详情`, 8000)
    return
  }
  if (stats.total > 0 && stats.done + stats.exists === stats.total) {
    setState('party')
    say(`已入库 ${stats.done} 份${stats.exists ? `，${stats.exists} 份已存在` : ''}`, 3500)
    clearTimeout(partyTimer)
    partyTimer = setTimeout(() => setState('idle'), 2600)
    return
  }
  setState('idle')
  hideBubble()
})

/* ---------- 面板问答时的状态 ---------- */

// 面板开始提问 → 思考；结束 → 回到静止。上传中不抢状态。
window.pet.onPetState((s) => {
  if (uploading) return
  if (s === 'thinking') setState('thinking')
  else if (s === 'idle') setState('idle')
})

/* ---------- 登录态同步 ---------- */

// 面板跳登录页时桌宠窗口也要有感知：旧实现只在启动时读一次 state()，
// 结果 token 过期后桌宠还一直摆着「已登录」的待机姿势。
window.pet.onAuthExpired?.(() => {
  clearTimeout(uploadStallTimer)
  uploading = false
  setState('alert')
  say('登录已过期，点我重新登录', 9000)
})

window.pet.onAuthRestored?.(() => {
  setState('idle')
  say('已恢复登录，可以继续啦', 3000)
})

// 主动退出和被动过期是两回事：文案要区分，但姿态同样是「需要登录」。
window.pet.onAuthLogout?.(() => {
  clearTimeout(uploadStallTimer)
  uploading = false
  setState('alert')
  say('已退出登录，点我重新登录', 9000)
})

/* ---------- 启动引导 ---------- */

;(async () => {
  // 待机姿势也有眼睛图层，启动即挂上
  mountEyes(RIG.idle)
  setPartsVisible(RIG.idle.parts)
  const st = await window.pet.state()
  if (!st.loggedIn) {
    setState('alert')
    say('点我登录，把文件拖给我就入库', 9000)
  }
})()
