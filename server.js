// 小鲸鱼余额桌宠 —— 独立版本地服务
//
// 移植自 MeteorNOX/DeepSeek-Balance-Whale-Widget (MIT) 的宿主侧代码。
// 相比原版 DSH 插件，只替换了两处耦合：
//   1. 凭据读取   ctx.credentials.resolve(...)  ->  配置文件 / 环境变量
//   2. 路由注册   ctx.webServer.register(...)   ->  内置 http 路由表
// 其余（余额拉取、记账账本、峰谷定价、配置持久化）逐段保留原逻辑。
//
// 前端 lib/widget.js 是上游 WIDGET_JS 的原样抽取，零改动。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// 路径与配置来源
//
// 两种运行方式：
//   1. 独立运行（node server.js）——用项目目录，配置和数据都放在项目里
//   2. 被 Electron 主进程嵌入——由主进程调 configure() 指定根目录（打包后
//      可能是 asar 内的只读目录）以及用户目录下的可写配置/数据位置
// ---------------------------------------------------------------------------

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

let ROOT = DEFAULT_ROOT
let CONFIG_FILE = process.env.DS_PET_CONFIG || path.join(ROOT, 'config.json')
let DATA_DIR = process.env.DS_PET_DATA || path.join(ROOT, 'data')
let SIZE_FILE = ''
let USAGE_FILE = ''
let IMAGE_CANDIDATES = []
let PERSONA_IMAGE_CANDIDATES = {}
let RUA_GIF_CANDIDATES = []
let SOUND_SETS = {}

function rebuildPaths() {
  SIZE_FILE = path.join(DATA_DIR, '.dshw-size.json')
  USAGE_FILE = path.join(DATA_DIR, '.dshw-usage.json')
  IMAGE_CANDIDATES = [
    path.join(ROOT, 'assets', 'DSniang1.png'),
    path.join(ROOT, 'assets', 'DSniang02.png'),
  ]
  // 多厂商换皮：按厂商给不同贴图，取不到就回落到默认那张
  PERSONA_IMAGE_CANDIDATES = {
    glm: [path.join(ROOT, 'assets', 'personas', 'glm', 'character.png')],
  }
  RUA_GIF_CANDIDATES = [path.join(ROOT, 'assets', 'rua.gif')]
  SOUND_SETS = {
    duck: {
      press: path.join(ROOT, 'assets', 'Ya1.mp3'),
      release: path.join(ROOT, 'assets', 'Ya2.mp3'),
    },
    fx1: {
      press: path.join(ROOT, 'assets', 'D1.mp3'),
      release: path.join(ROOT, 'assets', 'D2.mp3'),
    },
  }
}
rebuildPaths()

export function configure(options) {
  const o = options || {}
  if (o.root) ROOT = path.resolve(o.root)
  if (o.configFile) CONFIG_FILE = o.configFile
  if (o.dataDir) DATA_DIR = o.dataDir
  rebuildPaths()
  // 路径换了，缓存和上次的解析错误都要作废
  balanceCache = null
  fileCache.clear()
  configParseError = null
  readConfig.lastLogged = null
}

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 25000

// 配置文件解析失败的原文，用于给用户一个能看懂的提示（而不是笼统的"未配置"）
let configParseError = null

function readConfig() {
  let fileCfg = {}
  try {
    // 记事本另存为「UTF-8 带 BOM」会塞进一个 \uFEFF，JSON.parse 会因为
    // 这个不可见字符直接抛错。先剥掉，否则用户填了 key 也读不到。
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')
    fileCfg = JSON.parse(raw)
    if (!fileCfg || typeof fileCfg !== 'object') fileCfg = {}
    configParseError = null
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      configParseError = null
    } else {
      configParseError = String((err && err.message) || err)
      if (configParseError !== readConfig.lastLogged) {
        readConfig.lastLogged = configParseError
        console.error('[ds-pet] config.json 读取失败: ' + configParseError)
        console.error('[ds-pet] 常见的两个原因：多余的逗号/引号，或者被存成了带 BOM 的编码。')
      }
    }
  }
  return {
    // 环境变量优先，方便临时覆盖
    apiKey: process.env.DEEPSEEK_API_KEY || fileCfg.apiKey || '',
    platformToken: process.env.DEEPSEEK_PLATFORM_TOKEN || fileCfg.platformToken || '',
    glmPlanToken:
      process.env.GLM_PLAN_TOKEN ||
      (fileCfg.providers && fileCfg.providers.glm && fileCfg.providers.glm.planToken) ||
      '',
    host: fileCfg.host || '127.0.0.1',
    port: Number(fileCfg.port) || 3080,
  }
}

