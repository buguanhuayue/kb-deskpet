/**
 * Markdown 渲染（纯函数，不碰 DOM）——单独成文件是为了能在 Node 里直接 require 做回归测试。
 *
 * 安全约束（重要）：
 * 1. 整篇先转义再拼标签，模型输出、知识库原文都不能直接变 HTML；
 * 2. 转义必须包含引号（" '）——链接地址会被拼进 href="..." 属性，
 *    只转 & < > 的话，`[x](https://a/"onmouseover="alert(1))` 会闭合属性并注入事件；
 * 3. 链接只允许 http/https，其它协议（javascript:、data:）一律降级成纯文本。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.md = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function safeHref(url) {
    const u = String(url || '').trim()
    // 控制字符会把 URL 截断/拼出意外结构，直接拒绝
    if (/[\u0000-\u001f\u007f]/.test(u)) return ''
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

  return { escapeHtml, safeHref, mdInline, mdToHtml }
})
