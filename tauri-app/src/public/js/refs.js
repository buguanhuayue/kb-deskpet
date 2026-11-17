/**
 * 引用筛选（纯函数，不碰 DOM）——单独成文件是为了能在 Node 里跑回归。
 *
 * 背景（2026-11-17 实测，会话 7f607d61 的 10:17 那条回答）：
 * 服务端给了 21 条 references，其中只有 7 条来自目标文档，且排在第 8 位以后；
 * 前 7 名是别的库里同名模板类文档，向量分 0.87 —— 比目标文档的 0.70 还高
 * （服务端普通知识问答没跑重排，原始向量分不可信，见 session_knowledge_qa.go）。
 * 模型这条回答没有打 [n] 标号，旧逻辑就退化成「按召回顺序取前 6 篇文档」，
 * 于是把 4 篇无关文档顶到了最显眼的位置。
 *
 * 现在改成按「答案覆盖率」挑：片段切成的 4-gram 有多少比例真的出现在答案正文里。
 * 同一条数据实测：目标文档 0.294 / 0.265 / 0.098，无关文档全部 ≤0.032，分得很开。
 */
(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.refs = api
})(typeof window !== 'undefined' ? window : null, function () {
  const GRAM = 4
  // 覆盖率地板：低于这个值基本可以断定「这段材料没被答案用过」
  const MIN_COVER = 0.02
  // 相对地板：和最佳文档差一个数量级的，不算同一档
  const REL_FLOOR = 0.2
  // 没标号时最多摆几篇文档，多了又变成一堵墙
  const MAX_DOCS = 4

  /** 答案正文里的 [n] 标号 → refs 下标集合。标号是模型按片段顺序打的[1]..[n] */
  function citedRefIndexes(text, total) {
    const set = new Set()
    const re = /\[(\d{1,2})\]/g
    let m
    while ((m = re.exec(String(text || ''))) !== null) {
      const k = Number(m[1])
      if (k >= 1 && k <= total) set.add(k - 1)
    }
    return set
  }

  function gramSet(text) {
    // 空白不参与比较：切片和答案的换行/缩进经常对不上
    const s = String(text || '').replace(/\s+/g, '')
    const set = new Set()
    for (let i = 0; i + GRAM <= s.length; i++) set.add(s.slice(i, i + GRAM))
    return set
  }

  /** 这条片段有百分之多少的 4-gram 出现在答案里 */
  function coverScore(content, answerGrams) {
    const g = gramSet(content)
    if (!g.size || !answerGrams.size) return 0
    let hit = 0
    g.forEach((x) => { if (answerGrams.has(x)) hit++ })
    return hit / g.size
  }

  /** 答案里有没有直接点这篇文档的名字（模型概述某篇文档时，通常会在正文里写出来） */
  function mentionsDoc(ref, text) {
    const names = [ref.knowledge_title, ref.knowledge_filename]
    for (const name of names) {
      if (!name) continue
      const full = String(name).trim()
      const base = full.replace(/\.[A-Za-z0-9]{1,6}$/, '').trim()
      // 太短的名字（README、a.md）命中没有区分度，要求至少 4 个字
      if (base.length >= 4 && text.includes(base)) return true
      if (full.length >= 8 && text.includes(full)) return true
    }
    return false
  }

  /**
   * 该摆哪几条引用：
   * 1) 答案标了 [n] —— 只摆被点名的，按标号顺序（和正文对得上）；
   * 2) 没标号 —— 按「答案覆盖率」挑文档，而不是按召回顺序；
   *    答案里点过名的文档即便覆盖率低也保留（模型是在概述它，不是照抄）。
   * 3) 正文还没到（流式开头）—— 返回空，等收尾时用完整正文再算。
   *
   * 返回 refs 的原始下标（升序），供 UI 一一对应。
   */
  function pickShownRefs(refs, answerText) {
    const list = refs || []
    const text = String(answerText || '')
    const cited = citedRefIndexes(text, list.length)
    if (cited.size) return Array.from(cited).sort((a, b) => a - b)
    if (!text.trim()) return []

    const answerGrams = gramSet(text)
    const docs = new Map()
    list.forEach((r, i) => {
      const key = (r && (r.knowledge_id || r.knowledge_title)) || ('#' + i)
      const cover = coverScore(r && r.content, answerGrams)
      const hit = r ? mentionsDoc(r, text) : false
      const cur = docs.get(key)
      if (!cur) {
        docs.set(key, { cover, idx: i, hit, order: i })
        return
      }
      // 同一篇文档取覆盖率最高的那一段当代表
      if (cover > cur.cover) {
        cur.cover = cover
        cur.idx = i
      }
      cur.hit = cur.hit || hit
      if (i < cur.order) cur.order = i
    })

    const all = Array.from(docs.values())
    const best = all.reduce((m, d) => Math.max(m, d.cover), 0)
    const floor = Math.max(MIN_COVER, best * REL_FLOOR)
    const keep = all.filter((d) => d.hit || d.cover >= floor)
    keep.sort((a, b) => (b.hit - a.hit) || (b.cover - a.cover) || (a.order - b.order))
    return keep.slice(0, MAX_DOCS).map((d) => d.idx).sort((a, b) => a - b)
  }

  return { citedRefIndexes, gramSet, coverScore, mentionsDoc, pickShownRefs }
})