// 每次调用都重读，改完 config.json 无需重启服务
function resolveCredential(name) {
  const cfg = readConfig()
  if (name === 'DEEPSEEK_API_KEY') return cfg.apiKey ? { value: cfg.apiKey } : null
  if (name === 'DEEPSEEK_PLATFORM_TOKEN') return cfg.platformToken ? { value: cfg.platformToken } : null
  if (name === 'GLM_PLAN_TOKEN') return cfg.glmPlanToken ? { value: cfg.glmPlanToken } : null
  return null
}

// ---------------------------------------------------------------------------
// 定价（原样保留；DeepSeek 调价时改这里）
// ---------------------------------------------------------------------------

// DeepSeek CNY prices per million tokens: [空闲时段价, 高峰时段价].
// 高峰时段：工作日 9:00–12:00 和 14:00–18:00（北京时间）；2026-08-23 起周末全天谷价。
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
// deepseek-v4-pro 为 flash 的 3 倍价（官方 2026-08-17 生效）；vision-exp 与 flash 同价
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}
function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}

const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // = 北京时间 2026-08-23 00:00
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay() // 0=周日 6=周六（bj 按 UTC 读即为北京日历日）
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

// ---------------------------------------------------------------------------
// 余额 / 用量
// ---------------------------------------------------------------------------

let balanceCache = null
let balanceInFlight = null
const fileCache = new Map()

function readFirst(candidates) {
  for (const p of candidates) {
    try {
      const bytes = fs.readFileSync(p)
      if (bytes && bytes.length > 0) return bytes
    } catch (err) {}
  }
  return null
}

// 按厂商取贴图：GLM 有自己的角色图，取不到或不是 GLM 就用默认那张。
// 按厂商分别缓存，避免来回切换时反复读盘。
function loadImage(provider) {
  const key = 'image:' + (provider === 'glm' ? 'glm' : 'deepseek')
  const hit = fileCache.get(key)
  if (hit) return hit
  const extra = provider === 'glm' ? (PERSONA_IMAGE_CANDIDATES.glm || []) : []
  const bytes = readFirst(extra.concat(IMAGE_CANDIDATES))
  if (!bytes) throw new Error('persona image not found')
  fileCache.set(key, bytes)
  return bytes
}

function loadGif() {
  const hit = fileCache.get('gif')
  if (hit) return hit
  const bytes = readFirst(RUA_GIF_CANDIDATES)
  if (!bytes) throw new Error('rua gif not found')
  fileCache.set('gif', bytes)
  return bytes
}

function soundSetFromUrl(url) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = /(?:^|&)set=([^&]+)/.exec(q)
    return m ? decodeURIComponent(m[1]) : ''
  } catch (err) {
    return ''
  }
}

// 通用取 query 参数（0.3.0 起不少路由靠 id 选资源：role-image.png / bubble-img.png /
// audio-fragment.wav 都是 ?id=xxx 的形式）
function urlParam(url, name) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = new RegExp('(?:^|&)' + name + '=([^&]*)').exec(q)
    return m ? decodeURIComponent(m[1]) : ''
  } catch (err) {
    return ''
  }
}

function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null
  const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
  return (
    infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
    infos.find((x) => num(x) > 0) ||
    infos.find((x) => x && x.currency === 'CNY') ||
    infos[0]
  )
}

async function fetchBalance() {
  const cred = resolveCredential('DEEPSEEK_API_KEY')
  if (!cred) {
    // 区分「没填」和「填了但文件读不出来」——否则用户填完还看到"未配置"会很困惑
    if (configParseError) {
      return {
        ok: false,
        code: 'CONFIG',
        error: 'config.json 读取失败，已按未配置处理：' + configParseError.slice(0, 160) +
          '（检查是不是多了逗号/引号，或存成了带 BOM 的编码）',
      }
    }
    return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY（写到 config.json 或设同名环境变量）' }
  }
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + cred.value },
        signal: AbortSignal.timeout(20000),
      })
    } catch (err) {
      lastErr = err
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
      continue
    }
    if (!res.ok) {
      lastErr = new Error('HTTP ' + res.status)
      if (res.status < 500) break
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
      continue
    }
    let data
    try {
      data = await res.json()
    } catch (err) {
      return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
    }
    const info = pickBalanceInfo(data && data.balance_infos)
    if (!info || info.total_balance === undefined) {
      return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
    }
    return {
      ok: true,
      totalBalance: Number(info.total_balance),
      currency: String(info.currency || 'CNY'),
      updatedAt: new Date().toISOString(),
    }
  }
  const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
  return {
    ok: false,
    code: 'HTTP',
    transient: transient,
    error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
  }
}

