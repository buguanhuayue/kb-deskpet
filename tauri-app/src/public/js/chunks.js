/**
 * 切片拼接：把 /chunks/{knowledge_id} 分页拿回的切片还原成整篇正文。
 *
 * 为什么需要它：
 * 服务端没有「只读取原文件」的接口 —— viewer 权限下 /knowledge/{id}/download
 * 必返 403（源码里有专门的用例 TestKnowledgeDownloadRejectsReadOnlySharedKB），
 * 而平台网页端的「文档详情」本身就是按 chunks 分页渲染的。
 * 所以想看全文，只能在客户端把切片拼回去。
 *
 * 拼接要处理两类重复，否则会拼出明显的毛刺：
 *   1) 跨片重叠：同一段文字在上一片末尾、下一片开头各出现一次（实测可到 44 字）；
 *   2) 表格被切开后每片都补一份表头（| 列 | 列 | + |---|---|），拼起来就是
 *      同一张表里插了好几条表头，md 渲染出来会断成好几张表。
 *
 * 单独成文件（和 md.js 一样是 UMD）是为了能在 Node 里直接 require 做回归测试。
 */
(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.chunks = api
})(typeof window !== 'undefined' ? window : null, function () {
  // 重叠太短就不算重叠：少于这么多字符的巧合命中（比如都以 "| " 开头）会误切正文
  const MIN_OVERLAP = 12
  // 单片最多这么多字符，再长说明不是重叠而是重复段落，不该整段吃掉
  const MAX_OVERLAP = 600

  /** 前一片后缀 == 后一片前缀 的最长长度，没有则 0 */
  function overlapLen(acc, head) {
    const cap = Math.min(MAX_OVERLAP, acc.length, head.length)
    for (let n = cap; n >= MIN_OVERLAP; n--) {
      if (acc.slice(acc.length - n) === head.slice(0, n)) return n
    }
    return 0
  }

  /** markdown 表格的分隔行：|---|---| */
  function isTableSep(line) {
    const s = String(line || '').trim()
    if (!s.includes('-')) return false
    return /^[|\s:-]+$/.test(s)
  }

  /**
   * 去掉「同一张表里重复出现的表头」。
   * 以空行为界判断是否还在同一张表：切片在表格中间切开时不会插空行，
   * 于是续片的表头落在同一张表内，可以安全丢掉；真正的新表前面必有空行。
   */
  function dedupeTableHeaders(text) {
    const lines = text.split('\n')
    const out = []
    let inTable = false
    let headKey = ''
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) {
        inTable = false
        headKey = ''
        out.push(line)
        continue
      }
      const isRow = line.trim().startsWith('|')
      if (isRow && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const key = line.trim() + '\n' + lines[i + 1].trim()
        if (inTable && key === headKey) {
          i++ // 连同分隔行一起跳过
          continue
        }
        headKey = key
        inTable = true
        out.push(line, lines[++i])
        continue
      }
      if (isRow) inTable = true
      out.push(line)
    }
    return out.join('\n')
  }

  /**
   * rows: [{ chunk_index, content }]
   * 返回 { text, chunks, chars }
   */
  function stitchChunks(rows) {
    const list = (rows || [])
      .filter((r) => r && typeof r.content === 'string' && r.content)
      .slice()
      .sort((a, b) => (Number(a.chunk_index) || 0) - (Number(b.chunk_index) || 0))

    let acc = ''
    for (const r of list) {
      let c = r.content
      if (acc) {
        const cut = overlapLen(acc, c)
        if (cut) c = c.slice(cut)
      }
      acc += c
    }

    acc = dedupeTableHeaders(acc)
    // 切片边界经常留下多余空行；三行以上压成两行，首尾空白清掉
    acc = acc.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '')
    if (acc) acc += '\n'

    return { text: acc, chunks: list.length, chars: acc.length }
  }

  return { stitchChunks }
})
