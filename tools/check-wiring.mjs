// 「接线」一致性检查
//
//   npm run check-wiring
//
// 桌宠的跨进程调用链有三段，任何一段写错名字都不会报错，只会静默失效：
//   页面(adapter.js) --host.X()--> preload.cjs --ipc--> main.cjs
// 这类问题不需要真的点一遍就能查出来，所以单独做个脚本。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const adapter = read('pet/adapter.js')
const preload = read('pet/preload.cjs')
const main = read('pet/main.cjs')

let problems = 0
const fail = (msg) => {
  console.log('  ✗ ' + msg)
  problems++
}

// 1) adapter 调用的 host.* 方法，preload 必须导出
//    注意 widget.js 里的菜单控件也会直接调 __dsPetHost.*，所以两边都要扫
const widget = read('lib/widget.js')
const preloadExports = new Set([...preload.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]))
const hostCalls = new Set([
  ...[...adapter.matchAll(/host\.(\w+)\(/g)].map((m) => m[1]),
  ...[...widget.matchAll(/__dsPetHost\.(\w+)\(/g)].map((m) => m[1]),
])
for (const name of hostCalls) {
  if (!preloadExports.has(name)) {
    fail(`调用了 host.${name}()，但 preload.cjs 没导出`)
  }
}
console.log(`  调用 host：${[...hostCalls].join(', ')}`)
console.log(`  preload 导出：${[...preloadExports].join(', ')}`)

// 未使用的导出不算错，但提示一下（可能是忘了接的线）
const unused = [...preloadExports].filter((n) => !hostCalls.has(n) && n !== 'quit')
if (unused.length) console.log(`  (提示) preload 导出但页面没用到：${unused.join(', ')}`)

// 2) preload 用到的 IPC 通道，main 必须注册
const channels = new Set(
  [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((m) => m[1]),
)
for (const ch of channels) {
  const registered =
    main.includes(`ipcMain.handle('${ch}'`) || main.includes(`ipcMain.on('${ch}'`)
  if (!registered) fail(`通道 '${ch}' 在 preload 里用了，但 main.cjs 没有注册处理`)
}
console.log(`  IPC 通道：${[...channels].join(', ')}`)

// 3) main 主动推给页面的能力，页面得接住
//    （推的是 window 上的全局钩子，名字对不上就白推）
const pushed = [...main.matchAll(/window\.(__dshWhale\w+)/g)].map((m) => m[1])
for (const name of new Set(pushed)) {
  if (!widget.includes(name)) {
    fail(`main.cjs 推送 ${name}，但 lib/widget.js 里没有（补丁表可能没生成？）`)
  }
}
console.log(`  主进程推给页面的钩子：${[...new Set(pushed)].join(', ') || '(无)'}`)

// 4) 菜单只允许一条入口：左键点汉堡按钮。
//    这里防的是"以后又被顺手加回右键/托盘入口"。
if (/addEventListener\('contextmenu'/.test(adapter)) {
  fail("adapter.js 里又出现了 contextmenu 监听——按设计菜单只能从左键点汉堡按钮打开")
}
if (/openBuiltInMenu/.test(main)) {
  fail('main.cjs 里又出现了 openBuiltInMenu——托盘/主进程不应再有打开设置菜单的捷径')
}
console.log('  菜单入口：仅汉堡按钮 ✓')

console.log(
  problems === 0 ? '\n接线一致性：全部通过 ✓' : `\n接线一致性：发现 ${problems} 处问题`,
)
process.exit(problems === 0 ? 0 : 1)