async function fetchUsage() {
  const cred = resolveCredential('DEEPSEEK_PLATFORM_TOKEN')
  if (!cred) return { error: 'no platform token' }
  const token = String(cred.value).replace(/^Bearer\s+/i, '')
  try {
    const now = new Date()
    const tz = -now.getTimezoneOffset() * 60
    const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
    const end = start + 86400
    const url = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=' + start + '&end=' + end + '&tz=' + tz
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { error: 'http ' + res.status }
    const data = await res.json()
    const u = computeTodayUsage(data)
    if (u && isFinite(u.amount)) return { amount: u.amount, tokens: u.tokens }
    return { error: 'no usage' }
  } catch (err) {
    return { error: String((err && err.message) || err) }
  }
}

function computeTodayUsage(data) {
  // data.data.biz_data.series[]: [{model, buckets:[{time, usage:{RESPONSE_TOKEN, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN}}]}]
  let d = data
  if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
  else if (d && d.data && Array.isArray(d.data.series)) d = d.data
  const series = Array.isArray(d.series) ? d.series : null
  if (!series || series.length === 0) return null
  let cost = 0
  let tokens = 0
  let found = false
  for (const s of series) {
    if (!s || typeof s !== 'object') continue
    const p = priceFor(s.model)
    const buckets = Array.isArray(s.buckets) ? s.buckets : []
    for (const b of buckets) {
      const u = b && b.usage
      if (!u || typeof u !== 'object') continue
      const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0
      const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0
      const out = Number(u.RESPONSE_TOKEN) || 0
      if (hit + miss + out === 0) continue
      found = true
      tokens += hit + miss + out
      const pi = isPeakTime(b.time) ? 1 : 0
      cost += (hit / 1e6) * p.hit[pi] + (miss / 1e6) * p.miss[pi] + (out / 1e6) * p.out[pi]
    }
  }
  return found ? { amount: cost, tokens: tokens } : null
}

// ---------------------------------------------------------------------------
// 记账账本（小鲸鱼记账模式）
// ---------------------------------------------------------------------------

function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function readUsageLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed
  } catch (err) {}
  return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} }
}

function writeUsageLedger(led) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(USAGE_FILE, JSON.stringify(led), 'utf8')
    return true
  } catch (err) {
    console.error('[ds-pet] 账本写入失败: ' + err.message)
    return false
  }
}

// 记账模式：每次观测到余额后，用余额正差值累计当天用量（跨天自动归零并归档）。
// 币种感知：观测币种与上次不同时只重置基准、不记差值——数值跳变来自币种
// 切换而非真实消费。
function recordLedgerUsage(currentBalance, currency) {
  const t = todayKey()
  const led = readUsageLedger()
  const cur = String(currency || '')
  const currencyChanged =
    typeof led.lastCurrency === 'string' && led.lastCurrency !== '' && cur !== '' && led.lastCurrency !== cur
  if (led.date !== t) {
    if (led.date && typeof led.todayUsage === 'number') {
      led.history = led.history || {}
      led.history[led.date] = led.todayUsage
    }
    led.date = t
    led.lastBalance = currentBalance
    led.lastCurrency = cur
    led.todayUsage = 0
  } else if (currencyChanged) {
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  } else {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
    if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
      led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
    }
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  }
  const keys = Object.keys(led.history || {}).sort()
  while (keys.length > 30) {
    delete led.history[keys.shift()]
  }
  writeUsageLedger(led)
  return led
}

function normalizeUsageMode(m) {
  return m === 'token' ? 'token' : 'ledger'
}

// ---------------------------------------------------------------------------
// 配置持久化（尺寸/音效/模式）
// ---------------------------------------------------------------------------

