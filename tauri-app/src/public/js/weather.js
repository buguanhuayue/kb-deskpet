/* 窄 agent：实时天气工具
 *
 * 为什么要有它：桌宠的问答走 /knowledge-chat（RAG 管线），知识库里没有实时气象，
 * 问「明天太原天气」只能得到「资料里没有」——它按设计诚实，但用户要的是答案。
 *
 * 这里的边界刻意做窄，不引入开放式 ReAct 循环：
 *   1. 只在命中天气意图、且不像在问库内文档时才接管
 *   2. 只调一个固定数据源（wttr.in，免 key、允许跨域）
 *   3. 不做二次 LLM 润色——穿衣建议用规则生成，省一次往返也省不确定性
 *   4. 失败必须降级：返回 ok:false，由调用方提示，绝不静默吞掉或编造数据
 *
 * 城市名来自用户输入，渲染一律走 textContent，不拼 innerHTML。
 */
;(function (root) {
  'use strict'

  /* 中文名 → wttr.in 用的拼写。拼音比汉字地理编码更准（汉字会偏到附近乡镇） */
  var CITIES = {
    北京: 'Beijing', 上海: 'Shanghai', 天津: 'Tianjin', 重庆: 'Chongqing',
    石家庄: 'Shijiazhuang', 太原: 'Taiyuan', 呼和浩特: 'Hohhot', 沈阳: 'Shenyang',
    长春: 'Changchun', 哈尔滨: 'Harbin', 南京: 'Nanjing', 杭州: 'Hangzhou',
    合肥: 'Hefei', 福州: 'Fuzhou', 南昌: 'Nanchang', 济南: 'Jinan',
    郑州: 'Zhengzhou', 武汉: 'Wuhan', 长沙: 'Changsha', 广州: 'Guangzhou',
    南宁: 'Nanning', 海口: 'Haikou', 成都: 'Chengdu', 贵阳: 'Guiyang',
    昆明: 'Kunming', 拉萨: 'Lhasa', 西安: 'Xian', 兰州: 'Lanzhou',
    西宁: 'Xining', 银川: 'Yinchuan', 乌鲁木齐: 'Urumqi',
    大同: 'Datong', 阳泉: 'Yangquan', 长治: 'Changzhi', 晋城: 'Jincheng',
    朔州: 'Shuozhou', 晋中: 'Jinzhong', 运城: 'Yuncheng', 忻州: 'Xinzhou',
    临汾: 'Linfen', 吕梁: 'Lvliang',
    深圳: 'Shenzhen', 苏州: 'Suzhou', 无锡: 'Wuxi', 宁波: 'Ningbo',
    温州: 'Wenzhou', 青岛: 'Qingdao', 烟台: 'Yantai', 大连: 'Dalian',
    厦门: 'Xiamen', 泉州: 'Quanzhou', 东莞: 'Dongguan', 佛山: 'Foshan',
    珠海: 'Zhuhai', 常州: 'Changzhou', 徐州: 'Xuzhou', 洛阳: 'Luoyang',
    唐山: 'Tangshan', 保定: 'Baoding', 邯郸: 'Handan', 包头: 'Baotou',
    鄂尔多斯: 'Ordos', 榆林: 'Yulin', 咸阳: 'Xianyang', 宝鸡: 'Baoji',
    开封: 'Kaifeng', 新乡: 'Xinxiang', 三亚: 'Sanya', 桂林: 'Guilin',
    绵阳: 'Mianyang', 遵义: 'Zunyi', 大理: 'Dali', 丽江: 'Lijiang'
  }

  /* WWO 天气码 → 中文。wttr.in 的 lang=zh 只翻文本输出，j1 里的 weatherDesc 仍是英文。
     注意 wttr.in 会吐标准表里没有的码：134（Dust storm）、149（Smoky haze），
     北方冬季常见，必须显式收录，否则卡片会显示「天气情况未知」 */
  var CODES = {
    113: '晴', 116: '多云', 119: '阴', 122: '阴天',
    134: '沙尘暴', 143: '薄雾', 149: '烟霾', 248: '雾', 260: '冻雾',
    176: '零星小雨', 179: '零星小雪', 182: '零星雨夹雪', 185: '冻毛毛雨',
    200: '雷阵雨', 227: '吹雪', 230: '暴风雪',
    263: '零星毛毛雨', 266: '毛毛雨', 281: '冻毛毛雨', 284: '强冻毛毛雨',
    293: '零星小雨', 296: '小雨', 299: '间歇中雨', 302: '中雨',
    305: '间歇大雨', 308: '大雨', 311: '小冻雨', 314: '冻雨',
    317: '小雨夹雪', 320: '雨夹雪',
    323: '零星小雪', 326: '小雪', 329: '零星中雪', 332: '中雪',
    335: '零星大雪', 338: '大雪', 350: '冰粒',
    353: '小阵雨', 356: '阵雨', 359: '暴雨',
    362: '小阵雨夹雪', 365: '阵雨夹雪', 368: '小阵雪', 371: '阵雪',
    374: '小冰粒', 377: '冰粒',
    386: '雷阵雨', 389: '强雷雨', 392: '雷阵雪', 395: '强雷阵雪'
  }

  /* 命中其一才可能是天气问题 */
  var ASK = /天气|气温|温度|几度|多少度|冷不冷|热不热|暖和|降温|升温|下雨|下雪|雨夹雪|带伞|带雨伞|刮风|风力|雾霾|空气质|紫外线|体感|湿气|回南天/
  /* 命中其一说明在问库里的东西，必须交给 RAG——机房温湿度这类问题只能查文档 */
  var GUARD = /知识库|文档|资料|文件|制度|规定|规范|流程|标准|报告|方案|手册|合同|条款|协议|报价|台账|机房|温湿度|运维|验收|记录|台账|报销|审批/
  var TIME_RE = /今天|今日|明天|明日|后天|现在|当前|此刻|最近|这两天|这周|本周|下午|上午|晚上|白天/g

  var DEFAULT_CITY = { zh: '太原', py: 'Taiyuan' }
  var DAY_LABEL = ['今天', '明天', '后天']

  var cityKeys = null
  function sortedCityKeys() {
    /* 长名优先，「吕梁」不会被「梁」之类截胡，也为将来加三字市名留位置 */
    if (!cityKeys) cityKeys = Object.keys(CITIES).sort(function (a, b) { return b.length - a.length })
    return cityKeys
  }

  function pickCity(q) {
    var keys = sortedCityKeys()
    for (var i = 0; i < keys.length; i++) {
      if (q.indexOf(keys[i]) >= 0) return { zh: keys[i], py: CITIES[keys[i]], hit: true }
    }
    /* 白名单没收录：取「天气/气温」前面 2-4 个汉字当城市，直接当查询词交给地理编码 */
    var stripped = q.replace(TIME_RE, '')
    var m = stripped.match(/([\u4e00-\u9fa5]{2,4}?)(?:的)?(?:天气|气温|温度|几度|多少度|冷不冷|热不热|下雨|下雪|带伞)/)
    if (m && m[1].length >= 2) return { zh: m[1], py: m[1], hit: true }
    return { zh: DEFAULT_CITY.zh, py: DEFAULT_CITY.py, hit: false }
  }

  /** 识别天气意图。返回 null 表示不是（调用方继续走知识库） */
  function detect(query) {
    var q = String(query == null ? '' : query).trim()
    if (!q) return null
    /* 长句多半是在问文档内容，收紧边界避免误劫持 */
    if (q.length > 32) return null
    if (GUARD.test(q)) return null
    if (!ASK.test(q)) return null

    var day = 0
    if (/后天/.test(q)) day = 2
    else if (/明天|明日/.test(q)) day = 1

    var city = pickCity(q)
    return {
      city: city.zh,
      slug: city.py,
      day: day,
      dayLabel: DAY_LABEL[day],
      guessed: !city.hit
    }
  }

  /** 天气现象。码优先，未收录的码退回英文描述粗判，再不行保留原文——不写「未知」糊弄 */
  function condOf(code, descEn) {
    var hit = CODES[Number(code)]
    if (hit) return hit
    var d = String(descEn || '').toLowerCase()
    if (!d) return '天气情况未知'
    if (/thunder/.test(d)) return '雷雨'
    if (/blizzard/.test(d)) return '暴风雪'
    if (/snow|sleet|ice pellet/.test(d)) return '雪'
    if (/drizzle/.test(d)) return '毛毛雨'
    if (/rain/.test(d)) return '雨'
    if (/freezing fog/.test(d)) return '冻雾'
    if (/fog/.test(d)) return '雾'
    if (/mist/.test(d)) return '薄雾'
    if (/haze|smoke/.test(d)) return '霾'
    if (/dust|sand/.test(d)) return '沙尘'
    if (/overcast/.test(d)) return '阴天'
    if (/cloudy/.test(d)) return '多云'
    if (/clear|sunny/.test(d)) return '晴'
    return String(descEn)
  }

  /** 把 wttr.in 的 j1 压成卡片需要的字段；缺字段一律降级成 null，不猜 */
  function summarize(json, wx) {
    var days = (json && json.weather) || []
    var d = days[wx.day] || days[0] || null
    var cur = (json && json.current_condition && json.current_condition[0]) || null
    if (!d) return null

    /* 白天特征取 12:00 那条 hourly，比 current（此刻可能半夜）更能代表当天 */
    var noon = null
    var hourly = d.hourly || []
    for (var i = 0; i < hourly.length; i++) {
      if (hourly[i].time === '1200') { noon = hourly[i]; break }
    }
    var src = noon || cur || {}
    var code = src.weatherCode != null ? Number(src.weatherCode) : null
    var descEn = (src.weatherDesc && src.weatherDesc[0] && src.weatherDesc[0].value) || ''
    var astro = (d.astronomy && d.astronomy[0]) || {}

    return {
      city: wx.city,
      dayLabel: wx.dayLabel,
      guessed: wx.guessed,
      date: d.date || '',
      maxC: numOrNull(d.maxtempC),
      minC: numOrNull(d.mintempC),
      nowC: cur ? numOrNull(cur.temp_C) : null,
      feelsC: src.FeelsLikeC != null ? numOrNull(src.FeelsLikeC) : (cur ? numOrNull(cur.FeelsLikeC) : null),
      humidity: src.humidity != null ? numOrNull(src.humidity) : null,
      windKmph: src.windspeedKmph != null ? numOrNull(src.windspeedKmph) : null,
      windDir: src.winddir16Point || '',
      code: code,
      cond: condOf(code, descEn),
      sunrise: astro.sunrise || '',
      sunset: astro.sunset || ''
    }
  }

  function numOrNull(v) {
    var n = Number(v)
    return isFinite(n) ? n : null
  }

  /** 穿衣与出行建议：规则拼装，不用 LLM。降水按已翻译的中文现象判断，
      这样非标准天气码经过 desc 兜底后也能正确提醒带伞 */
  function advice(t) {
    var out = []
    var high = t.maxC
    if (high == null) return ''
    if (high <= 0) out.push('全天零下，羽绒服加身，注意防冻')
    else if (high <= 5) out.push('很冷，羽绒服或厚棉衣')
    else if (high <= 10) out.push('冷，厚外套配毛衣')
    else if (high <= 16) out.push('凉，一件外套够了')
    else if (high <= 24) out.push('温度舒适，薄长袖即可')
    else if (high <= 30) out.push('偏热，短袖为主')
    else out.push('炎热，注意防暑补水')

    var c = String(t.cond || '')
    if (/雪/.test(c)) out.push('有雪，路面湿滑慢点走')
    else if (/雨|雹/.test(c)) out.push('有降水，记得带伞')
    if (/沙尘|霾|烟/.test(c)) out.push('空气差，戴口罩并关窗')
    if (t.maxC != null && t.minC != null && t.maxC - t.minC >= 10) out.push('早晚温差 ' + Math.round(t.maxC - t.minC) + '℃，注意增减衣物')
    if (t.windKmph != null && t.windKmph >= 30) out.push('风比较大，注意防风')
    return out.join('；')
  }

  function fmt(n) {
    return n == null ? '—' : (n > 0 ? '+' + n : String(n))
  }

  function mdDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!m) return ''
    return Number(m[2]) + '月' + Number(m[3]) + '日'
  }

  /* ---------------- 渲染（不用 innerHTML，城市名来自用户输入） ---------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function buildCard(t) {
    var card = el('div', 'bubble-a wx')
    var head = el('div', 'wx-head')
    head.appendChild(el('span', 'wx-city', t.city))
    head.appendChild(el('span', 'wx-day', t.dayLabel + (t.date ? ' · ' + mdDate(t.date) : '')))
    card.appendChild(head)

    var main = el('div', 'wx-main')
    var temp = el('div', 'wx-temp')
    temp.appendChild(el('span', 'wx-hi', fmt(t.maxC) + '°'))
    temp.appendChild(el('span', 'wx-sep', ' / '))
    temp.appendChild(el('span', 'wx-lo', fmt(t.minC) + '°'))
    main.appendChild(temp)
    main.appendChild(el('div', 'wx-cond', t.cond))
    card.appendChild(main)

    var a = advice(t)
    if (a) card.appendChild(el('div', 'wx-advice', a))

    var meta = el('div', 'wx-meta')
    if (t.day === 0 && t.nowC != null) meta.appendChild(el('span', null, '此刻 ' + fmt(t.nowC) + '℃'))
    if (t.feelsC != null) meta.appendChild(el('span', null, '体感 ' + fmt(t.feelsC) + '℃'))
    if (t.humidity != null) meta.appendChild(el('span', null, '湿度 ' + t.humidity + '%'))
    if (t.windKmph != null) {
      meta.appendChild(el('span', null, (t.windDir ? windZh(t.windDir) : '风') + ' ' + t.windKmph + 'km/h'))
    }
    if (meta.childNodes.length) card.appendChild(meta)

    if (t.sunrise || t.sunset) {
      var astro = el('div', 'wx-meta')
      if (t.sunrise) astro.appendChild(el('span', null, '日出 ' + hhmm(t.sunrise)))
      if (t.sunset) astro.appendChild(el('span', null, '日落 ' + hhmm(t.sunset)))
      card.appendChild(astro)
    }

    var foot = el('div', 'wx-foot')
    foot.textContent = '实时数据 · wttr.in' + (t.guessed ? ' · 未说城市，按' + t.city + '查' : '') + ' · 未写入知识库'
    card.appendChild(foot)
    return card
  }

  var DIR_ZH = {
    N: '北风', NNE: '北东北风', NE: '东北风', ENE: '东东北风',
    E: '东风', ESE: '东东南风', SE: '东南风', SSE: '南东南风',
    S: '南风', SSW: '南西南风', SW: '西南风', WSW: '西西南风',
    W: '西风', WNW: '西西北风', NW: '西北风', NNW: '北西北风', C: '静风'
  }
  function windZh(d) { return DIR_ZH[d] || '' }

  function hhmm(t) {
    var m = String(t || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
    if (!m) return String(t || '')
    var h = Number(m[1]) % 12
    if (/pm/i.test(m[3])) h += 12
    return (h < 10 ? '0' : '') + h + ':' + m[2]
  }

  function buildError(msg, wx) {
    var card = el('div', 'bubble-a wx wx-err')
    card.appendChild(el('div', 'wx-err-title', '天气服务没连上'))
    card.appendChild(el('div', 'wx-err-body', msg))
    var tip = el('div', 'wx-foot')
    tip.textContent = '这个功能要能访问 wttr.in；' + (wx && wx.city ? '也可以直接把「' + wx.city + '天气」丢给搜索引擎。' : '网络恢复后重问一次即可。')
    card.appendChild(tip)
    return card
  }

  /* ---------------- 取数 ---------------- */

  function fetchJson(url, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = setTimeout(function () { if (ctrl) ctrl.abort() }, timeoutMs || 8000)
    var opt = ctrl ? { signal: ctrl.signal } : {}
    return fetch(url, opt).then(function (r) {
      clearTimeout(timer)
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.text().then(function (txt) {
        try { return JSON.parse(txt) } catch (e) { throw new Error('返回内容不是 JSON') }
      })
    }, function (e) {
      clearTimeout(timer)
      throw e
    })
  }

  /** 查天气。永远 resolve，失败用 ok:false 表达，调用方负责提示 */
  function query(wx) {
    var url = 'https://wttr.in/' + encodeURIComponent(wx.slug) + '?format=j1&lang=zh'
    return fetchJson(url, 8000).then(function (json) {
      var t = summarize(json, wx)
      if (!t) return { ok: false, error: '数据源没返回可用预报' }
      if (t.maxC == null && t.minC == null) return { ok: false, error: '数据源缺温度字段' }
      return { ok: true, data: t }
    }).catch(function (e) {
      var m = String((e && e.message) || e)
      if (/abort/i.test(m)) m = '请求超时（8 秒）'
      else if (/Failed to fetch|NetworkError|Load failed/i.test(m)) m = '网络不可达'
      return { ok: false, error: m }
    })
  }

  root.Weather = {
    detect: detect,
    query: query,
    buildCard: buildCard,
    buildError: buildError,
    /* 以下导出给测试用 */
    _summarize: summarize,
    _advice: advice,
    _cond: condOf,
    _cities: CITIES
  }
})(typeof window !== 'undefined' ? window : globalThis)
