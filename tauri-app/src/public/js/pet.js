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

let lastClientX = 0
let tilt = 0

petEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  // 用 clientX/Y 判位移，不用 screenX：窗口是跟着光标走的，
  // 屏幕坐标基本不动，客户端坐标才反映“手在往哪走”
  press = { x: e.clientX, y: e.clientY }
  dragging = false
  squish(true)
  // 指针捕获：窗口跟着光标走的时候，光标难免会滑出窗口边界，
  // 没有捕获就会丢掉后续事件，拖动半路“卡住”
  try { petEl.setPointerCapture(e.pointerId) } catch (_) {}
})

window.addEventListener('pointermove', (e) => {
  if (!press) return
  if (!dragging && (Math.abs(e.clientX - press.x) > 2 || Math.abs(e.clientY - press.y) > 2)) {
    dragging = true
    document.body.classList.add('dragging')
    lastClientX = e.clientX
    petEl.style.transform = ''
    // 关键：把「窗口位置 + 光标位置」的起点交给主进程，
    // 之后每次移动由主进程按光标位移设置窗口坐标。
    // 少了这一步，主进程的 dragState 是 null，窗口一步都不会动。
    if (window.pet.dragStart) window.pet.dragStart()
  }
  if (!dragging) return

  // 按横向速度倾斜，松手回正：拖动时身体会“甩”起来。
  // movementX 是原始鼠标位移，窗口跟随不会把它吃掉；拿不到时退回客户端坐标差。
  const dx = e.movementX || e.clientX - lastClientX
  lastClientX = e.clientX
  tilt = Math.max(-8, Math.min(8, tilt * 0.55 + dx * 1.1))
  petEl.style.transform = `rotate(${tilt}deg)`
  window.pet.dragMove()
})

function endPress() {
  if (!press) return
  if (dragging) {
    document.body.classList.remove('dragging')
    // 回正时带一点回弹
    tilt = 0
    petEl.style.transform = 'rotate(0deg)'
    window.pet.dragEnd()
  } else {
    squish(false)
    window.pet.showPanel()
  }
  press = null
  dragging = false
}

window.addEventListener('pointerup', endPress)
// 系统打断（比如切 Space、来电）也要收尾，否则窗口会一直跟着光标跑
window.addEventListener('pointercancel', endPress)
window.addEventListener('blur', endPress)

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

  const files = Array.from(e.dataTransfer.files || [])
  const paths = files.map((f) => window.pet.pathForFile(f)).filter(Boolean)
  if (!paths.length) {
    say('拖文件夹请用右键菜单里的「上传文件夹」', 5000)
    return
  }

  say(`收到 ${paths.length} 个，正在读…`, 0)
  setState('eating')
  const r = await window.pet.uploadPaths(paths)
  if (r && r.error) {
    say(r.error, 5000)
    setState('alert')
    return
  }
  if (r && r.queued === 0) {
    say('这些文件格式不支持或超过 50MB', 5000)
    setState('alert')
  }
})

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
    say(`${done}/${total} 已处理`, 0)
    return
  }
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