function readSizeConfig() {
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(SIZE_FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    parsed = null
  }
  if (!parsed || typeof parsed.scale !== 'number') return null
  return {
    scale: parsed.scale,
    sound: parsed.sound !== false,
    vol: typeof parsed.vol === 'number' ? parsed.vol : 0.9,
    soundSet: parsed.soundSet === 'fx1' ? 'fx1' : 'duck',
    usageMode: normalizeUsageMode(parsed.usageMode),
    peakMode: parsed.peakMode === 'liangwen' || parsed.peakMode === 'qiangqiang' ? parsed.peakMode : 'default',
    bubbleOn: parsed.bubbleOn !== false,
    turnCostOn: parsed.turnCostOn !== false,
    turnCostCloseMs: typeof parsed.turnCostCloseMs === 'number' ? parsed.turnCostCloseMs : 5000,
    scrollGapOn: parsed.scrollGapOn === true,
    scrollGapPx: typeof parsed.scrollGapPx === 'number' ? Math.round(parsed.scrollGapPx) : 17,
    // 桌宠侧独有：每隔多久主动冒一句随机台词（0 = 关闭）。挂件自身没有这个
    // 控件，saveConfig() 也不会提交它，所以下面写入时缺省要沿用已存值。
    autoPopMs: typeof parsed.autoPopMs === 'number' && parsed.autoPopMs > 0 ? Math.round(parsed.autoPopMs) : 0,
    // 多厂商：deepseek=余额/今日已用，glm=Coding Plan 配额
    provider: parsed.provider === 'glm' ? 'glm' : 'deepseek',
  }
}

// 收一个对象而不是一长串位置参数。字段为 undefined 时沿用已存的值——
// 挂件自己的 saveConfig() 只提交它管的那几个字段，靠这条规则才不会把
// 桌宠侧独有的设置（autoPopMs）冲掉。
function writeSizeConfig(input) {
  const prev = readSizeConfig() || {}
  const p = input || {}
  const pick = (key, fallback) => (p[key] === undefined ? (prev[key] === undefined ? fallback : prev[key]) : p[key])

  if (typeof p.scale !== 'number' && typeof prev.scale !== 'number') {
    return { ok: false, error: 'missing scale' }
  }

  const volRaw = pick('vol', 0.9)
  const tccRaw = pick('turnCostCloseMs', 5000)
  const sgpRaw = pick('scrollGapPx', 17)
  const autoRaw = pick('autoPopMs', 0)
  const providerRaw = pick('provider', 'deepseek')
  const peakRaw = pick('peakMode', 'default')

  const cfg = {
    scale: typeof p.scale === 'number' ? p.scale : prev.scale,
    sound: pick('sound', true) !== false,
    vol: typeof volRaw === 'number' ? volRaw : 0.9,
    soundSet: pick('soundSet', 'duck') === 'fx1' ? 'fx1' : 'duck',
    usageMode: normalizeUsageMode(pick('usageMode', 'ledger')),
    peakMode: peakRaw === 'liangwen' || peakRaw === 'qiangqiang' ? peakRaw : 'default',
    bubbleOn: pick('bubbleOn', true) !== false,
    turnCostOn: pick('turnCostOn', true) !== false,
    turnCostCloseMs: typeof tccRaw === 'number' ? (tccRaw > 0 ? tccRaw : 0) : 5000,
    scrollGapOn: pick('scrollGapOn', false) === true,
    scrollGapPx: typeof sgpRaw === 'number' && sgpRaw > 0 ? Math.round(sgpRaw) : 0,
    autoPopMs: typeof autoRaw === 'number' && autoRaw > 0 ? Math.round(autoRaw) : 0,
    provider: providerRaw === 'glm' ? 'glm' : 'deepseek',
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(SIZE_FILE, JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }), 'utf8')
    return { ok: true, ...cfg }
  } catch (err) {
    return { ok: false, error: '无法持久化挂件尺寸: ' + err.message }
  }
}

// ---------------------------------------------------------------------------
// GLM Coding Plan（v2.0 多厂商）
//
// 配额接口与认证方式来自官方插件 zai-org/zai-coding-plugins 的源码：
//   GET /api/monitor/usage/quota/limit —— 无参数，返回 5 小时窗 + 周窗两个配额
//   认证头是 Authorization: <原始token>，没有 Bearer 前缀（别"修正"它）
// 峰谷规则（官方文档）：高峰=工作日 14:00–18:00（UTC+8），其余含周末全天为谷，
// 谷期积分按 50% 抵扣。这里只算当前是否高峰，供气泡显示时段。
// ---------------------------------------------------------------------------

const GLM_BASE = 'https://open.bigmodel.cn'

