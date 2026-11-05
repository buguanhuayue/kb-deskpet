// 前端脚本语法自检。
//
// 为什么需要它：v0.8.7–v0.8.9 的 pet.js 里有一段孤立代码块（拆函数时留下的残句），
// 整个脚本 SyntaxError 不执行，桌宠因此失去拖动、点击、眨眼三层能力，而打包链
// 一路绿灯把坏包发了出去 —— 语法错必须在这里拦住，而不是等用户装上才发现。
//
// 用法：npm run check（CI 在 tauri build 之前也跑这一步）

import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOTS = ['src']

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p)
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(r))
if (!files.length) {
  console.error('没有找到任何待检查的脚本，检查路径是否写错')
  process.exit(1)
}

let failed = 0
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (res.status !== 0) {
    failed++
    const detail = (res.stderr || '').split('\n').slice(0, 6).join('\n')
    console.error(`✗ ${relative('.', file)}\n${detail}\n`)
  }
}

if (failed) {
  console.error(`${failed}/${files.length} 个脚本语法有误，禁止打包`)
  process.exit(1)
}
console.log(`✓ ${files.length} 个脚本语法检查通过`)
