// 天气工具的回归测试。
//
// 为什么值得单独测：这是一条「劫持」路径——命中就把问题从 RAG 上摘下来，
// 交给外部接口。误判的代价比不命中更大：
//   · 该走知识库的问题被劫持 → 问「机房温湿度要求」却回一句天气预报，等于答非所问
//   · 数据源缺字段没降级 → 卡片上出现 "null°"，比不给答案更糟
// 所以这里重点压三件事：反例不许命中、城市/日期要提对、缺字段要退成 null 而非乱填。
//
// 用法：npm run check / npm test

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WX_PATH = join(ROOT, 'src/public/js/weather.js')

function loadWeather() {
  const sandbox = { window: {} }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(WX_PATH, 'utf8'), sandbox, { filename: WX_PATH })
  return sandbox.window.Weather
}

const W = loadWeather()

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) {
    failed++
    console.error(`  ✗ ${name}\n      期望 ${JSON.stringify(want)}\n      实际 ${JSON.stringify(got)}`)
  } else {
    console.log(`  ✓ ${name}`)
  }
}
function pick(r) {
  return r ? { city: r.city, day: r.day, guessed: r.guessed } : null
}

/* ---------- 1. 该命中的：天气意图 + 城市 + 日期 ---------- */
console.log('\n[意图识别 · 命中]')
check('太原天气', pick(W.detect('太原天气')), { city: '太原', day: 0, guessed: false })
check('明天天气怎么样（没说城市）', pick(W.detect('明天天气怎么样')), { city: '太原', day: 1, guessed: true })
check('后天太原会下雨吗', pick(W.detect('后天太原会下雨吗')), { city: '太原', day: 2, guessed: false })
check('北京今天几度', pick(W.detect('北京今天几度')), { city: '北京', day: 0, guessed: false })
check('厦门冷不冷', pick(W.detect('厦门冷不冷')), { city: '厦门', day: 0, guessed: false })
check('吕梁明天暖和吗', pick(W.detect('吕梁明天暖和吗')), { city: '吕梁', day: 1, guessed: false })
check('朔州降温了吗', pick(W.detect('朔州降温了吗')), { city: '朔州', day: 0, guessed: false })
check('白名单外的县也要认', pick(W.detect('灵石县明天天气')), { city: '灵石县', day: 1, guessed: false })
check('带空格的问法', pick(W.detect('  上海 天气  ')), { city: '上海', day: 0, guessed: false })

/* ---------- 2. 不该命中的：这些问题属于知识库 ---------- */
console.log('\n[意图识别 · 必须放行给 RAG]')
check('机房温湿度要求', W.detect('机房温湿度要求是多少'), null)
check('差旅报销住宿上限', W.detect('差旅报销的住宿上限是多少'), null)
check('问库里的天气文档', W.detect('知识库里有天气相关的文档吗'), null)
check('方案里的温度要求', W.detect('这个方案里对温度有什么要求'), null)
check('运维记录里的低温告警', W.detect('运维记录里的低温告警怎么处理'), null)
check('空字符串', W.detect(''), null)
check('纯空白', W.detect('   '), null)
check('超长句不劫持', W.detect('请帮我把这份机房建设方案里关于空调温控和冬季低温天气对设备影响的段落整理成三点结论'), null)

/* ---------- 3. 天气码翻译 ---------- */
console.log('\n[天气码]')
check('113 晴', W._cond(113), '晴')
check('296 小雨', W._cond(296), '小雨')
check('338 大雪', W._cond(338), '大雪')
check('134 沙尘暴（wttr 非标码）', W._cond(134), '沙尘暴')
check('149 烟霾（wttr 非标码）', W._cond(149), '烟霾')
check('未知码退回英文描述', W._cond(999, 'Widespread Dust'), '沙尘')
check('未知码无描述也不编', W._cond(999), '天气情况未知')
check('字符串码也能认', W._cond('296'), '小雨')