function glmIsPeak(timeSec) {
  const bj = new Date(timeSec * 1000 + 8 * 3600 * 1000)
  const dow = bj.getUTCDay()
  if (dow === 0 || dow === 6) return false
  const h = bj.getUTCHours()
  return h >= 14 && h < 18
}

// limits[] 里两项都是 CREDIT_LIMIT。5 小时窗的重置时间永远不晚于周窗，
// 按 nextResetTime 升序排，先到期的就是 5 小时窗——比猜 unit/number 枚举稳。
function parseGlmLimits(data) {
  const limits = (data && Array.isArray(data.limits) ? data.limits.slice() : []).sort(
    (a, b) => (a.nextResetTime || 0) - (b.nextResetTime || 0),
  )
  if (limits.length < 2) return null
  const pct = (x) => {
    const usedPct = Math.min(100, Math.max(0, Math.round(Number(x.percentage) || 0)))
    return {
      usedPct: usedPct,
      remainingPct: 100 - usedPct,
      used: Number(x.currentValue) || 0,
      total: Number(x.usage) || 0,
      remaining: Number(x.remaining) || 0,
      resetAt: Number(x.nextResetTime) || 0,
    }
  }
  return { fiveHour: pct(limits[0]), weekly: pct(limits[1]), level: String(data.level || '') }
}

async function fetchGlmQuota() {
  const cred = resolveCredential('GLM_PLAN_TOKEN')
  if (!cred) {
    return {
      ok: false,
      code: 'NO_TOKEN',
      error: '未配置 GLM 令牌（config.json 的 providers.glm.planToken）',
    }
  }
  let res
  try {
    res = await fetch(GLM_BASE + '/api/monitor/usage/quota/limit', {
      headers: {
        // 裸 token，官方插件如此，没有 Bearer 前缀
        Authorization: cred.value,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(20000),
    })
  } catch (err) {
    return { ok: false, code: 'HTTP', transient: true, error: 'GLM 接口请求失败: ' + err.message }
  }
  if (res.status === 401) {
    return { ok: false, code: 'GLM_AUTH', error: 'GLM 令牌无效或已过期' }
  }
  if (!res.ok) {
    return { ok: false, code: 'HTTP', transient: res.status >= 500, error: 'GLM 接口 HTTP ' + res.status }
  }
  let data
  try {
    data = await res.json()
  } catch (err) {
    return { ok: false, code: 'PARSE', error: 'GLM 接口返回不是合法 JSON' }
  }
  const parsed = parseGlmLimits(data && data.data)
  if (!parsed) {
    return { ok: false, code: 'SHAPE', error: 'GLM 接口返回结构异常' }
  }
  return { ok: true, parsed }
}

// 当前选中的厂商（存挂件配置里，菜单「模型」行切换）
function currentProvider() {
  const cfg = readSizeConfig()
  return cfg && cfg.provider === 'glm' ? 'glm' : 'deepseek'
}

// ---------------------------------------------------------------------------
// 余额聚合
// ---------------------------------------------------------------------------

async function getBalancePayload() {
  // 多厂商分发：GLM 走配额，DeepSeek 走余额
  if (currentProvider() === 'glm') return getGlmQuotaPayload()
  const payload = await fetchBalance()
  // 失败也要带厂商标识：挂件靠它们决定气泡首行文案。少一个字段的话，
  // 从 GLM 切回来时标签会一直停在「GLM余额」（用户实测到的 bug）。
  if (!payload.ok) {
    return { ...payload, provider: 'deepseek', providerLabel: 'DeepSeek 余额' }
  }
  // 无论哪种模式，都先把余额观测记入账本（自动累积「鲸鱼记账」数据）
  const led = recordLedgerUsage(Number(payload.totalBalance), payload.currency)
  const cfg = readSizeConfig() || {}
  const mode = normalizeUsageMode(cfg.usageMode)
  // providerLabel / usageLabel 两个厂商都给全，保持响应形状一致
  const full = { ...payload, provider: 'deepseek', providerLabel: 'DeepSeek 余额', usageLabel: '今日已用' }
  full.isPeak = isPeakTime(Math.floor(Date.now() / 1000))
  if (mode === 'ledger') {
    full.todayUsage = led.todayUsage
    full.usageMode = 'ledger'
    return full
  }
  // token：尝试平台令牌实时计算
  if (resolveCredential('DEEPSEEK_PLATFORM_TOKEN')) {
    const u = await fetchUsage()
    if (u && u.amount !== undefined) {
      full.todayUsage = u.amount
      full.usageMode = 'token'
      return full
    }
  }
  // 无令牌或令牌失败：回落记账模式
  full.todayUsage = led.todayUsage
  full.usageMode = 'ledger'
  return full
}

// GLM Coding Plan：把配额映射进挂件现有的气泡字段。
// 用户要求直接用接口给的百分比，不换算积分：
//   totalBalance  <- 5 小时窗剩余百分比（气泡主数字）
//   todayUsage    <- 周窗已用百分比（提示行，前缀为「周配额已用」）
async function getGlmQuotaPayload() {
  const r = await fetchGlmQuota()
  // 失败也要带上厂商标识：挂件靠响应里的 provider 判断当前是哪个厂商
  // （没配令牌时这个响应里原本什么都没有，挂件就会以为自己在 DeepSeek 模式，
  //   于是时段文案、怪话过滤、用量行全按 DeepSeek 走）。
  if (!r.ok) return { ...r, provider: 'glm', providerLabel: 'GLM余额' }
  const now = Date.now()
  return {
    ok: true,
    provider: 'glm',
    providerLabel: 'GLM余额',
    level: r.parsed.level,
    totalBalance: r.parsed.fiveHour.remainingPct,
    currency: '%',
    todayUsage: r.parsed.weekly.usedPct,
    usageLabel: '周配额已用',
    isPeak: glmIsPeak(Math.floor(now / 1000)),
    quota: r.parsed,
    updatedAt: new Date().toISOString(),
  }
}

function getBalance() {
  const now = Date.now()
  if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) {
    return Promise.resolve(balanceCache.payload)
  }
  if (balanceInFlight) return balanceInFlight
  balanceInFlight = getBalancePayload()
    .then((payload) => {
      if (payload.ok) {
        balanceCache = { at: now, payload }
        return payload
      }
      if (payload.transient && balanceCache) {
        // transient network/API blip: keep serving the last known balance
        return { ...balanceCache.payload, stale: true, error: payload.error }
      }
      if (!payload.transient) console.error('[ds-pet]', payload.code, payload.error)
      return payload
    })
    .catch((err) => ({
      ok: false,
      code: 'ERROR',
      error: '余额服务异常: ' + String((err && err.message) || err).slice(0, 200),
    }))
    .finally(() => {
      balanceInFlight = null
    })
  return balanceInFlight
}

