// Markdown 渲染的安全回归测试。
//
// 背景：外部体检报告指出面板存在属性注入——escapeHtml 只转义 & < >，不转义引号，
// 于是知识库文档/模型输出里的
//     [点我](https://evil.test/"onmouseover="window.__x=1)
// 会渲染成 <a href="https://evil.test/"onmouseover="window.__x=1">，属性逃逸成功，
// 内联 handler 在 csp:null 的窗口里直接执行，能读走 localStorage 里的 token。
//
// 这个脚本用真实 md.js 渲染，断言两件事：
//   1) 输出里的每个标签都必须是「属性名="值"」的合法结构，不能有多余的引号逃逸；
//   2) 正常 Markdown 仍然照常渲染（别为了安全把功能弄坏）。
//
// 用法：npm run check / npm test

import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MD_PATH = join(ROOT, 'src/public/js/md.js')
const BRIDGE_PATH = join(ROOT, 'src/public/js/tauri-bridge.js')

/** md.js 是 UMD 风格：在沙箱里给它一个 window 和 module，取回 API */
function loadMd() {
  const sandbox = { window: {}, module: { exports: {} } }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(MD_PATH, 'utf8'), sandbox, { filename: MD_PATH })
  return sandbox.module.exports
}

const md = loadMd()
let failed = 0

function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${e.message}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/**
 * 把输出里的所有标签挑出来，校验结构合法：
 * `<div class="md-p">` 这种；标签内部只允许若干个 name="value"（value 里不能再有裸引号）。
 * 另外禁止事件属性（on*）和 srcdoc —— 引号一旦能被注入闭合，攻击者塞进来的正是这两类属性。
 * 一旦引号逃逸，这里必然报错。
 */
const TAG_RE = /<[a-zA-Z][^>]*>/g
const LEGAL_TAG_RE = /^<([a-zA-Z][\w-]*)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*\/?>$/
const ATTR_RE = /([a-zA-Z-]+)="([^"]*)"/g
const FORBIDDEN_ATTR = /^(on|srcdoc$)/i

function assertTagsLegal(html, where) {
  const tags = html.match(TAG_RE) || []
  for (const tag of tags) {
    assert(
      LEGAL_TAG_RE.test(tag),
      `${where}：标签结构非法（疑似属性逃逸）→ ${tag}`
    )
    for (const m of tag.matchAll(ATTR_RE)) {
      assert(
        !FORBIDDEN_ATTR.test(m[1]),
        `${where}：出现了可执行属性 ${m[1]} → ${tag}`
      )
    }
  }
  return tags
}

console.log('escapeHtml')
check('引号被转义（属性无法闭合）', () => {
  assert(md.escapeHtml('"') === '&quot;', `双引号转义结果：${md.escapeHtml('"')}`)
  assert(md.escapeHtml("'") === '&#39;', `单引号转义结果：${md.escapeHtml("'")}`)
})
check('& < > 仍然转义，且 & 先处理不会二次转义', () => {
  assert(md.escapeHtml('<a href="x">&</a>') === '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;', md.escapeHtml('<a href="x">&</a>'))
})

console.log('属性注入（报告里的原始载荷）')
check('链接地址里的引号闭不住 href', () => {
  const html = md.mdToHtml('[点我](https://evil.test/"onmouseover="window.__x=1)')
  assertTagsLegal(html, '属性注入')
  assert(!/href="https:\/\/evil\.test\/"onmouseover/.test(html), `仍然逃逸：${html}`)
  assert(html.includes('&quot;'), `引号没有被实体化：${html}`)
})
check('引号换成单引号同样无效', () => {
  const html = md.mdToHtml("[x](https://a.test/'onclick='alert(1))")
  assertTagsLegal(html, '单引号注入')
})
check('图片链接同样走转义', () => {
  const html = md.mdToHtml('![外链](https://a.test/"onerror="alert(1))')
  assertTagsLegal(html, '图片注入')
})
check('原始 HTML 标签只会作为文本显示', () => {
  const html = md.mdToHtml('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>')
  assert(!/<img|<script/i.test(html), `出现了真实标签：${html}`)
})
check('javascript: 协议被降级成纯文本', () => {
  const html = md.mdToHtml('[点我](javascript:alert(1))')
  assert(!/href=/.test(html), `仍然生成了 href：${html}`)
})
check('代码块里的标签不执行', () => {
  const html = md.mdToHtml('```html\n<img src=x onerror=alert(1)>\n```')
  assert(!/<img/i.test(html), html)
  assertTagsLegal(html, '代码块')
})

console.log('正常渲染不被破坏')
check('标题 / 粗体 / 行内代码 / 列表 / 表格 / 引用 / 分隔线', () => {
  const html = md.mdToHtml(
    [
      '## 小标题',
      '',
      '正文 **加粗** 和 `code` 以及 [链接](https://a.test/x?y=1&z=2)',
      '',
      '| 列一 | 列二 |',
      '| --- | --- |',
      '| a | b |',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '> 引用一句',
      '',
      '---'
    ].join('\n')
  )
  assertTagsLegal(html, '正常渲染')
  for (const piece of ['md-h2', '<strong>加粗</strong>', '<code>code</code>', 'md-link', 'md-table', 'md-li', 'md-quote', 'md-hr']) {
    assert(html.includes(piece), `缺少 ${piece}`)
  }
  // URL 里的 & 被转义成 &amp; 是正确行为，浏览器解析后仍是 &
  assert(html.includes('href="https://a.test/x?y=1&amp;z=2"'), `链接地址处理异常：${html}`)
})
check('流式未闭合的代码块不炸', () => {
  const html = md.mdToHtml('说明：\n```js\nconst a = 1\n**不是粗体**')
  assert(html.includes('md-code'), html)
  assert(!html.includes('<strong>不是粗体</strong>'), '代码块里的 ** 被当成粗体了')
})

console.log('事件投递（chat 事件不能走跨窗口广播）')
check('bridge 里 chat:event 只用 emitLocal', () => {
  const src = readFileSync(BRIDGE_PATH, 'utf8')
  const bad = src.match(/broadcast\('chat:event'/g) || []
  assert(bad.length === 0, `仍有 ${bad.length} 处 chat:event 走 broadcast（会被 Rust 广播回本窗口，导致分片重复）`)
  assert(/emitLocal\('chat:event'/.test(src), '没有找到 emitLocal 派发的 chat:event')
  assert(/invoke\('emit_event', \{ event: evt, payload, origin: SELF_LABEL \}\)/.test(src), 'broadcast 没有带上 origin，Rust 侧无法跳过发送方窗口')
})

if (failed) {
  console.error(`\n${failed} 项失败，禁止打包`)
  process.exit(1)
}
console.log('\n✓ Markdown 渲染与事件投递回归测试全部通过')
