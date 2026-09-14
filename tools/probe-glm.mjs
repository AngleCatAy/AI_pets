// v2.0 第 0 期侦察脚本：用 config.json 里的 GLM Coding Plan 令牌探真实接口
//
//   node tools/probe-glm.mjs
//
// 目的：在写正式解析器之前，拿到 quota/limit 和 model-usage 的真实响应结构。
// 接口与认证方式来自官方插件源码（zai-org/zai-coding-plugins 的 query-usage.mjs）：
//   - 认证头是 Authorization: <原始token>，注意没有 Bearer 前缀
//   - quota: GET /api/monitor/usage/quota/limit（无参数）
//   - 分模型用量: GET /api/monitor/usage/model-usage?startTime=…&endTime=…
// 本脚本只读不写，不会动任何配置。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let token = ''
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''))
  token = String((cfg.providers && cfg.providers.glm && cfg.providers.glm.planToken) || '').trim()
} catch (err) {}

if (!token) {
  console.log('还没填 GLM 令牌。打开 config.json，把 key 粘到 providers.glm.planToken 的引号里：')
  console.log('')
  console.log('  "providers": {')
  console.log('    "glm": {')
  console.log('      "planToken": "把key粘到这里"')
  console.log('    }')
  console.log('  }')
  console.log('')
  console.log('原样粘贴即可，不要加 Bearer 前缀。保存后重新运行本脚本。')
  process.exit(1)
}

const BASE = 'https://open.bigmodel.cn'

// 与官方插件一致：查询窗口取「昨天这个小时 ~ 今天这个小时」
const now = new Date()
const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours(), 0, 0, 0)
const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 59, 59, 999)
const pad = (n) => String(n).padStart(2, '0')
const fmt = (d) =>
  d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
  pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())

const get = (urlPath, query) =>
  new Promise((resolve) => {
    const u = new URL(BASE + urlPath + (query || ''))
    const req = fetch(u, {
      headers: {
        // 官方插件就是裸 token，没有 Bearer —— 照抄，别"修正"
        Authorization: token,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(20000),
    })
      .then(async (res) => {
        const body = await res.text()
        resolve({ status: res.status, body })
      })
      .catch((err) => resolve({ status: 0, body: String((err && err.message) || err) }))
    return req
  })

const show = (label, r) => {
  console.log('== ' + label + '  HTTP ' + r.status + ' ==')
  try {
    console.log(JSON.stringify(JSON.parse(r.body), null, 2))
  } catch (err) {
    console.log(r.body.slice(0, 800))
  }
  console.log('')
}

console.log('探测 ' + BASE + '（令牌长度 ' + token.length + '）\n')

const quota = await get('/api/monitor/usage/quota/limit')
show('配额上限 quota/limit', quota)

const q = '?startTime=' + encodeURIComponent(fmt(startDate)) + '&endTime=' + encodeURIComponent(fmt(endDate))
const modelUsage = await get('/api/monitor/usage/model-usage', q)
show('分模型用量 model-usage（近24小时窗口）', modelUsage)

if (quota.status === 200 && modelUsage.status === 200) {
  console.log('两个接口都通了。把上面的输出发给 AI 即可开始写解析器。')
} else if (quota.status === 401 || modelUsage.status === 401) {
  console.log('401：令牌无效。确认粘的是 open.bigmodel.cn 的 key、没有多余空格或 Bearer 前缀。')
}