// ---------------------------------------------------------------------------
// 每轮对话消耗
// ---------------------------------------------------------------------------
// 原版从 DSH 的会话事件流里读精确 usage（ctx.on('session/event')），这是唯一
// 无法直接等价替换的数据源。独立版保留同一份接口形状与结算逻辑，由可选的
// 本地代理（见 proxy.js）在上游响应里读到 usage 后调用 reportTurnUsage() 喂进来。
// 未启用代理时，该接口稳定返回空值，前端不会报错，只是不弹每轮消耗泡泡。

let lastTurn = null
let lastTurnSeq = 0
let turnAgg = null // { turn, cost, tokens, lastTs }

function reportTurnUsage({ turn, model, inputTokens, cacheReadTokens, outputTokens, reasoningTokens }) {
  const input = Number(inputTokens) || 0
  const cache = Number(cacheReadTokens) || 0
  const output = Number(outputTokens) || 0
  const reasoning = Number(reasoningTokens) || 0
  const tokens = input + cache + output + reasoning
  if (tokens <= 0) return false
  const p = priceFor(model)
  const off = isPeakTime(Math.floor(Date.now() / 1000)) ? 1 : 0
  const cost = (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + ((output + reasoning) / 1e6) * p.out[off]
  const t = Number(turn)
  const turnNo = isFinite(t) ? t : (turnAgg && isFinite(turnAgg.turn) ? turnAgg.turn + 1 : 1)
  lastTurn = { turn: turnNo, amount: cost, tokens: tokens, ts: Date.now() }
  lastTurnSeq++
  balanceCache = null // 让下次轮询立刻反映新消耗
  return true
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 8192) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// 泡泡图片库（上游 0.3.0 新增的「图片 / 随机图片」泡泡模块用）
//
// 内置两张随包发布的 gif。id 必须与前端默认泡泡配置里的 imgId 一致
// （上游 lib/index.js 里就是这么定义的），否则默认泡泡会显示破图。
// 用户自己上传的图（bubble-img-upload.json）后续加在这里。
// ---------------------------------------------------------------------------

const BUBBLE_BUILTIN_IMGS = [
  { id: 'bimg_petpet', name: 'petpet', file: 'bubble-petpet.gif', format: 'gif' },
  { id: 'bimg_money1', name: 'money1', file: 'bubble-money1.gif', format: 'gif' },
]

function bubbleImgPayload() {
  return {
    ok: true,
    images: BUBBLE_BUILTIN_IMGS.map((b) => ({
      id: b.id,
      name: b.name,
      format: b.format,
      url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(b.id),
      createdAt: null,
      builtin: true,
    })),
  }
}

function bubbleImgBytes(id) {
  const item = BUBBLE_BUILTIN_IMGS.find((b) => b.id === id)
  if (!item) return null
  const bytes = readFirst([path.join(ROOT, 'assets', item.file)])
  return bytes ? { bytes: bytes, mime: item.format === 'gif' ? 'image/gif' : 'image/png' } : null
}

function sendBytes(res, bytes, type) {
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': String(bytes.length),
  })
  res.end(bytes)
}