/* ---------- 4. 穿衣建议 ---------- */
console.log('\n[建议规则]')
check('零下要提防冻', W._advice({ maxC: -3, minC: -11, cond: '晴' }).includes('全天零下'), true)
check('温差大要提醒', W._advice({ maxC: 8, minC: -3, cond: '晴' }).includes('温差'), true)
check('22 度算舒适', W._advice({ maxC: 22, minC: 18, cond: '晴' }).includes('温度舒适'), true)
check('下雨要带伞', W._advice({ maxC: 20, minC: 15, cond: '小雨' }).includes('带伞'), true)
check('下雪提醒路滑', W._advice({ maxC: 1, minC: -5, cond: '大雪' }).includes('有雪'), true)
check('下雪不重复提醒带伞', W._advice({ maxC: 1, minC: -5, cond: '大雪' }).includes('带伞'), false)
check('大风要提醒', W._advice({ maxC: 12, minC: 8, cond: '晴', windKmph: 40 }).includes('风比较大'), true)
check('沙尘要提醒防护', W._advice({ maxC: 12, minC: 2, cond: '沙尘暴' }).includes('口罩'), true)
check('烟霾也要提醒', W._advice({ maxC: 12, minC: 2, cond: '烟霾' }).includes('口罩'), true)
check('晴天不瞎提醒口罩', W._advice({ maxC: 12, minC: 8, cond: '晴' }).includes('口罩'), false)
check('没温度就返回空串', W._advice({ maxC: null }), '')

/* ---------- 5. 数据压缩：取值优先序与缺字段降级 ---------- */
console.log('\n[数据压缩]')
const fake = {
  current_condition: [{
    temp_C: '6', FeelsLikeC: '2', humidity: '25', windspeedKmph: '8',
    winddir16Point: 'NW', weatherCode: '113'
  }],
  weather: [
    {
      date: '2026-11-24', maxtempC: '4', mintempC: '-3',
      astronomy: [{ sunrise: '07:21 AM', sunset: '05:15 PM' }],
      hourly: [{ time: '0', weatherCode: '113', tempC: '0' }, { time: '1200', weatherCode: '296', tempC: '3' }]
    },
    {
      date: '2026-11-25', maxtempC: '8', mintempC: '0',
      astronomy: [{ sunrise: '07:22 AM', sunset: '05:14 PM' }],
      hourly: [{ time: '1200', weatherCode: '338', tempC: '5' }]
    }
  ]
}
const today = W._summarize(fake, { city: '太原', day: 0, dayLabel: '今天', guessed: true })
check('今天的日期', today.date, '2026-11-24')
check('白天取 12:00 那条而非此刻', today.cond, '小雨')
check('最高最低温', [today.maxC, today.minC], [4, -3])
check('此刻温度', today.nowC, 6)

const tomorrow = W._summarize(fake, { city: '太原', day: 1, dayLabel: '明天', guessed: true })
check('明天取 weather[1]', tomorrow.date, '2026-11-25')
check('明天的天气现象', tomorrow.cond, '大雪')

const broken = W._summarize({ weather: [] }, { city: '太原', day: 0, dayLabel: '今天' })
check('没有预报数据返回 null', broken, null)

const partial = W._summarize(
  { weather: [{ date: '2026-11-25', hourly: [] }] },
  { city: '太原', day: 0, dayLabel: '今天', guessed: true }
)
check('缺温度降级成 null 而不是 NaN', [partial.maxC, partial.minC, partial.nowC], [null, null, null])
check('缺现象不退化成 undefined', partial.cond, '天气情况未知')
check('缺天文字段给空串', partial.sunrise, '')

/* ---------- 6. 城市表自身一致性 ---------- */
console.log('\n[城市表]')
const cities = W._cities
const bad = Object.keys(cities).filter((k) => !cities[k] || typeof cities[k] !== 'string')
check('每个中文名都有拼音', bad, [])
check('太原带拼音', cities['太原'], 'Taiyuan')
check('城市数量合理', Object.keys(cities).length > 50, true)

console.log('')
if (failed) {
  console.error(`天气工具测试失败：${failed} 项`)
  process.exit(1)
}
console.log('天气工具测试全部通过')
