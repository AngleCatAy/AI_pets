// 一次性脚本：从 _ref/whale-widget.js 提取 BUBBLE_DEFAULT_ITEMS 的 JSON，
// 供 server.js 的 DeepSeek 默认泡泡配置使用（结果写到 tools/_bubble-default-items.json）。
import fs from 'node:fs'

const src = fs.readFileSync('_ref/whale-widget.js', 'utf8')
const marker = 'var BUBBLE_DEFAULT_ITEMS = '
const start = src.indexOf(marker)
if (start < 0) throw new Error('marker not found')
let i = start + marker.length
let depth = 0
let began = false
let inStr = false
let esc = false
for (; i < src.length; i++) {
  const ch = src[i]
  if (esc) { esc = false; continue }
  if (ch === '\\') { esc = true; continue }
  if (ch === '"') { inStr = !inStr; continue }
  if (inStr) continue
  if (ch === '[') { depth++; began = true; continue }
  if (ch === ']') { depth--; if (began && depth === 0) break; continue }
}
const text = src.slice(start + marker.length, i + 1)
const obj = JSON.parse(text)
fs.writeFileSync('tools/_bubble-default-items.json', JSON.stringify(obj), 'utf8')
console.log('items:', obj.length, 'compact bytes:', JSON.stringify(obj).length)
console.log('泡1 kind:', obj[0].kind, '模块:', obj[0].modules.map((m) => m.type).join(','))
console.log('泡2 kind:', obj[1].kind, '选项:', obj[1].options.length,
  '| A:', obj[1].options[0].item.modules.map((m) => m.type).join(','), 'lines=' + obj[1].options[0].item.modules[0].lines.length,
  '| B:', obj[1].options[1].item.modules.map((m) => m.type).join(','))