function sendNotFound(res, msg) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(msg)
}

function sendHtml(res, file) {
  let body
  try {
    body = fs.readFileSync(file)
  } catch (err) {
    return sendNotFound(res, 'index.html missing')
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

const routes = {
  '/': (req, res) => sendHtml(res, path.join(ROOT, 'index.html')),

  // 桌宠模式页面：透明背景 + 挂件 + 桌面适配器
  '/pet': (req, res) => sendHtml(res, path.join(ROOT, 'pet.html')),

  // 桌面适配器（点击穿透、右键菜单桥接）；标签页模式下不会加载它
  '/dsh-whale/pet-adapter.js': (req, res) => {
    let body
    try {
      body = fs.readFileSync(path.join(ROOT, 'pet', 'adapter.js'))
    } catch (err) {
      return sendNotFound(res, 'adapter.js missing')
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length),
    })
    res.end(body)
  },

  '/dsh-whale/widget.js': (req, res) => {
    let body
    try {
      body = fs.readFileSync(path.join(ROOT, 'lib', 'widget.js'))
    } catch (err) {
      return sendNotFound(res, 'widget.js missing')
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length),
    })
    res.end(body)
  },

  '/dsh-whale/image.png': (req, res) => {
    try {
      // 按当前厂商出贴图：换皮对前端透明，挂件只管访问同一个 URL
      sendBytes(res, loadImage(currentProvider()), 'image/png')
    } catch (err) {
      sendNotFound(res, 'persona image unavailable: ' + err.message)
    }
  },

  '/dsh-whale/rua.gif': (req, res) => {
    try {
      sendBytes(res, loadGif(), 'image/gif')
    } catch (err) {
      sendNotFound(res, 'rua gif unavailable: ' + err.message)
    }
  },

  // 泡泡图片库：默认泡泡配置的第二泡就会用到（图片模块 + 随机图片模块）
  '/dsh-whale/bubble-imgs.json': (req, res) => {
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(bubbleImgPayload()))
  },

  '/dsh-whale/bubble-img.png': (req, res) => {
    const hit = bubbleImgBytes(urlParam(req.url, 'id'))
    if (!hit) return sendNotFound(res, 'bubble image unavailable')
    sendBytes(res, hit.bytes, hit.mime)
  },

  '/dsh-whale/sound/press.mp3': (req, res) => {
    const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
    const bytes = readFirst([set.press])
    if (!bytes) return sendNotFound(res, 'sound unavailable')
    sendBytes(res, bytes, 'audio/mpeg')
  },

  '/dsh-whale/sound/release.mp3': (req, res) => {
    const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
    const bytes = readFirst([set.release])
    if (!bytes) return sendNotFound(res, 'sound unavailable')
    sendBytes(res, bytes, 'audio/mpeg')
  },

  '/dsh-whale/balance.json': async (req, res) => {
    try {
      const payload = await getBalance()
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(payload))
    } catch (err) {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) }))
    }
  },

  '/dsh-whale/last-turn.json': (req, res) => {
    // 返回最近一轮已完成的对话消耗；seq 递增供前端判断「新的一轮」
    const payload = lastTurn
      ? { ok: true, seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ts: lastTurn.ts }
      : { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(payload))
  },

  '/dsh-whale/size.json': async (req, res) => {
    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body)
        const prevCfg = readSizeConfig()
        const scale = typeof parsed.scale === 'number' ? parsed.scale : (prevCfg ? prevCfg.scale : null)
        if (scale === null) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'missing scale' }))
          return
        }
        // 用量模式或厂商变化时让余额缓存失效，下次请求立即按新模式/新厂商计算
        if (typeof parsed.usageMode === 'string' || typeof parsed.provider === 'string') {
          const modeChanged =
            typeof parsed.usageMode === 'string' &&
            (!prevCfg || normalizeUsageMode(prevCfg.usageMode) !== normalizeUsageMode(parsed.usageMode))
          const providerChanged =
            typeof parsed.provider === 'string' &&
            (!prevCfg || (prevCfg.provider || 'deepseek') !== (parsed.provider === 'glm' ? 'glm' : 'deepseek'))
          if (modeChanged || providerChanged) {
            balanceCache = null
          }
        }
        // 直接把整包交给 writeSizeConfig：它按字段名取值，缺省的沿用已存值，
        // 这样挂件自己的 saveConfig()（不带 autoPopMs）不会覆盖桌宠侧的设置
        const result = writeSizeConfig(parsed)
        res.writeHead(result.ok ? 200 : 500, JSON_HEADERS)
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
      return
    }
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(readSizeConfig() || {}))
  },

  // 供本地代理上报每轮 usage（原版由 DSH 会话事件驱动）
  '/dsh-whale/report-turn': async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: 'use POST' }))
      return
    }
    try {
      const parsed = JSON.parse(await readBody(req))
      const ok = reportTurnUsage(parsed || {})
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: ok }))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
    }
  },
}

let server = null

async function handleRequest(req, res) {
  let pathname = '/'
  try {
    pathname = new URL(req.url, 'http://localhost').pathname
  } catch (err) {
    pathname = String(req.url || '/').split('?')[0]
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }
  const handler = routes[pathname]
  if (!handler) return sendNotFound(res, 'not found: ' + pathname)
  try {
    await handler(req, res)
  } catch (err) {
    console.error('[ds-pet] 请求处理异常', pathname, err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    res.end('internal error')
  }
}

// 启动服务。返回 Promise，成功时给出实际监听信息。
// 嵌入到 Electron 时不在这里 process.exit——那会把整个桌宠干掉，端口冲突
// 之类的错误交给调用方决定怎么处理。
export function startServer(options) {
  const o = options || {}
  if (server) return Promise.resolve({ host: o.host, port: o.port, alreadyRunning: true })

  const cfg = readConfig()
  const host = o.host || cfg.host
  const port = Number(o.port) || cfg.port

  return new Promise((resolve, reject) => {
    const srv = http.createServer(handleRequest)
    srv.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(Object.assign(new Error('端口 ' + port + ' 已被占用'), { code: 'EADDRINUSE', host, port }))
        return
      }
      if (err && err.code === 'EACCES') {
        reject(Object.assign(new Error('没有权限监听 ' + host + ':' + port), { code: 'EACCES', host, port }))
        return
      }
      reject(err)
    })
    srv.listen(port, host, () => {
      server = srv
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true })
      } catch (err) {}
      resolve({
        host: host,
        port: port,
        configFile: CONFIG_FILE,
        dataDir: DATA_DIR,
        apiKeySet: !!cfg.apiKey,
      })
    })
  })
}

export function stopServer() {
  if (!server) return
  try {
    server.close()
  } catch (err) {}
  server = null
}

// 直接 `node server.js` 运行时才自己启动；被 import 时不启动
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  startServer()
    .then((info) => {
      console.log('')
      console.log('  🐋 小鲸鱼余额桌宠已启动')
      console.log('')
      console.log('     地址：http://' + info.host + ':' + info.port)
      console.log('     API Key：' + (info.apiKeySet ? '已配置' : '未配置（挂件会提示 NO_KEY）'))
      console.log('     配置文件：' + info.configFile)
      console.log('     数据目录：' + info.dataDir)
      console.log('')
    })
    .catch((err) => {
      console.error('')
      if (err && err.code === 'EADDRINUSE') {
        console.error('  端口 ' + err.port + ' 已被占用 —— 服务多半已经在运行了。')
        console.error('  直接用浏览器打开 http://' + err.host + ':' + err.port + ' 即可；')
        console.error('  想换端口就改 config.json 里的 port。')
      } else if (err && err.code === 'EACCES') {
        console.error('  没有权限监听 ' + err.host + ':' + err.port + '，换一个 1024 以上的端口试试。')
      } else {
        console.error('  启动失败：' + String((err && err.message) || err))
      }
      console.error('')
      process.exit(1)
    })
}

