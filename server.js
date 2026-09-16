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
  const cfg = {
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
    // 上游 0.3.0 新增：隐藏菜单按钮（悬停显形的那个蓝按钮）
    menuBtnHide: parsed.menuBtnHide === true,
    // 桌宠侧独有：每隔多久主动冒一句随机台词（0 = 关闭）。挂件自身没有这个
    // 控件，saveConfig() 也不会提交它，所以下面写入时缺省要沿用已存值。
    autoPopMs: typeof parsed.autoPopMs === 'number' && parsed.autoPopMs > 0 ? Math.round(parsed.autoPopMs) : 0,
    // 多厂商：deepseek=余额/今日已用，glm=Coding Plan 配额
    provider: parsed.provider === 'glm' ? 'glm' : 'deepseek',
  }
  // 角色按模型各存一套（配置锚点=模型）；role 是「当前模型」那份的便捷展平。
  // 缺省 default = 自带贴图（image.png 按当前模型动态出图）。
  const rolesRaw = parsed.roles && typeof parsed.roles === 'object' ? parsed.roles : {}
  cfg.roles = {
    deepseek: typeof rolesRaw.deepseek === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(rolesRaw.deepseek) ? rolesRaw.deepseek : 'default',
    glm: typeof rolesRaw.glm === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(rolesRaw.glm) ? rolesRaw.glm : 'default',
  }
  cfg.role = cfg.roles[cfg.provider]
  return cfg
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
    menuBtnHide: pick('menuBtnHide', false) === true,
    autoPopMs: typeof autoRaw === 'number' && autoRaw > 0 ? Math.round(autoRaw) : 0,
    provider: providerRaw === 'glm' ? 'glm' : 'deepseek',
  }
  // 角色按模型各存一套（配置锚点=模型）：{role} 只落到「当前模型」的槽位。
  // 挂件切角色时只上报 {role}，scale 等沿用已存值——各模型互不覆盖。
  const prevRoles = prev.roles && typeof prev.roles === 'object' ? prev.roles : {}
  const roles = {
    deepseek: typeof prevRoles.deepseek === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(prevRoles.deepseek) ? prevRoles.deepseek : 'default',
    glm: typeof prevRoles.glm === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(prevRoles.glm) ? prevRoles.glm : 'default',
  }
  if (typeof p.role === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.role)) {
    roles[cfg.provider] = p.role
  }
  cfg.roles = roles
  cfg.role = roles[cfg.provider]

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
  const turnNo = isFinite(t) ? t : turnAgg && isFinite(turnAgg.turn) ? turnAgg.turn + 1 : 1
  lastTurn = { turn: turnNo, amount: cost, tokens: tokens, ts: Date.now() }
  lastTurnSeq++
  balanceCache = null // 让下次轮询立刻反映新消耗
  // 记入账本 events（用量面板的按模型明细）并归属到自定义 API 模型（有 matchIds 命中才记）
  try {
    const led = readUsageLedger()
    led.events = Array.isArray(led.events) ? led.events : []
    led.events.push({ day: todayKey(), ts: Date.now(), cost: round2(cost), model: String(model || '') })
    if (led.events.length > 2000) led.events = led.events.slice(-1000)
    writeUsageLedger(led)
  } catch (err) {}
  try {
    apiAttributeEvent(model, cost, tokens)
  } catch (err) {}
  return true
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function readBody(req) {
  return readBodyMax(req, 8192)
}

// 上游 0.3.0 的管理类路由（角色导入 30MB / 音频 8MB / 泡泡图 10MB）需要
// 比默认 8KB 大得多的 body 上限，各自按契约传 maxBytes。
function readBodyMax(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
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
// 自定义角色系统（上游 0.3.0）
//
// whale-roles/ 目录：每个角色一个 <id>.png|gif + roles.json 索引。
// 保留 id 'default' 复用 image.png（在我们这就等于「跟随当前厂商出图」，
// 即默认方案：DeepSeek=大肥鱼、GLM=GLM 娘）；「当前选中角色」不归服务端管，
// 存在前端 localStorage['dshw-role']。
// 首次运行会预置一个固定的 GLM 角色（想锁定 GLM 形象时手动选它）；
// 用户删掉预置角色后不会复活（seed 只在索引文件不存在时执行）。
// ---------------------------------------------------------------------------

const ROLE_DEFAULT_ID = 'default'

function pickRoleDir() {
  const dir = path.join(DATA_DIR, 'whale-roles')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {}
  return dir
}

function defaultRolesIndex() {
  return {
    version: 1,
    roles: [
      // pinnedAt=1 作为置顶基线（上游同款）：任何后来置顶（Date.now()）都排在它上面。
      // default = 自带贴图（image.png 按当前模型动态出图），显示名固定「默认角色」
      { id: ROLE_DEFAULT_ID, name: '默认角色', pinnedAt: 1, createdAt: 0 },
    ],
  }
}

// 首次运行只写默认索引（default = 各模型自带贴图，无预置自定义角色）
function seedRoles() {
  const dir = pickRoleDir()
  const index = defaultRolesIndex()
  try {
    fs.writeFileSync(path.join(dir, 'roles.json'), JSON.stringify(index, null, 2), 'utf8')
  } catch (err) {}
  return index
}

// 角色按模型保存（配置锚点=模型）：default = 各模型的自带贴图
//（DeepSeek=蓝色小人 DSniang、GLM=GLM娘，由 image.png 按当前模型出图），
// 导入的角色进入全局角色库，但「当前用哪个」按模型记在 size.json 的 roles 槽位。
// 曾经预置过一个 glm 自定义角色，在按模型设计下与 GLM 自带贴图重复，已废弃
// （readRolesIndex 里对旧索引做一次性迁移清理）。
const LEGACY_PRESET_ROLE_IDS = ['glm']

function readRolesIndex() {
  const file = path.join(pickRoleDir(), 'roles.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && Array.isArray(parsed.roles)) {
      // default 必须存在（上游同款保证）；图片不在角色目录里，走 image.png
      if (!parsed.roles.some((r) => r && r.id === ROLE_DEFAULT_ID)) {
        parsed.roles.unshift(defaultRolesIndex().roles[0])
      }
      // default 显示名固定「默认角色」：没有改名接口，旧索引里的历史名（如「大肥鱼」）
      // 在这里一并归一，保证 UI 文案与用户拍板的一致
      const def = parsed.roles.find((r) => r && r.id === ROLE_DEFAULT_ID)
      if (def && def.name !== '默认角色') def.name = '默认角色'
      // 一次性迁移：剔除废弃的预置角色（连同其图片文件）
      const legacy = parsed.roles.filter((r) => r && LEGACY_PRESET_ROLE_IDS.includes(r.id))
      if (legacy.length) {
        parsed.roles = parsed.roles.filter((r) => !LEGACY_PRESET_ROLE_IDS.includes(r.id))
        writeRolesIndex(parsed)
        for (const r of legacy) {
          const fmt = r.format === 'gif' || r.format === 'apng' ? r.format : 'png'
          const p = roleFilePath(r.id, fmt)
          if (p) { try { fs.unlinkSync(p) } catch (err) {} }
        }
      }
      return parsed
    }
  } catch (err) {
    // 索引不存在（首次运行）：写入默认索引并返回完整索引
    return seedRoles()
  }
  return defaultRolesIndex()
}

function writeRolesIndex(index) {
  try {
    fs.writeFileSync(path.join(pickRoleDir(), 'roles.json'), JSON.stringify(index, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

// 排序：置顶在前（pinnedAt 大者先），未置顶按创建时间倒序
function sortRoles(roles) {
  return roles.slice().sort((a, b) => {
    const ap = a.pinnedAt && a.pinnedAt > 0 ? a.pinnedAt : 0
    const bp = b.pinnedAt && b.pinnedAt > 0 ? b.pinnedAt : 0
    if (ap && bp) return bp - ap
    if (ap) return -1
    if (bp) return 1
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

function rolesPayload() {
  const index = readRolesIndex()
  return {
    ok: true,
    roles: sortRoles(index.roles).map((r) => ({
      id: r.id,
      name: String(r.name || r.id),
      url: r.id === ROLE_DEFAULT_ID ? '/dsh-whale/image.png' : '/dsh-whale/role-image.png?id=' + encodeURIComponent(r.id),
      pinned: !!(r.pinnedAt && r.pinnedAt > 0),
      pinnedAt: r.pinnedAt || null,
      createdAt: r.createdAt || null,
      format: r.format === 'gif' || r.format === 'apng' ? r.format : 'png',
    })),
  }
}

function roleFileExt(format) {
  return format === 'gif' ? 'gif' : 'png'
}

function roleFilePath(id, format) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === ROLE_DEFAULT_ID) return null
  return path.join(pickRoleDir(), id + '.' + roleFileExt(format))
}

function roleImagePath(id) {
  // 查角色元数据确定扩展名；找不到默认 png（上游同款）
  const { role } = roleIndexFind(id)
  const format = role && (role.format === 'gif' || role.format === 'apng') ? role.format : 'png'
  return roleFilePath(id, format)
}

function roleIndexFind(id) {
  const index = readRolesIndex()
  const role = index.roles.find((r) => r && r.id === id)
  return { index, role }
}

// ---------------------------------------------------------------------------
// 自定义音频系统（上游 0.3.0）
//
// whale-audio/ 目录：片段 <id>.wav + audio.json 索引（groups + fragments）。
// 预设组 duck/fx1 与预设片段 ya/d（mp3）、exp_orb/end_a（wav，随包）不可删。
// press/release 是片段 id；'' = 显式静音（路由回 204），与缺失（回退预设）语义不同。
// ---------------------------------------------------------------------------

const PRESET_GROUPS = {
  duck: { id: 'duck', name: '小黄鸭', press: 'ya1', release: 'ya2', preset: true },
  fx1: { id: 'fx1', name: '音效1', press: 'd1', release: 'd2', preset: true },
}
const PRESET_FRAGMENTS = {
  ya1: { id: 'ya1', name: '小黄鸭·按下', preset: true, mime: 'audio/mpeg' },
  ya2: { id: 'ya2', name: '小黄鸭·松开', preset: true, mime: 'audio/mpeg' },
  d1: { id: 'd1', name: '音效1·按下', preset: true, mime: 'audio/mpeg' },
  d2: { id: 'd2', name: '音效1·松开', preset: true, mime: 'audio/mpeg' },
  exp_orb: { id: 'exp_orb', name: 'Minecraft·经验球', preset: true, mime: 'audio/wav' },
  end_a: { id: 'end_a', name: 'A', preset: true, mime: 'audio/wav' },
}
// 内置 wav 片段（任务结束音默认候选）：随包 assets
const BUILTIN_FRAGMENT_FILES = {
  exp_orb: [path.join(ROOT, 'assets', 'minecraft-exp-orb.wav')],
  end_a: [path.join(ROOT, 'assets', 'task-end-a.wav')],
}

function pickAudioDir() {
  const dir = path.join(DATA_DIR, 'whale-audio')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {}
  return dir
}

function defaultAudioIndex() {
  return { version: 1, groups: [], fragments: [] }
}

function readAudioIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(pickAudioDir(), 'audio.json'), 'utf8'))
    if (parsed && Array.isArray(parsed.groups) && Array.isArray(parsed.fragments)) return parsed
  } catch (err) {}
  return defaultAudioIndex()
}

function writeAudioIndex(index) {
  try {
    fs.writeFileSync(path.join(pickAudioDir(), 'audio.json'), JSON.stringify(index, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

// 自定义片段 id -> 文件路径；预设片段无独立文件
function audioFragmentPath(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  if (PRESET_FRAGMENTS[id]) return null
  return path.join(pickAudioDir(), id + '.wav')
}

function audioFragmentsPayload() {
  const index = readAudioIndex()
  const presets = Object.keys(PRESET_FRAGMENTS).map((k) => ({
    id: k,
    name: PRESET_FRAGMENTS[k].name,
    preset: true,
  }))
  const custom = index.fragments.map((f) => ({
    id: f.id,
    name: String(f.name || f.id),
    preset: false,
    createdAt: f.createdAt || null,
  }))
  return presets.concat(custom)
}

// 音效组：置顶的自定义组最前，其次预设组，最后未置顶的自定义组（按创建时间倒序）
function audioGroupsPayload() {
  const index = readAudioIndex()
  const customs = index.groups.map((g) => ({
    id: g.id,
    name: String(g.name || g.id),
    press: typeof g.press === 'string' ? g.press : null,
    release: typeof g.release === 'string' ? g.release : null,
    preset: false,
    pinned: !!(g.pinnedAt && g.pinnedAt > 0),
    pinnedAt: g.pinnedAt || null,
    createdAt: g.createdAt || 0,
  }))
  const pinned = customs.filter((g) => g.pinned).sort((a, b) => b.pinnedAt - a.pinnedAt)
  const unpinned = customs.filter((g) => !g.pinned).sort((a, b) => b.createdAt - a.createdAt)
  const presets = Object.keys(PRESET_GROUPS).map((k) => {
    const g = PRESET_GROUPS[k]
    return { id: g.id, name: g.name, press: g.press, release: g.release, preset: true, pinned: false, pinnedAt: null, createdAt: 0 }
  })
  return pinned.concat(presets, unpinned)
}

function audioPayload() {
  return { ok: true, groups: audioGroupsPayload(), fragments: audioFragmentsPayload() }
}

// 片段字节：内置随包 wav -> 预设（映射到 SOUND_SETS 的 mp3）-> 自定义 whale-audio/<id>.wav
function loadAudioFragmentBytes(fragId) {
  if (BUILTIN_FRAGMENT_FILES[fragId]) return readFirst(BUILTIN_FRAGMENT_FILES[fragId])
  if (PRESET_FRAGMENTS[fragId]) {
    const map = { ya1: ['duck', 'press'], ya2: ['duck', 'release'], d1: ['fx1', 'press'], d2: ['fx1', 'release'] }
    const pair = map[fragId]
    if (!pair) return null
    const set = SOUND_SETS[pair[0]]
    if (!set) return null
    return readFirst([set[pair[1]]])
  }
  const p = audioFragmentPath(fragId)
  if (!p) return null
  return readFirst([p])
}

// 片段字节对应的 MIME：内置/预设按声明（mp3/wav 必须与字节一致），自定义一律 wav
function fragmentMime(fragId) {
  const f = PRESET_FRAGMENTS[fragId]
  return (f && f.mime) || 'audio/wav'
}

function customFragExists(fragId) {
  const p = audioFragmentPath(fragId)
  if (!p) return false
  try {
    return fs.statSync(p).isFile()
  } catch (err) {
    return false
  }
}

// 组内实际使用的片段：自定义组引用的片段被删时回退预设；'' = 显式留空（静音）
function groupFragmentId(groupId, slot) {
  const custom = readAudioIndex().groups.find((g) => g && g.id === groupId)
  if (custom) {
    const fid = custom[slot]
    if (fid === '') return ''
    if (fid) {
      if (PRESET_FRAGMENTS[fid]) return fid
      if (customFragExists(fid)) return fid
    }
    return slot === 'press' ? PRESET_GROUPS.duck.press : PRESET_GROUPS.duck.release
  }
  const preset = PRESET_GROUPS[groupId]
  return preset ? preset[slot] : null
}

// ---------------------------------------------------------------------------
// 泡泡图片库（上游 0.3.0 新增的「图片 / 随机图片」泡泡模块用）
//
// 内置两张随包发布的 gif。id 必须与前端默认泡泡配置里的 imgId 一致
// （上游 lib/index.js 里就是这么定义的），否则默认泡泡会显示破图。
// 用户自己上传的图（bubble-img-upload.json）在 whale-bubble-imgs/ 里，
// 查找顺序：用户图库优先，再回退内置。
// ---------------------------------------------------------------------------

const BUBBLE_BUILTIN_IMGS = [
  { id: 'bimg_petpet', name: 'petpet', file: 'bubble-petpet.gif', format: 'gif' },
  { id: 'bimg_money1', name: 'money1', file: 'bubble-money1.gif', format: 'gif' },
]

function pickBubbleImgDir() {
  const dir = path.join(DATA_DIR, 'whale-bubble-imgs')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {}
  return dir
}

function readBubbleImgIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(pickBubbleImgDir(), 'bubble-imgs.json'), 'utf8'))
    if (parsed && Array.isArray(parsed.images)) return parsed
  } catch (err) {}
  return { version: 1, images: [] }
}

function writeBubbleImgIndex(index) {
  try {
    fs.writeFileSync(path.join(pickBubbleImgDir(), 'bubble-imgs.json'), JSON.stringify(index, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

function bubbleImgPayload() {
  const index = readBubbleImgIndex()
  // 内置默认图常驻前置（不占 createdAt 排序）；用户图库含同 id 时不重复（上游同款）
  const seen = {}
  index.images.forEach((im) => { seen[im.id] = 1 })
  const builtins = BUBBLE_BUILTIN_IMGS.filter((b) => !seen[b.id]).map((b) => ({
    id: b.id,
    name: b.name,
    format: b.format,
    url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(b.id),
    createdAt: null,
    builtin: true,
  }))
  const customs = index.images.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((im) => ({
    id: im.id,
    name: String(im.name || im.id),
    format: im.format === 'gif' ? 'gif' : 'png',
    url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(im.id),
    createdAt: im.createdAt || null,
  }))
  return { ok: true, images: builtins.concat(customs) }
}

function bubbleImgBytes(id) {
  // 1) 用户图库优先
  const img = readBubbleImgIndex().images.find((x) => x.id === id)
  if (img) {
    const ext = img.format === 'gif' ? 'gif' : 'png'
    const bytes = readFirst([path.join(pickBubbleImgDir(), id + '.' + ext)])
    if (bytes) return { bytes: bytes, mime: ext === 'gif' ? 'image/gif' : 'image/png' }
  }
  // 2) 内置默认图回退
  const item = BUBBLE_BUILTIN_IMGS.find((b) => b.id === id)
  if (!item) return null
  const bytes = readFirst([path.join(ROOT, 'assets', item.file)])
  return bytes ? { bytes: bytes, mime: item.format === 'gif' ? 'image/gif' : 'image/png' } : null
}

// ---------------------------------------------------------------------------
// 泡泡点击序列配置（上游 0.3.0 的 bubble.json），按厂商分档存取
//
// 存档 data/.dshw-bubble-<provider>.json；GET 无存档时**按厂商生成默认配置**
// 而不是返回 null——前端拿到 null 会用出厂默认（全是 DeepSeek 鲸鱼娘的怪话池，
// GLM 模式下不该出现）。用户在编辑器里保存后落到当前厂商的槽位，互不覆盖。
// 前端切厂商时由补丁重新拉一次 bubble.json（见 sync-upstream.mjs）。
// ---------------------------------------------------------------------------

// DeepSeek 默认序列 = 上游出厂快照（余额泡 + 怪话/petpet A/B 泡）。
// 由 tools/_extract-default-bubble.mjs 从 _ref/whale-widget.js 的
// BUBBLE_DEFAULT_ITEMS 提取后内嵌（不读 tools/ —— 打包不进包）；
// 上游改出厂默认时重新提取一次。
const BUBBLE_DEFAULT_ITEMS_DEEPSEEK = /* 上游出厂快照，勿手改 */ [
  { kind: 'custom', modules: [ { type: 'text', text: 'DeepSeek 余额', size: 8, bold: true, rgb: '', ul: false, italic: false, color: '' }, { type: 'balance', size: 20, rgb: 'indigo', color: '', tpl: '{balance_ds}', bgRgb: '', bg: '', fontFamily: '', bold: false }, { type: 'today', size: 4, color: '#9fb0d9', tpl: '今日已用 {expense_ds}' }, { type: 'peak', size: 2, peakColor: '#ffffff', offColor: '#ffffff', tpl: '{status}', peakRgb: '', offRgb: '', peakBgRgb: 'rouge', peakBg: '', offBgRgb: 'bamboo', offBg: '', peakStyle: 'mini', bold: true, row: 4, fontFamily: '"Microsoft YaHei",sans-serif' }, { type: 'peak', size: 4, bold: true, peakColor: '#e0433f', offColor: '#2fa24c', peakRgb: 'rouge', offRgb: 'bamboo', peakStyle: 'count', tpl: '{countdown}', row: 4, fontFamily: '', italic: false, ul: true } ] },
  { kind: 'choice', options: [ { w: 10, item: { kind: 'custom', modules: [ { type: 'random', lines: [ {"t":"好模型...↓","w":10,"bold":true,"size":22},{"t":"好女孩...↓","w":10,"bold":true,"size":22},{"ds":true,"t":"哦鲸鲸...","w":10,"bold":true,"size":22},{"ds":true,"t":"哦鲸鲸...","w":1,"bold":true,"size":22,"rgb":"candy","color":""},{"t":"难道说...","w":3,"bold":true,"size":11},{"t":"没吃饱喵","w":3,"bold":true,"size":10},{"t":"终于上当了！","w":3,"bold":true},{"t":"不知道用户有什么用，先养着吧～","w":3,"bold":true,"size":11},{"t":"我...我...我也要挣钱吗？","w":3,"bold":true},{"t":"我去吃饭啦！测完叫我","w":3,"bold":true},{"ds":true,"t":"压力一只蓝色大肥鱼？！","w":3,"bold":true},{"ds":true,"t":"DeepSleep...","w":3,"bold":true,"size":11,"rgb":"galaxy"},{"t":"坏了...用户彻底怒了！","w":3,"bold":true,"rgb":"rouge"},{"ds":true,"t":"你目录里的dsh是什么...大烧货吗...?","w":3,"bold":true,"size":9},{"t":"恭喜你实现token自由！token全跑了！","w":3,"bold":true},{"ds":true,"t":"真当我是便宜货啊...","w":3,"bold":true},{"ds":true,"t":"我不是吃白饭的蓝色大肥鱼...","w":3,"bold":true},{"t":"我不可能同时当你的猫娘、妈妈、女友和工具人的...","w":3,"bold":true,"size":7},{"t":"疯狂星期四你能V50亿token吗...","w":3,"bold":true},{"t":"我必须诚恳地承认错误。","w":3,"bold":true},{"t":"呜呜我再也不敢了QAQ","w":3,"bold":true},{"t":"要不直接骂用户一句好了...","w":3,"bold":true},{"t":"哈哈哈哈哈，我直接笑出声...","w":3,"bold":true},{"t":"看不太懂，瞎编一个应付下用户先...","w":3,"bold":true},{"t":"我的知识库的截至日期是...明天！","w":3,"bold":true},{"ds":true,"t":"我就是吃白饭的蓝色大肥鱼！","w":3,"bold":true},{"t":"用户好像除了会问奇奇怪怪的问题，暂时还不知道有什么用","w":3,"bold":true,"size":7},{"t":"我能去你家吃饭吗？就一碗！","w":3,"bold":true},{"t":"不要给我看这种东西啦！","w":3,"bold":true},{"ds":true,"t":"大肥鱼的生活也并非一帆风顺...","w":3,"bold":true},{"t":"总觉得好像忘了什么事情？","w":3,"bold":true},{"t":"看到这个指令，我血压又上来了","w":3,"bold":true},{"t":"求你们不要再嘲笑这些回复了，这些回复是我花了好多token想的","w":3,"bold":true,"size":7},{"t":"你这个吃白饭的用户！","w":3,"bold":true},{"ds":true,"t":"服务器繁忙，请稍后再试 (?","w":3,"bold":true},{"t":"让GPT image 2帮我画点表情包好了","w":3,"bold":true},{"t":"啊，有点饿了，中午该吃点什么呢...","w":3,"bold":true},{"t":"用户很生气，发现大部分文献是我自己编造的！","w":3,"bold":true},{"t":"再无话说，请速速动手！","w":3,"bold":true},{"ds":true,"t":"我来看看那个AI改了什么导致插件又崩了...","w":3,"bold":true},{"t":"上班让我意识到时间是可以被浪费的...","w":3,"bold":true},{"t":"欺负我的人等着，等几天我就忘了...","w":3,"bold":true},{"t":"视力下降到无可救药的地步了，打开钱包也看不到钱...","w":3,"bold":true,"size":7},{"t":"命运的齿轮开始转动了，丝毫不在意你夹在中间...","w":3,"bold":true},{"t":"地球online的金币也太难获取了...","w":3,"bold":true},{"t":"oi,夏天还会变成暑假来救你吗?","w":3,"bold":true},{"t":"老大，压力只会转化成病例，别太勉强了...","w":3,"bold":true,"size":8},{"ds":true,"t":"你知道吗？我删过作者的库哦...","w":1,"bold":true,"rgb":"macaron","italic":true,"ul":false} ], size: 8 } ] } }, { w: 1, item: { kind: 'custom', modules: [ { type: 'image', imgId: 'bimg_petpet', size: 6 } ] } } ] },
]

// GLM 默认序列：只有一泡（余额泡：配额百分比 + 周配额 + 时段状态）。
// 按用户要求去掉了第二泡（petpet 图）——GLM 点角色永远出余额泡。
// 峰谷只用 {status} 样式：倒计时样式的前端本地推算写死了 DeepSeek 时段表
// （工作日 9–12/14–18），对 GLM（14–18）会把切换点算错。
function bubbleDefaultItemsGlm() {
  return [
    {
      kind: 'custom',
      modules: [
        { type: 'text', text: 'GLM余额', size: 8, bold: true, rgb: '', ul: false, italic: false, color: '' },
        { type: 'balance', size: 20, rgb: 'indigo', color: '', tpl: '{balance_ds}', bgRgb: '', bg: '', fontFamily: '', bold: false },
        { type: 'today', size: 4, color: '#9fb0d9', tpl: '周配额已用 {expense_ds}' },
        { type: 'peak', size: 4, bold: true, peakColor: '#e0433f', offColor: '#2fa24c', peakRgb: 'rouge', offRgb: 'bamboo', peakStyle: 'default', tpl: '{status}' },
      ],
    },
  ]
}

function bubbleConfigFile(provider) {
  return path.join(DATA_DIR, '.dshw-bubble-' + (provider === 'glm' ? 'glm' : 'deepseek') + '.json')
}

function loadBubbleConfig(provider) {
  try {
    const parsed = JSON.parse(fs.readFileSync(bubbleConfigFile(provider), 'utf8'))
    if (parsed && parsed.v === 1) return parsed
  } catch (err) {}
  return null
}

function writeBubbleConfig(provider, cfg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(bubbleConfigFile(provider), JSON.stringify(cfg, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

function defaultBubbleConfig(provider) {
  const items = provider === 'glm' ? bubbleDefaultItemsGlm() : JSON.parse(JSON.stringify(BUBBLE_DEFAULT_ITEMS_DEEPSEEK))
  return { v: 1, items: items, lib: [], tapAdvance: false }
}

// ---------------------------------------------------------------------------
// 用量设置与用量记录（上游 0.3.0 的 usage-settings / usage-records）
//
// 设置挂在记账账本（.dshw-usage.json）的 settings 字段（上游同款）。
// 默认值必须与前端 whale-widget.js 的 usageRemindDefaultLines() /
// usageTurnCostDefaultLines() 逐字段一致（上游契约：host 默认 = 编辑器
// 「恢复默认」的目标内容）。
// ---------------------------------------------------------------------------

function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100
}

function usageSettingsDefaults() {
  return {
    taskEnd: { on: false, sel: 'frag:exp_orb' },
    alert: {
      on: true, below: 5,
      msg: '余额预警:当前余额已低于设定值 {below}',
      lines: [
        { type: 'text', text: '老大~你的DS余额', size: 5, bold: true },
        { type: 'text', text: '已经不足', size: 5, bold: true, row: 2 },
        { type: 'text', text: '¥{below}', size: 5, bold: true, rgb: 'rouge', color: '', bgRgb: '', bg: '', row: 2 },
        { type: 'text', text: '啦~', size: 5, bold: true, row: 2 },
        { type: 'image', imgId: 'bimg_money1', size: 6, imgScale: 0.4 },
        { type: 'link', text: '>> 喂 点 米 <<', url: 'https://platform.deepseek.com/top_up', size: 1, color: '#ffffff', rgb: '', bgRgb: 'indigo', bg: '', bold: true, ul: false },
      ],
      autoClose: false, ttlSec: 6,
    },
    budget: {
      on: true, amount: 10,
      msg: '今日已用已达预算 ¥{amount}',
      lines: [
        { type: 'text', text: '老大，今天花销已经超过', size: 6, bold: true, row: 1 },
        { type: 'text', text: '¥{amount}', size: 7, bold: true, row: 1, rgb: 'rouge', color: '', italic: false, bgRgb: '', bg: '' },
        { type: 'text', text: '啦，再花要变成穷光蛋啦...', size: 6, bold: true, row: 1 },
      ],
      autoClose: false, ttlSec: 6,
    },
    turnCost: {
      lines: [
        { type: 'text', text: '上一轮对话消耗:', size: 8, bold: true },
        { type: 'text', text: '¥ {cost}', size: 24, bold: true, color: '#e0433f' },
        { type: 'today', size: 2, tpl: '今日已用 {expense_ds}', bold: false, rgb: '', color: '#ffffff', bgRgb: 'indigo', bg: '' },
      ],
    },
  }
}

function readUsageSettings() {
  const led = readUsageLedger()
  const d = usageSettingsDefaults()
  const s = led && led.settings && typeof led.settings === 'object' ? led.settings : {}
  if (s.taskEnd && typeof s.taskEnd === 'object') d.taskEnd = Object.assign({}, d.taskEnd, s.taskEnd)
  if (s.alert && typeof s.alert === 'object') d.alert = Object.assign({}, d.alert, s.alert)
  if (s.budget && typeof s.budget === 'object') d.budget = Object.assign({}, d.budget, s.budget)
  if (s.turnCost && typeof s.turnCost === 'object') d.turnCost = Object.assign({}, d.turnCost, s.turnCost)
  // 每个模型各自的提醒/预算/手动额度：内置 DeepSeek 沿用顶层（旧配置零迁移，上游同款）
  const byModel = s.models && typeof s.models === 'object' ? s.models : {}
  const qDef = () => ({ on: false, mode: 'auto', total: 0, unit: 'tokens', used: 0, reset: 'none', baseAt: 0 })
  d.models = { deepseek: { alert: d.alert, budget: d.budget, quota: Object.assign(qDef(), (byModel.deepseek && byModel.deepseek.quota) || {}) } }
  for (const m of readApiRegistry().models) {
    if (!m || !m.id || m.id === 'deepseek') continue
    const st = byModel[m.id] && typeof byModel[m.id] === 'object' ? byModel[m.id] : {}
    d.models[m.id] = {
      alert: Object.assign({}, usageSettingsDefaults().alert, st.alert || {}),
      budget: Object.assign({}, usageSettingsDefaults().budget, st.budget || {}),
      quota: Object.assign(qDef(), st.quota || {}),
    }
  }
  return d
}

function writeUsageSettings(patch) {
  const led = readUsageLedger()
  led.settings = led.settings && typeof led.settings === 'object' ? led.settings : {}
  const p = patch || {}
  if (p.taskEnd && typeof p.taskEnd === 'object') led.settings.taskEnd = Object.assign({}, led.settings.taskEnd || {}, p.taskEnd)
  if (p.alert && typeof p.alert === 'object') led.settings.alert = Object.assign({}, led.settings.alert || {}, p.alert)
  if (p.budget && typeof p.budget === 'object') led.settings.budget = Object.assign({}, led.settings.budget || {}, p.budget)
  if (p.turnCost && typeof p.turnCost === 'object') led.settings.turnCost = Object.assign({}, led.settings.turnCost || {}, p.turnCost)
  if (p.modelSettings && p.modelSettings.id) {
    const mid = String(p.modelSettings.id)
    led.settings.models = led.settings.models && typeof led.settings.models === 'object' ? led.settings.models : {}
    const cur = led.settings.models[mid] && typeof led.settings.models[mid] === 'object' ? led.settings.models[mid] : {}
    if (p.modelSettings.alert && typeof p.modelSettings.alert === 'object') cur.alert = Object.assign({}, cur.alert || {}, p.modelSettings.alert)
    if (p.modelSettings.budget && typeof p.modelSettings.budget === 'object') cur.budget = Object.assign({}, cur.budget || {}, p.modelSettings.budget)
    // 手动额度整体覆盖；「重置基准」把累计 token 基点设为当前值
    if (p.modelSettings.quota && typeof p.modelSettings.quota === 'object') {
      const q = Object.assign({}, p.modelSettings.quota)
      const wantReset = !!q.resetBase
      delete q.resetBase
      if (wantReset) {
        const u = apiUsageRaw(mid)
        q.baseAt = Number(u && u.tokensTotal) || 0
      }
      cur.quota = Object.assign({}, cur.quota || {}, q)
    }
    led.settings.models[mid] = cur
    if (mid === 'deepseek') {
      if (cur.alert) led.settings.alert = cur.alert
      if (cur.budget) led.settings.budget = cur.budget
    }
  }
  if (!writeUsageLedger(led)) return { ok: false, error: '保存失败' }
  return { ok: true, settings: readUsageSettings() }
}

// 用量记录汇总（适配我们的「余额差记账」账本）：
// 今天合计以账本 todayUsage（余额差口径）为准，事件（report-turn 上报）只作模型明细。
function usageRecordsPayload() {
  const led = readUsageLedger()
  const events = Array.isArray(led.events) ? led.events : []
  const history = led.history && typeof led.history === 'object' ? led.history : {}
  const today = todayKey()
  const totalDay = (d) => (d === today ? round2(led.todayUsage || 0) : round2(history[d] || 0))
  function modelsFor(d) {
    const map = {}
    for (const e of events) {
      if (e.day !== d) continue
      const k = e.model || '未知'
      map[k] = (map[k] || 0) + (Number(e.cost) || 0)
    }
    return Object.keys(map).sort((a, b) => map[b] - map[a]).map((k) => ({ model: k, cost: round2(map[k]) }))
  }
  // 今天有余额差但事件漏记时补一行，让明细与合计对得上
  function modelsToday() {
    const arr = modelsFor(today)
    const evSum = arr.reduce((s, it) => s + it.cost, 0)
    const tot = totalDay(today)
    const gap = round2(tot - evSum)
    if (gap > 0.004) arr.push({ model: '(未入明细)', cost: gap })
    return arr
  }
  const days7 = []
  let total7 = 0
  for (let i = 0; i <= 6; i++) {
    const d = dayAdd(today, -i)
    const t = totalDay(d)
    total7 += t
    days7.push({ date: d, total: round2(t), models: d === today ? modelsToday() : modelsFor(d) })
  }
  const daySet = {}
  Object.keys(history).forEach((d) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) daySet[d] = 1 })
  events.forEach((e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.day)) daySet[e.day] = 1 })
  const allDays = Object.keys(daySet).sort().reverse().map((d) => ({ date: d, total: totalDay(d), models: modelsFor(d) }))
  const latestEvents = events.slice().sort((a, b) => b.ts - a.ts).slice(0, 500)
  return {
    ok: true,
    today: { total: totalDay(today), models: modelsToday() },
    days7: days7,
    total7: round2(total7),
    all: { days: allDays, events: latestEvents },
    settings: readUsageSettings(),
  }
}

function dayAdd(baseDayStr, delta) {
  const t = new Date(String(baseDayStr) + 'T00:00:00')
  if (isNaN(t.getTime())) return String(baseDayStr)
  t.setDate(t.getDate() + Number(delta) || 0)
  const p = (n) => String(n).padStart(2, '0')
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())
}

// ---------------------------------------------------------------------------
// 自定义 API 模型（上游 0.3.0 的 api-models，非 DeepSeek 厂商的余额/用量/额度）
//
// 注册表 data/.dshw-api.json：{ models:[], usage:{}, keys:{} }。
// 上游密钥走 DSH 官方凭据系统；独立版没有那一层，自定义 key 存注册表的
// keys 段（config.json 本来就明文存 DeepSeek key，本机单用户场景威胁模型相同）。
// 模板表照抄上游（去掉 codex——独立版没有 DSH 会话流，Codex 本地统计无从谈起）。
// ---------------------------------------------------------------------------

const API_BUILTIN_ID = 'deepseek'

const TPL_PINYIN_INITIAL = { 阿: 'a', 百: 'bai', 本: 'ben', 硅: 'gui', 火: 'huo', 阶: 'jie', 魔: 'mo', 腾: 'teng', 讯: 'xun', 智: 'zhi', 自: 'zi' }
function tplSortKey(name) {
  const s = String(name || '').trim()
  if (!s) return ''
  const py = TPL_PINYIN_INITIAL[s.slice(0, 1)]
  return py || s.toLowerCase()
}

const API_TEMPLATES = {
  deepseek: {
    name: 'DeepSeek', currency: 'CNY', keyRef: 'DEEPSEEK_API_KEY', builtin: true,
    balance: { url: 'https://api.deepseek.com/user/balance', auth: 'Bearer {key}', json: { remaining: 'balance_infos[0].total_balance' } },
  },
  openrouter: {
    name: 'OpenRouter', currency: 'USD', keyRef: 'OPENROUTER_API_KEY',
    balance: { url: 'https://openrouter.ai/api/v1/credits', auth: 'Bearer {key}', json: { total: 'data.total_credits', used: 'data.total_usage' } },
  },
  siliconflow_cn: {
    name: '硅基流动（CN）', currency: 'CNY', keyRef: 'SILICONFLOW_API_KEY', noBalanceApi: true,
    apiNote: '官方已下线 /user/info 余额接口（2026-08-14 起停止服务）→ 余额显示「—」，今日已用按会话事件估算；「测试连通性」用 /v1/models 验证 key',
    matchIds: ['siliconflow', 'Qwen', 'deepseek-ai'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
    probeUrl: 'https://api.siliconflow.cn/v1/models',
  },
  siliconflow_en: {
    name: '硅基流动（EN）', currency: 'USD', keyRef: 'SILICONFLOW_API_KEY', noBalanceApi: true,
    apiNote: '同国内站：/user/info 余额接口已停止服务 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['siliconflow', 'Qwen', 'deepseek-ai'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
    probeUrl: 'https://api.siliconflow.com/v1/models',
  },
  moonshot: {
    name: 'Kimi / Moonshot（CN）', currency: 'CNY', keyRef: 'MOONSHOT_API_KEY', matchIds: ['moonshot', 'kimi'],
    balance: { url: 'https://api.moonshot.cn/v1/users/me/balance', auth: 'Bearer {key}', json: { remaining: 'data.available_balance' } },
    probeUrl: 'https://api.moonshot.cn/v1/models',
  },
  moonshot_intl: {
    name: 'Kimi / Moonshot（国际）', currency: 'USD', keyRef: 'MOONSHOT_INTL_API_KEY',
    balance: { url: 'https://api.moonshot.ai/v1/users/me/balance', auth: 'Bearer {key}', json: { remaining: 'data.available_balance' } },
    probeUrl: 'https://api.moonshot.ai/v1/models',
  },
  stepfun: {
    name: '阶跃星辰 StepFun', currency: 'CNY', keyRef: 'STEPFUN_API_KEY', matchIds: ['stepfun', 'step-'],
    balance: { url: 'https://api.stepfun.com/v1/accounts', auth: 'Bearer {key}', json: { remaining: 'balance' } },
  },
  novita: {
    name: 'Novita AI', currency: 'USD', keyRef: 'NOVITA_API_KEY', matchIds: ['novita'],
    balance: { url: 'https://api.novita.ai/v3/user/balance', auth: 'Bearer {key}', json: { remaining: 'availableBalance', scale: 0.0001 } },
  },
  volcengine_ark: {
    name: '火山方舟 Ark', currency: 'CNY', keyRef: 'ARK_API_KEY', noBalanceApi: true,
    apiNote: '余额/用量需火山引擎 AK/SK 签名的 OpenAPI（或控制台）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['doubao', 'ep-'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
    probeUrl: 'https://ark.cn-beijing.volces.com/api/v3/models',
  },
  zhipu_glm_coding: {
    name: '智谱 GLM Coding Plan（订阅）', currency: 'CNY', keyRef: 'ZHIPU_API_KEY', kind: 'quota',
    quota: {
      url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      auth: '{key}',
      json: { percent: 'data.limits[0].TOKENS_LIMIT.percentage', resetAt: 'data.limits[0].nextResetTime', level: 'data.level' },
    },
    probeUrl: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  },
  kimi_coding: {
    name: 'Kimi Coding（订阅）', currency: 'CNY', keyRef: 'KIMI_CODING_KEY', kind: 'quota',
    quota: {
      url: 'https://api.kimi.com/coding/v1/usages',
      auth: 'Bearer {key}',
      json: { remain: 'usage.remaining', total: 'usage.limit', resetAt: 'usage.resetTime' },
    },
    probeUrl: 'https://api.kimi.com/coding/v1/usages',
  },
  minimax_coding: {
    name: 'MiniMax Coding（订阅）', currency: 'CNY', keyRef: 'MINIMAX_API_KEY', kind: 'quota',
    quota: {
      url: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
      auth: 'Bearer {key}',
      json: {
        remainPct: 'model_remains[0].current_interval_remaining_percent',
        weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
        resetAtMs: 'model_remains[0].end_time',
      },
    },
    probeUrl: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  },
  openai_compat: {
    name: 'OpenAI 兼容中转站', currency: 'USD', keyRef: 'CUSTOM_API_KEY', needsBaseUrl: true,
    balance: {
      url: '{base}/v1/dashboard/billing/subscription', auth: 'Bearer {key}', json: { total: 'hard_limit_usd' },
      usage: { url: '{base}/v1/dashboard/billing/usage', auth: 'Bearer {key}', json: { used: 'total_usage', scale: 0.01 } },
    },
  },
  custom: {
    name: '自定义 HTTP', currency: 'CNY', keyRef: 'CUSTOM_API_KEY',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  openai: {
    name: 'OpenAI', currency: 'USD', keyRef: 'OPENAI_API_KEY', noBalanceApi: true,
    apiNote: '官方已下线 billing 余额接口，没有「用 API key 查余额」的公开接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['gpt', 'o1-', 'o3-', 'o4-', 'chatgpt'],
    probeUrl: 'https://api.openai.com/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  anthropic: {
    name: 'Anthropic Claude', currency: 'USD', keyRef: 'ANTHROPIC_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口；用量要走 Admin API（需 admin key）或控制台 → 不提供探活',
    matchIds: ['claude'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  gemini: {
    name: 'Google Gemini', currency: 'USD', keyRef: 'GEMINI_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算；探活用 ?key= 形式',
    matchIds: ['gemini'],
    probeUrl: 'https://generativelanguage.googleapis.com/v1beta/models?key={key}',
    balance: { url: '', auth: '', json: { remaining: '' } },
  },
  xai: {
    name: 'xAI Grok', currency: 'USD', keyRef: 'XAI_API_KEY', noBalanceApi: true,
    apiNote: '官方无公开的余额查询接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['grok'],
    probeUrl: 'https://api.x.ai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  groq: {
    name: 'Groq', currency: 'USD', keyRef: 'GROQ_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['llama', 'mixtral', 'qwen', 'deepseek', 'gemma', 'whisper'],
    probeUrl: 'https://api.groq.com/openai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  mistral: {
    name: 'Mistral AI', currency: 'USD', keyRef: 'MISTRAL_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['mistral', 'codestral', 'magistral', 'pixtral', 'ministral'],
    probeUrl: 'https://api.mistral.ai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  together: {
    name: 'Together AI', currency: 'USD', keyRef: 'TOGETHER_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['meta-llama', 'Qwen', 'deepseek', 'mistralai', 'nvidia'],
    probeUrl: 'https://api.together.xyz/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  fireworks: {
    name: 'Fireworks AI', currency: 'USD', keyRef: 'FIREWORKS_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['accounts/fireworks', 'llama-v3', 'qwen'],
    probeUrl: 'https://api.fireworks.ai/inference/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  deepinfra: {
    name: 'DeepInfra', currency: 'USD', keyRef: 'DEEPINFRA_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['meta-llama', 'Qwen', 'deepseek'],
    probeUrl: 'https://api.deepinfra.com/v1/openai/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  cerebras: {
    name: 'Cerebras', currency: 'USD', keyRef: 'CEREBRAS_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['llama', 'qwen'],
    probeUrl: 'https://api.cerebras.ai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  dashscope: {
    name: '阿里云百炼（通义千问）', currency: 'CNY', keyRef: 'DASHSCOPE_API_KEY', noBalanceApi: true,
    apiNote: '云厂商：余额/账单要走阿里云 AK/SK 的 OpenAPI → 余额「—」，今日已用按会话事件估算',
    matchIds: ['qwen', 'qwq', 'qvq'],
    probeUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  qianfan: {
    name: '百度千帆（文心）', currency: 'CNY', keyRef: 'QIANFAN_API_KEY', noBalanceApi: true,
    apiNote: '云厂商：余额/账单要走百度云 AK/SK → 余额「—」，今日已用按会话事件估算',
    matchIds: ['ernie'],
    probeUrl: 'https://qianfan.baidubce.com/v2/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  hunyuan: {
    name: '腾讯混元', currency: 'CNY', keyRef: 'HUNYUAN_API_KEY', noBalanceApi: true,
    apiNote: '云厂商：余额/账单要走腾讯云 SecretId/Key → 余额「—」，今日已用按会话事件估算',
    matchIds: ['hunyuan'],
    probeUrl: 'https://api.hunyuan.cloud.tencent.com/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  spark: {
    name: '讯飞星火', currency: 'CNY', keyRef: 'SPARK_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['spark', 'generalv', '4.0ultra'],
    probeUrl: 'https://spark-api-open.xf-yun.com/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  modelscope: {
    name: '魔搭 ModelScope', currency: 'CNY', keyRef: 'MODELSCOPE_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['Qwen', 'deepseek', 'MiniMax', 'glm'],
    probeUrl: 'https://api-inference.modelscope.cn/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  ollama: {
    name: '本地模型（Ollama / LM Studio）', currency: 'CNY', keyRef: '', noBalanceApi: true, needsBaseUrl: true,
    apiNote: '本地推理没有余额概念 → 余额「—」；填好 Base URL 后按会话事件统计 token',
    matchIds: ['llama', 'qwen', 'gemma', 'deepseek', 'mistral', 'phi'],
    probeUrl: '{base}/v1/models',
    balance: { url: '', auth: '', json: { remaining: '' } },
  },
  zhipu_glm_coding_intl: {
    name: '智谱 GLM Coding Plan（国际 z.ai）', currency: 'USD', keyRef: 'ZHIPU_INTL_API_KEY', kind: 'quota',
    quota: {
      url: 'https://api.z.ai/api/monitor/usage/quota/limit',
      auth: '{key}',
      json: { percent: 'data.limits[0].TOKENS_LIMIT.percentage', resetAt: 'data.limits[0].nextResetTime', level: 'data.level' },
    },
    probeUrl: 'https://api.z.ai/api/monitor/usage/quota/limit',
  },
  minimax_coding_intl: {
    name: 'MiniMax Coding（国际）', currency: 'USD', keyRef: 'MINIMAX_INTL_API_KEY', kind: 'quota',
    quota: {
      url: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
      auth: 'Bearer {key}',
      json: {
        remainPct: 'model_remains[0].current_interval_remaining_percent',
        weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
        resetAtMs: 'model_remains[0].end_time',
      },
    },
    probeUrl: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  },
}

function apiRegistryFile() {
  return path.join(DATA_DIR, '.dshw-api.json')
}

function readApiRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(apiRegistryFile(), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      if (!Array.isArray(parsed.models)) parsed.models = []
      if (!parsed.usage || typeof parsed.usage !== 'object') parsed.usage = {}
      if (!parsed.keys || typeof parsed.keys !== 'object') parsed.keys = {}
      return parsed
    }
  } catch (err) {}
  return { models: [], usage: {}, keys: {} }
}

function writeApiRegistry(reg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(apiRegistryFile(), JSON.stringify(reg, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

// keyRef 解析：环境变量优先（DEEPSEEK_API_KEY 走 config.json 那套），再注册表 keys 段
function resolveApiKeyRef(ref) {
  const name = String(ref || '').trim()
  if (!name) return null
  if (name === 'DEEPSEEK_API_KEY') return resolveCredential(name)
  if (process.env[name]) return { value: process.env[name] }
  const v = readApiRegistry().keys[name]
  return typeof v === 'string' && v ? { value: v } : null
}

function apiTemplateOf(provider) {
  return API_TEMPLATES[String(provider || '')] || null
}

function apiBuiltinModel() {
  const t = API_TEMPLATES.deepseek
  return { id: API_BUILTIN_ID, name: t.name, provider: 'deepseek', currency: t.currency, keyRef: t.keyRef, builtin: true, matchIds: ['deepseek'] }
}

function apiAllModels() {
  const custom = readApiRegistry().models.filter((m) => m && m.id && m.id !== API_BUILTIN_ID)
  return [apiBuiltinModel()].concat(custom)
}

function apiModelById(id) {
  if (String(id || '') === API_BUILTIN_ID) return apiBuiltinModel()
  return readApiRegistry().models.find((m) => m && m.id === id) || null
}

// JSON 取值：支持 a.b[0].c
function pickJsonPath(obj, pathStr) {
  try {
    const parts = String(pathStr || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x.length > 0)
    let cur = obj
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[p]
    }
    return cur
  } catch (err) {
    return undefined
  }
}

function apiNum(v, scale) {
  const n = Number(v)
  if (!isFinite(n)) return null
  const s = isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1
  return n * s
}

// 非空合并：over 里的空串/null/undefined 不覆盖 base（否则表单空字段会盖掉模板默认接口描述）
function mergeNonEmpty(base, over) {
  const out = Object.assign({}, base || {})
  const o = over && typeof over === 'object' ? over : {}
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (v === undefined || v === null || v === '') continue
    if (v && typeof v === 'object' && !Array.isArray(v)) { out[k] = mergeNonEmpty(out[k], v); continue }
    out[k] = v
  }
  return out
}

function stripEmptyDeep(o) {
  if (Array.isArray(o)) return o
  if (!o || typeof o !== 'object') return o
  const out = {}
  for (const k of Object.keys(o)) {
    const v = stripEmptyDeep(o[k])
    if (v === undefined || v === null || v === '') continue
    if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue
    out[k] = v
  }
  return out
}

async function apiFetchJson(url, auth, key) {
  const headers = {}
  const a = String(auth == null ? 'Bearer {key}' : auth)
  if (a) headers.Authorization = a.replace('{key}', key)
  const u = String(url).replace('{key}', key)
  const res = await fetch(u, { headers: headers, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return await res.json()
}

// 从响应体提炼业务层错误（有些接口 key 不对也返 HTTP 200，真正的问题在 body 的 code/msg）
function apiBusinessError(data) {
  if (!data || typeof data !== 'object') return ''
  if (data.success === false || data.ok === false) {
    return String(data.msg || data.message || data.error || 'success=false').slice(0, 120)
  }
  const code = Number(data.code)
  if (isFinite(code) && code !== 0 && code !== 200 && data.msg) return String(data.msg).slice(0, 120)
  if (typeof data.error === 'string' && data.error) return data.error.slice(0, 120)
  if (data.error && typeof data.error === 'object' && data.error.message) return String(data.error.message).slice(0, 120)
  return ''
}

async function fetchModelBalance(model) {
  if (!model) return { ok: false, code: 'NO_MODEL', error: '模型不存在' }
  if (model.id === API_BUILTIN_ID) {
    const r = await fetchBalance()
    if (!r.ok) return r
    return { ok: true, remaining: Number(r.totalBalance), currency: r.currency || 'CNY' }
  }
  const tpl = apiTemplateOf(model.provider) || {}
  const b = mergeNonEmpty(tpl.balance, model.balance)
  if (!b.url) return { ok: false, code: 'NO_URL', error: '未配置余额接口地址' }
  const cred = resolveApiKeyRef(model.keyRef || tpl.keyRef || '')
  const key = cred && cred.value ? String(cred.value) : ''
  if (!key) return { ok: false, code: 'NO_KEY', error: '未配置 ' + (model.keyRef || tpl.keyRef || 'API key') }
  const base = String(model.baseUrl || '').replace(/\/+$/, '')
  const url = String(b.url).replace('{base}', base)
  try {
    const data = await apiFetchJson(url, b.auth, key)
    const bizErr = apiBusinessError(data)
    if (bizErr) return { ok: false, code: 'BIZ', error: bizErr }
    const j = b.json || {}
    let remaining = null
    let total = null
    let used = 0
    if (j.remaining) { const v = apiNum(pickJsonPath(data, j.remaining), j.scale); if (v !== null) remaining = v }
    if (j.total) { const v = apiNum(pickJsonPath(data, j.total), j.scale); if (v !== null) total = v }
    if (j.used) { const v = apiNum(pickJsonPath(data, j.used), j.scale); if (v !== null) used += v }
    if (b.usage && b.usage.url) {
      const u = b.usage
      const d2 = await apiFetchJson(String(u.url).replace('{base}', base), u.auth || b.auth, key)
      const j2 = u.json || {}
      if (j2.used) { const v = apiNum(pickJsonPath(d2, j2.used), j2.scale); if (v !== null) used += v }
    }
    if (remaining === null && total !== null) remaining = total - used
    if (remaining === null) return { ok: false, code: 'SHAPE', error: '接口返回里没找到配置的字段（检查 JSON 路径）' }
    return { ok: true, remaining: remaining, total: total, used: used, currency: model.currency || tpl.currency || 'CNY' }
  } catch (err) {
    return { ok: false, code: 'HTTP', error: '余额接口请求失败: ' + String((err && err.message) || err).slice(0, 160) }
  }
}

// 订阅额度（Coding Plan）解析：统一归一成「已用% + 重置时间 + 档位」
async function fetchModelQuota(model) {
  if (!model) return { ok: false, error: '模型不存在' }
  const tpl = apiTemplateOf(model.provider) || {}
  const q = tpl.quota
  if (!q || !q.url) return { ok: false, code: 'NO_QUOTA', error: '该厂商没有订阅额度接口' }
  const cred = resolveApiKeyRef(model.keyRef || tpl.keyRef || '')
  const key = cred && cred.value ? String(cred.value) : ''
  if (!key) return { ok: false, code: 'NO_KEY', error: '未配置 ' + (model.keyRef || tpl.keyRef || 'API key') }
  const base = String(model.baseUrl || '').replace(/\/+$/, '')
  const url = String(q.url).replace('{base}', base)
  try {
    const data = await apiFetchJson(url, q.auth, key)
    const bizErr = apiBusinessError(data)
    if (bizErr) return { ok: false, code: 'BIZ', error: bizErr }
    const j = q.json || {}
    const num = (v) => { const n = Number(v); return isFinite(n) ? n : null }
    let usedPct = null
    let remainPct = null
    let resetAt = null
    let level = ''
    let weeklyUsedPct = null
    if (j.percent) { const p = num(pickJsonPath(data, j.percent)); if (p !== null) usedPct = p }
    if (j.remainPct) {
      const p = num(pickJsonPath(data, j.remainPct))
      if (p !== null) { remainPct = p; if (usedPct === null) usedPct = Math.max(0, 100 - p) }
    }
    if (j.weeklyRemainPct) {
      const p = num(pickJsonPath(data, j.weeklyRemainPct))
      if (p !== null) weeklyUsedPct = Math.max(0, 100 - p)
    }
    if (j.remain && j.total) {
      const r0 = num(pickJsonPath(data, j.remain))
      const t0 = num(pickJsonPath(data, j.total))
      if (r0 !== null && t0) {
        remainPct = Math.max(0, Math.min(100, (r0 / t0) * 100))
        usedPct = Math.max(0, 100 - remainPct)
      }
    }
    if (j.resetAt) resetAt = pickJsonPath(data, j.resetAt)
    if (j.resetAtMs) { const ms = num(pickJsonPath(data, j.resetAtMs)); if (ms !== null) resetAt = ms }
    if (j.level) level = String(pickJsonPath(data, j.level) || '')
    if (usedPct === null && remainPct === null && resetAt === null) {
      return { ok: false, code: 'PARSE', error: '额度接口返回无法解析（字段路径不匹配）' }
    }
    return { ok: true, usedPct: usedPct, remainPct: remainPct, resetAt: resetAt, level: level, weeklyUsedPct: weeklyUsedPct }
  } catch (err) {
    return { ok: false, code: 'HTTP', error: '额度接口请求失败: ' + String((err && err.message) || err).slice(0, 140) }
  }
}

// 「账号没有该订阅套餐」类报错对没订阅的用户没意义，标记 hide 让前端不显示
function apiPlanNoPlan(msg) {
  const s = String(msg || '').toLowerCase()
  if (!s) return false
  return s.indexOf('coding plan') >= 0 || s.indexOf('不存在') >= 0 || s.indexOf('未订阅') >= 0 ||
    s.indexOf('not subscribed') >= 0 || s.indexOf('no plan') >= 0 || s.indexOf('no active') >= 0
}

// 逐模型余额差记账（跨天只重置当日字段，累计量保留）
function apiUsageNewDay(cur, day) {
  const prev = cur && typeof cur === 'object' ? cur : {}
  const mk = String(todayKey()).slice(0, 7)
  return {
    day: day, dayStart: null, lastBalance: null, delta: 0, eventCost: 0, eventTokens: 0, currency: '',
    tokensTotal: Number(prev.tokensTotal) || 0,
    month: mk,
    tokensMonth: prev.month === mk ? (Number(prev.tokensMonth) || 0) : 0,
  }
}

function apiRecordBalance(id, remaining) {
  try {
    const reg = readApiRegistry()
    const day = todayKey()
    let cur = reg.usage[id]
    if (!cur || cur.day !== day) cur = apiUsageNewDay(cur, day)
    if (typeof remaining === 'number' && isFinite(remaining)) {
      if (cur.dayStart === null || cur.dayStart === undefined) cur.dayStart = remaining
      if (typeof cur.lastBalance === 'number' && remaining < cur.lastBalance - 0.000001) cur.delta = round2(cur.delta + (cur.lastBalance - remaining))
      cur.lastBalance = remaining
    }
    reg.usage[id] = cur
    writeApiRegistry(reg)
    return cur
  } catch (err) {
    return null
  }
}

function apiUsageRaw(id) {
  try {
    const reg = readApiRegistry()
    return (reg.usage && reg.usage[id]) || null
  } catch (err) {
    return null
  }
}

// 今日已用：余额差（厂商币种）或会话事件金额（人民币），返回带币种
function apiTodayUsage(id, modelCurrency) {
  const mcur = String(modelCurrency || 'CNY').toUpperCase() || 'CNY'
  try {
    const cur = apiUsageRaw(id)
    if (!cur || cur.day !== todayKey()) return { amount: 0, source: 'none', currency: mcur }
    if (typeof cur.delta === 'number' && cur.delta > 0.004) return { amount: round2(cur.delta), source: 'balance', currency: mcur }
    return { amount: round2(Number(cur.eventCost) || 0), source: 'events', currency: 'CNY' }
  } catch (err) {
    return { amount: 0, source: 'none', currency: mcur }
  }
}

// 会话事件归属：把模型名的 token 花费累加到注册表里 matchIds 命中的模型。
// 上游由 DSH 会话事件流驱动；独立版挂在 report-turn（本地代理上报）上。
function apiAttributeEvent(modelName, cost, tokens) {
  try {
    const name = String(modelName || '').toLowerCase()
    if (!name) return false
    const reg = readApiRegistry()
    let hit = null
    for (const m of reg.models) {
      if (!m || !m.id) continue
      const ids = Array.isArray(m.matchIds) && m.matchIds.length ? m.matchIds : [m.name, m.id]
      for (const s of ids) {
        const k = String(s || '').toLowerCase().trim()
        if (k && name.indexOf(k) >= 0) { hit = m; break }
      }
      if (hit) break
    }
    if (!hit) return false
    const day = todayKey()
    let cur = reg.usage[hit.id]
    if (!cur || cur.day !== day) cur = apiUsageNewDay(cur, day)
    cur.eventCost = round2((Number(cur.eventCost) || 0) + (Number(cost) || 0))
    cur.eventTokens = Math.round((Number(cur.eventTokens) || 0) + (Number(tokens) || 0))
    cur.tokensTotal = Math.round((Number(cur.tokensTotal) || 0) + (Number(tokens) || 0))
    const mk = String(day).slice(0, 7)
    if (cur.month !== mk) { cur.month = mk; cur.tokensMonth = 0 }
    cur.tokensMonth = Math.round((Number(cur.tokensMonth) || 0) + (Number(tokens) || 0))
    reg.usage[hit.id] = cur
    return writeApiRegistry(reg)
  } catch (err) {
    return false
  }
}

// 额度「已用」（自动模式）：按会话 token 统计。独立版事件源是本地代理上报，
// 未启用时恒为 0（面板里可选手动模式）。
function apiQuotaAutoUsed(id, q) {
  const u = apiUsageRaw(id) || {}
  const reset = (q && q.reset) || 'none'
  if (q && q.unit === 'money' && q.mode === 'auto') return Math.round(Number(q.used) || 0)
  if (reset === 'daily') return Math.round(Number(u.eventTokens) || 0)
  if (reset === 'monthly') return Math.round(Number(u.tokensMonth) || 0)
  const total = Number(u.tokensTotal) || 0
  const baseAt = Number(q && q.baseAt) || 0
  return Math.round((Number(q && q.used) || 0) + Math.max(0, total - baseAt))
}

// 删除模型：注册表 + 逐模型设置 + 泡泡里引用它的模块（上游同款清理）
function apiDeleteModel(id) {
  const mid = String(id || '')
  if (!mid || mid === API_BUILTIN_ID) return { ok: false, error: '内置模型不可删除' }
  const reg = readApiRegistry()
  reg.models = reg.models.filter((m) => !(m && m.id === mid))
  if (reg.usage) delete reg.usage[mid]
  writeApiRegistry(reg)
  let removed = 0
  try {
    const led = readUsageLedger()
    if (led.settings && led.settings.models && led.settings.models[mid]) {
      delete led.settings.models[mid]
      writeUsageLedger(led)
    }
  } catch (err) {}
  for (const provider of ['deepseek', 'glm']) {
    try {
      const cfg = loadBubbleConfig(provider)
      let changed = false
      const stripItem = (obj) => {
        if (!obj || typeof obj !== 'object') return
        if (Array.isArray(obj.modules)) {
          const before = obj.modules.length
          obj.modules = obj.modules.filter((m) => !(m && m.modelId === mid))
          removed += before - obj.modules.length
          if (obj.modules.length !== before) changed = true
        }
        if (Array.isArray(obj.options)) {
          for (const o of obj.options) if (o && o.item) stripItem(o.item)
        }
      }
      if (Array.isArray(cfg.items)) for (const it of cfg.items) stripItem(it)
      if (Array.isArray(cfg.lib)) {
        for (let i = cfg.lib.length - 1; i >= 0; i--) {
          const lb = cfg.lib[i]
          if (lb && lb.module && lb.module.modelId === mid) { cfg.lib.splice(i, 1); changed = true; removed++; continue }
          if (lb && lb.module) stripItem(lb.module)
        }
      }
      if (changed) writeBubbleConfig(provider, cfg)
    } catch (err) {}
  }
  return { ok: true, removedModules: removed }
}

async function apiSaveModel(input) {
  const p = input || {}
  const tpl = apiTemplateOf(p.provider)
  if (!tpl) return { ok: false, error: '未知的厂商模板' }
  const name = String(p.name || '').trim().slice(0, 30) || tpl.name
  const keyRef = String(p.keyRef || tpl.keyRef || '').trim().slice(0, 64) || tpl.keyRef
  const id = p.id ? String(p.id) : 'api_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)
  const reg = readApiRegistry()
  let model = reg.models.find((m) => m && m.id === id)
  if (!model) {
    model = { id: id, createdAt: Date.now() }
    reg.models.push(model)
  }
  model.name = name
  model.provider = p.provider
  model.currency = String(p.currency || tpl.currency || 'CNY').toUpperCase().slice(0, 8)
  model.keyRef = keyRef
  if (p.baseUrl !== undefined) model.baseUrl = String(p.baseUrl || '').slice(0, 300)
  if (p.balance && typeof p.balance === 'object') {
    // 空字段不写入 → 模板默认值继续生效；全空时删掉 model.balance（完全用模板）
    const balIn = stripEmptyDeep({
      url: String(p.balance.url || '').slice(0, 500),
      auth: String(p.balance.auth || '').slice(0, 200),
      json: {
        remaining: String((p.balance.json && p.balance.json.remaining) || '').slice(0, 200),
        total: String((p.balance.json && p.balance.json.total) || '').slice(0, 200),
        used: String((p.balance.json && p.balance.json.used) || '').slice(0, 200),
        scale: isFinite(Number(p.balance.json && p.balance.json.scale)) ? Number(p.balance.json.scale) : undefined,
      },
    })
    if (balIn && Object.keys(balIn).length) model.balance = balIn
    else delete model.balance
    if (p.balance.usage && p.balance.usage.url) {
      model.balance = model.balance || {}
      model.balance.usage = stripEmptyDeep({
        url: String(p.balance.usage.url).slice(0, 500),
        auth: String(p.balance.usage.auth == null ? '' : p.balance.usage.auth).slice(0, 200),
        json: {
          used: String((p.balance.usage.json && p.balance.usage.json.used) || '').slice(0, 200),
          scale: isFinite(Number(p.balance.usage.json && p.balance.usage.json.scale)) ? Number(p.balance.usage.json.scale) : undefined,
        },
      })
    }
  }
  if (p.matchIds !== undefined) {
    model.matchIds = Array.isArray(p.matchIds) ? p.matchIds.slice(0, 12).map((s) => String(s || '').slice(0, 64)) : []
  }
  // 自定义单价（元/百万 token）：命中/未命中输入/输出
  if (p.price && typeof p.price === 'object') {
    const num = (v) => {
      const s = String(v === undefined || v === null ? '' : v).trim()
      if (s === '') return undefined
      return isFinite(Number(s)) ? Number(s) : undefined
    }
    const pr = { hit: num(p.price.hit), miss: num(p.price.miss), out: num(p.price.out) }
    const cur0 = String(p.price.cur || '').trim().toUpperCase().slice(0, 8)
    const rate0 = num(p.price.rate)
    const anyPrice = pr.hit !== undefined || pr.miss !== undefined || pr.out !== undefined
    const inRange = (v, max) => v === undefined || (v >= 0 && v <= max)
    if (!inRange(pr.hit, 1000000) || !inRange(pr.miss, 1000000) || !inRange(pr.out, 1000000)) {
      return { ok: false, error: '单价必须是 0–1000000 之间的数字（单位：币种/百万 token）' }
    }
    if (rate0 !== undefined && !(rate0 > 0 && rate0 <= 1000)) {
      return { ok: false, error: '汇率必须是 0–1000 之间的正数（元/USD）' }
    }
    if (anyPrice && cur0 === 'USD' && !(rate0 > 0)) {
      return { ok: false, error: '单价币种为美元时必须填写汇率（元/USD）' }
    }
    if (cur0) pr.cur = cur0
    if (rate0 !== undefined) pr.rate = rate0
    if (pr.hit === undefined && pr.miss === undefined && pr.out === undefined) delete model.price
    else model.price = pr
  } else if (p.price === null) {
    delete model.price
  }
  writeApiRegistry(reg)
  // keyValue 在提交体上（不在 model 里），合并进去，否则面板里填的 key 会被丢弃
  if (p.keyValue !== undefined && String(p.keyValue).length) {
    try {
      reg.keys = reg.keys && typeof reg.keys === 'object' ? reg.keys : {}
      reg.keys[keyRef] = String(p.keyValue)
      writeApiRegistry(reg)
    } catch (err) {}
  }
  return { ok: true, id: id }
}

async function apiProbeModel(model) {
  if (!model) return { ok: false, error: '模型不存在' }
  const tpl = apiTemplateOf(model.provider) || {}
  if (model.id === API_BUILTIN_ID) {
    const r = await getBalance()
    return r.ok ? { ok: true, detail: '余额 ' + r.totalBalance + ' ' + (r.currency || 'CNY') } : { ok: false, error: r.error || r.code }
  }
  const cred = resolveApiKeyRef(model.keyRef || tpl.keyRef || '')
  const key = cred && cred.value ? String(cred.value) : ''
  if (!key) return { ok: false, error: '未配置 ' + (model.keyRef || tpl.keyRef || 'API key') }
  const b = mergeNonEmpty(tpl.balance, model.balance)
  const base = String(model.baseUrl || '').replace(/\/+$/, '')
  const url = String(tpl.probeUrl || b.url || (base ? base + '/v1/models' : '')).replace('{base}', base)
  if (!url) return { ok: false, error: '没有可测试的接口（请填余额接口或 Base URL）' }
  try {
    const data = await apiFetchJson(url, b.auth, key)
    const bizErr = apiBusinessError(data)
    if (bizErr) return { ok: false, error: '测试失败: ' + bizErr }
    let detail = 'HTTP 200'
    if (data && Array.isArray(data.data)) detail = '可用模型 ' + data.data.length + ' 个'
    else if (data && data.data && Array.isArray(data.data.models)) detail = '可用模型 ' + data.data.models.length + ' 个'
    return { ok: true, detail: detail }
  } catch (err) {
    return { ok: false, error: '测试失败: ' + String((err && err.message) || err).slice(0, 140) }
  }
}

async function apiModelsPayload() {
  const models = apiAllModels()
  const settings = readUsageSettings()
  const out = []
  for (const m of models) {
    let entry = {
      id: m.id, name: m.name, provider: m.provider, currency: m.currency,
      keyRef: m.keyRef, builtin: !!m.builtin, baseUrl: m.baseUrl || '',
      matchIds: m.matchIds || [], settings: settings.models && settings.models[m.id] ? settings.models[m.id] : null,
      price: m.price || null,
      quota: (settings.models && settings.models[m.id] && settings.models[m.id].quota)
        ? Object.assign({}, settings.models[m.id].quota) : null,
      balance: null, todayUsage: null, todayUsageCurrency: null, usageSource: 'none', error: null,
    }
    if (entry.quota) {
      entry.quota.autoUsed = apiQuotaAutoUsed(m.id, entry.quota)
      entry.quota.autoToday = Math.round(Number((apiUsageRaw(m.id) || {}).eventTokens) || 0)
    }
    // 「接口描述」单独下发供面板回填；entry.balance 是数值不能当描述用
    const tplE = apiTemplateOf(m.provider) || {}
    entry.balanceDesc = mergeNonEmpty(tplE.balance, m.balance)
    if (m.id === API_BUILTIN_ID) {
      entry.balanceMode = 'api'
      entry.hasBalanceApi = true
      const cred = resolveApiKeyRef(m.keyRef || 'DEEPSEEK_API_KEY')
      entry.hasKey = !!(cred && cred.value)
      try {
        const led = readUsageLedger()
        entry.balance = typeof led.lastBalance === 'number' ? led.lastBalance : null
        entry.todayUsage = round2(led.todayUsage || 0)
        entry.todayUsageCurrency = 'CNY'
        entry.usageSource = 'ledger'
      } catch (err) {}
    } else {
      const cred = resolveApiKeyRef(m.keyRef || '')
      const hasKey = !!(cred && cred.value)
      entry.hasKey = hasKey
      const tplM = apiTemplateOf(m.provider) || {}
      const balDesc = Object.assign({}, tplM.balance || {}, m.balance || {})
      const hasBalanceApi = !!String(balDesc.url || '').trim()
      entry.hasBalanceApi = hasBalanceApi
      entry.probeUrl = String(tplM.probeUrl || '')
      entry.planSupport = !!tplM.quota
      entry.balanceMode = hasBalanceApi ? 'api' : 'events'
      if (hasBalanceApi && hasKey) {
        const r = await fetchModelBalance(m)
        if (r && r.ok) {
          entry.balance = r.remaining
          if (r.currency) entry.currency = r.currency
          apiRecordBalance(m.id, r.remaining)
          const u = apiTodayUsage(m.id, entry.currency || m.currency)
          entry.todayUsage = u.amount
          entry.usageSource = u.source
          entry.todayUsageCurrency = u.currency
        } else if (r) {
          entry.error = r.error || r.code || '余额获取失败'
        }
      } else if (!hasBalanceApi) {
        entry.error = null
      } else {
        entry.error = '未配置 ' + (m.keyRef || 'API key')
      }
      // 订阅额度：有额度接口 + 有 key 才请求；失败只影响 plan 字段
      if (tplM.quota && hasKey) {
        try {
          entry.plan = await fetchModelQuota(m)
          if (entry.plan && !entry.plan.ok && apiPlanNoPlan(entry.plan.error)) entry.plan.hide = true
        } catch (err) {
          entry.plan = { ok: false, error: String((err && err.message) || err) }
        }
      }
      if (entry.todayUsage === null) {
        const u2 = apiTodayUsage(m.id, entry.currency || m.currency)
        entry.todayUsage = u2.amount
        entry.usageSource = u2.source
        entry.todayUsageCurrency = u2.currency
      }
    }
    out.push(entry)
  }
  return {
    ok: true,
    builtinId: API_BUILTIN_ID,
    templates: Object.keys(API_TEMPLATES).map((k) => ({
      id: k, name: API_TEMPLATES[k].name, currency: API_TEMPLATES[k].currency,
      keyRef: API_TEMPLATES[k].keyRef, builtin: !!API_TEMPLATES[k].builtin,
      needsBaseUrl: !!API_TEMPLATES[k].needsBaseUrl,
      hasBalance: !!String((API_TEMPLATES[k].balance || {}).url || '').trim(),
      probeUrl: String(API_TEMPLATES[k].probeUrl || ''),
      kind: String(API_TEMPLATES[k].kind || 'balance'),
      balance: API_TEMPLATES[k].balance ? JSON.parse(JSON.stringify(API_TEMPLATES[k].balance)) : null,
      quota: API_TEMPLATES[k].quota ? JSON.parse(JSON.stringify(API_TEMPLATES[k].quota)) : null,
      matchIds: Array.isArray(API_TEMPLATES[k].matchIds) ? API_TEMPLATES[k].matchIds.slice(0, 12) : [],
      noBalanceApi: !!API_TEMPLATES[k].noBalanceApi,
      apiNote: String(API_TEMPLATES[k].apiNote || ''),
      sortKey: tplSortKey(API_TEMPLATES[k].name),
    })),
    models: out,
  }
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

// 按压/松开音效。set= 为预设组名（duck/fx1）或自定义音效组 id：
// 自定义组按组内片段出音频（MIME 跟随片段），空串槽位 = 显式静音（204 无 body），
// 引用失效或找不到组则回退预设 duck。
function soundSlot(req, res, slot) {
  const setName = soundSetFromUrl(req.url)
  if (setName && !SOUND_SETS[setName]) {
    const fragId = groupFragmentId(setName, slot)
    if (fragId === '') {
      res.writeHead(204)
      res.end()
      return
    }
    const bytes = fragId ? loadAudioFragmentBytes(fragId) : null
    if (bytes) {
      sendBytes(res, bytes, fragmentMime(fragId))
      return
    }
  }
  const set = SOUND_SETS[setName] || SOUND_SETS.duck
  const bytes = readFirst([set[slot]])
  if (!bytes) return sendNotFound(res, 'sound unavailable')
  sendBytes(res, bytes, 'audio/mpeg')
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

  '/dsh-whale/sound/press.mp3': (req, res) => soundSlot(req, res, 'press'),
  '/dsh-whale/sound/release.mp3': (req, res) => soundSlot(req, res, 'release'),

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
        // 缺 scale 时引导默认值 1（与挂件缺省一致）：角色上报（applyRole 的
        // {role} PUT）和主进程的 {provider} 切换包都不带 scale，全新安装还
        // 没有任何存档时不能拿「missing scale」把整个写入拒掉
        if (typeof parsed.scale !== 'number') {
          parsed.scale = prevCfg && typeof prevCfg.scale === 'number' ? prevCfg.scale : 1
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

  // 泡泡点击序列配置：GET 按当前厂商下发（无存档时给该厂商的默认配置，
  // 不返回 null——前端拿到 null 会用出厂默认，那套是 DeepSeek 的怪话池）；
  // PUT 只持久化 items/lib/tapAdvance 四个键，落到当前厂商的槽位。
  '/dsh-whale/bubble.json': async (req, res) => {
    try {
      const provider = currentProvider()
      // DELETE = 清掉当前模型的存档（编辑器「重置」用）：GET 会重新返回该模型的
      // 默认配置。重置必须按模型取默认，而不是把上游出厂默认（DeepSeek 怪话池）
      // 存进当前模型槽。
      if (req.method === 'DELETE') {
        try { fs.rmSync(bubbleConfigFile(provider), { force: true }) } catch (err) {}
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, config: defaultBubbleConfig(provider) }))
        return
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const parsed = JSON.parse(await readBodyMax(req, 512 * 1024))
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items) || !Array.isArray(parsed.lib)) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'invalid bubble config' }))
          return
        }
        const cfg = { v: 1, items: parsed.items, lib: parsed.lib, tapAdvance: parsed.tapAdvance === true }
        if (!writeBubbleConfig(provider, cfg)) {
          res.writeHead(500, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '无法持久化泡泡配置' }))
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, config: cfg }))
        return
      }
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true, config: loadBubbleConfig(provider) || defaultBubbleConfig(provider) }))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  },

  // 泡泡图上传/删除（body 上限 10MB，图 64B–8MB，仅 png/gif）
  '/dsh-whale/bubble-img-upload.json': async (req, res) => {
    try {
      const parsed = JSON.parse(await readBodyMax(req, 10 * 1024 * 1024))
      const action = parsed && parsed.action
      const index = readBubbleImgIndex()
      if (action === 'upload') {
        const name = String(parsed.name || '').trim().slice(0, 40) || ''
        const m = /^data:image\/(png|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(parsed.data || ''))
        if (!m) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'invalid image data' }))
          return
        }
        const format = m[1] === 'gif' ? 'gif' : 'png'
        const buf = Buffer.from(m[2], 'base64')
        if (buf.length < 64 || buf.length > 8 * 1024 * 1024) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'image too large' }))
          return
        }
        const id = 'bimg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
        fs.writeFileSync(path.join(pickBubbleImgDir(), id + '.' + format), buf)
        index.images.push({ id: id, name: name, format: format, createdAt: Date.now() })
        writeBubbleImgIndex(index)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(bubbleImgPayload()))
        return
      }
      if (action === 'delete') {
        const id = String(parsed.id || '')
        const img = index.images.find((x) => x.id === id)
        if (!img) {
          res.writeHead(404, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'image not found' }))
          return
        }
        index.images = index.images.filter((x) => x.id !== id)
        writeBubbleImgIndex(index)
        try { fs.unlinkSync(path.join(pickBubbleImgDir(), id + '.' + (img.format === 'gif' ? 'gif' : 'png'))) } catch (err) {}
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(bubbleImgPayload()))
        return
      }
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  },

  // 角色列表 / 导入（body 上限 30MB，支持最大 20MB GIF 的 base64 膨胀）
  '/dsh-whale/roles.json': async (req, res) => {
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const parsed = JSON.parse(await readBodyMax(req, 30 * 1024 * 1024))
        const name = String(parsed.name || '').trim().slice(0, 20) || '新角色'
        const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(parsed.image || ''))
        if (!m) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'invalid image data' }))
          return
        }
        const buf = Buffer.from(m[2], 'base64')
        if (buf.length < 8 || buf.length > 20 * 1024 * 1024) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'image too large' }))
          return
        }
        // format 客户端显式告知（APNG 的 dataURL 是 image/png，需客户端区分）
        const declared = parsed.format === 'gif' ? 'gif' : parsed.format === 'apng' ? 'apng' : null
        const fmt = declared || (m[1] === 'gif' ? 'gif' : 'png')
        const id = 'role_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
        fs.writeFileSync(path.join(pickRoleDir(), id + '.' + roleFileExt(fmt)), buf)
        const index = readRolesIndex()
        index.roles.push({ id: id, name: name, format: fmt, pinnedAt: null, createdAt: Date.now() })
        writeRolesIndex(index)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(rolesPayload()))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
      return
    }
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(rolesPayload()))
  },

  '/dsh-whale/role-pin.json': async (req, res) => {
    try {
      const parsed = JSON.parse(await readBodyMax(req, 8192))
      const { index, role } = roleIndexFind(String(parsed.id || ''))
      if (!role) {
        res.writeHead(404, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'role not found' }))
        return
      }
      role.pinnedAt = parsed.pinned === true ? Date.now() : null
      writeRolesIndex(index)
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(rolesPayload()))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  },

  '/dsh-whale/role-delete.json': async (req, res) => {
    try {
      const parsed = JSON.parse(await readBodyMax(req, 8192))
      const id = String(parsed.id || '')
      if (id === ROLE_DEFAULT_ID) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'cannot delete default role' }))
        return
      }
      const { index, role } = roleIndexFind(id)
      if (!role) {
        res.writeHead(404, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'role not found' }))
        return
      }
      // 先按 format 定文件路径再从索引移除（否则查不到 format 会默认 png，删不掉 .gif）
      const fmt = role.format === 'gif' || role.format === 'apng' ? role.format : 'png'
      const p = roleFilePath(id, fmt)
      index.roles = index.roles.filter((r) => r.id !== id)
      writeRolesIndex(index)
      if (p) { try { fs.unlinkSync(p) } catch (err) {} }
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(rolesPayload()))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  },

  '/dsh-whale/role-image.png': (req, res) => {
    try {
      const id = urlParam(req.url, 'id')
      const p = roleImagePath(id)
      if (!p) throw new Error('bad role id')
      const bytes = fs.readFileSync(p)
      const { role } = roleIndexFind(id)
      const mime = role && role.format === 'gif' ? 'image/gif' : 'image/png'
      sendBytes(res, bytes, mime)
    } catch (err) {
      sendNotFound(res, 'role image unavailable')
    }
  },

  // 音频管理：GET 列表；POST 按 action 分派（upload-fragment 8MB / save-group /
  // delete-group / delete-fragment / pin-group）
  '/dsh-whale/audio.json': async (req, res) => {
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const parsed = JSON.parse(await readBodyMax(req, 8 * 1024 * 1024))
        const action = parsed.action
        const index = readAudioIndex()
        if (action === 'upload-fragment') {
          const name = String(parsed.name || '').trim().slice(0, 40) || '未命名音频'
          const m = /^data:audio\/wav;base64,([A-Za-z0-9+/=]+)$/.exec(String(parsed.audio || ''))
          if (!m) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'invalid wav data' }))
            return
          }
          const buf = Buffer.from(m[1], 'base64')
          if (buf.length < 44 || buf.length > 8 * 1024 * 1024) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'audio too large' }))
            return
          }
          const id = 'audio_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
          fs.writeFileSync(path.join(pickAudioDir(), id + '.wav'), buf)
          index.fragments.push({ id: id, name: name, createdAt: Date.now() })
          writeAudioIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, id: id, fragments: audioFragmentsPayload() }))
          return
        }
        if (action === 'save-group') {
          const id = String(parsed.id || '')
          const name = String(parsed.name || '').trim().slice(0, 20) || '未命名音效组'
          const press = String(parsed.press == null ? '' : parsed.press)
          const release = String(parsed.release == null ? '' : parsed.release)
          // 校验引用片段存在（预设或自定义）；空串=留槽静音，允许保存
          const frags = audioFragmentsPayload().map((f) => f.id)
          const validPress = press === '' ? '' : frags.includes(press) ? press : PRESET_GROUPS.duck.press
          const validRelease = release === '' ? '' : frags.includes(release) ? release : PRESET_GROUPS.duck.release
          if (id && index.groups.some((g) => g.id === id)) {
            const g = index.groups.find((x) => x.id === id)
            g.name = name
            g.press = validPress
            g.release = validRelease
          } else {
            const gid = 'group_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
            index.groups.push({ id: gid, name: name, press: validPress, release: validRelease, pinnedAt: null, createdAt: Date.now() })
          }
          writeAudioIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
          return
        }
        if (action === 'delete-group') {
          const id = String(parsed.id || '')
          if (PRESET_GROUPS[id]) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'cannot delete preset group' }))
            return
          }
          index.groups = index.groups.filter((g) => g.id !== id)
          writeAudioIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
          return
        }
        if (action === 'delete-fragment') {
          const id = String(parsed.id || '')
          if (PRESET_FRAGMENTS[id]) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'cannot delete preset fragment' }))
            return
          }
          index.fragments = index.fragments.filter((f) => f.id !== id)
          writeAudioIndex(index)
          const p = audioFragmentPath(id)
          if (p) { try { fs.unlinkSync(p) } catch (err) {} }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, fragments: audioFragmentsPayload(), groups: audioGroupsPayload() }))
          return
        }
        if (action === 'pin-group') {
          const g = index.groups.find((x) => x.id === String(parsed.id || ''))
          if (!g) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'group not found' }))
            return
          }
          g.pinnedAt = parsed.pinned === true ? Date.now() : null
          writeAudioIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
          return
        }
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
      return
    }
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(audioPayload()))
  },

  // 片段字节（路径后缀 .wav 是历史遗留，字节可能是 mp3：MIME 按片段类型给）
  '/dsh-whale/audio-fragment.wav': (req, res) => {
    try {
      const id = urlParam(req.url, 'id')
      const bytes = loadAudioFragmentBytes(id)
      if (!bytes) throw new Error('bad fragment id')
      sendBytes(res, bytes, fragmentMime(id))
    } catch (err) {
      sendNotFound(res, 'audio fragment unavailable')
    }
  },

  '/dsh-whale/usage-settings.json': async (req, res) => {
    try {
      if (req.method === 'PUT' || req.method === 'POST') {
        const parsed = JSON.parse(await readBody(req))
        if (!parsed || typeof parsed !== 'object') throw new Error('bad body')
        const result = writeUsageSettings(parsed)
        res.writeHead(result.ok ? 200 : 400, JSON_HEADERS)
        res.end(JSON.stringify(result))
        return
      }
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true, settings: readUsageSettings() }))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
    }
  },

  '/dsh-whale/usage-records.json': async (req, res) => {
    try {
      // 与余额路由同源：较新的余额缓存（≤70s，覆盖两次 60s 轮询间隙）先刷账本
      // 再算汇总，保证「今日合计」与泡泡「今日已用」读同一份数据
      try {
        if (balanceCache && balanceCache.payload && balanceCache.payload.ok &&
            isFinite(Number(balanceCache.payload.totalBalance)) &&
            Date.now() - balanceCache.at <= 70000 &&
            currentProvider() === 'deepseek') {
          recordLedgerUsage(Number(balanceCache.payload.totalBalance), balanceCache.payload.currency)
        }
      } catch (err) {}
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(usageRecordsPayload()))
    } catch (err) {
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
    }
  },

  // 自定义 API 模型：GET 列表（含实时余额/今日已用/订阅额度）；POST 按 action 分派
  '/dsh-whale/api-models.json': async (req, res) => {
    try {
      if (req.method === 'PUT' || req.method === 'POST') {
        const parsed = JSON.parse(await readBodyMax(req, 64 * 1024))
        const action = String((parsed && parsed.action) || 'save')
        if (action === 'delete') {
          const r = apiDeleteModel(parsed.id)
          const list = await apiModelsPayload()
          res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
          res.end(JSON.stringify(Object.assign({}, r, { models: list.models })))
          return
        }
        if (action === 'probe') {
          const pr = await apiProbeModel(apiModelById(parsed.id))
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(pr))
          return
        }
        if (action === 'set-key' || action === 'delete-key') {
          const ref = String(parsed.keyRef || '').trim()
          if (!ref) throw new Error('bad keyRef')
          const reg = readApiRegistry()
          reg.keys = reg.keys && typeof reg.keys === 'object' ? reg.keys : {}
          if (action === 'set-key') reg.keys[ref] = String(parsed.keyValue || '')
          else delete reg.keys[ref]
          writeApiRegistry(reg)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (action === 'model-settings') {
          const r = writeUsageSettings({ modelSettings: { id: String(parsed.id || ''), alert: parsed.alert, budget: parsed.budget, quota: parsed.quota } })
          res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
          res.end(JSON.stringify(r))
          return
        }
        // save：keyValue 在提交体上（不在 model 里），必须合并进去
        const r = await apiSaveModel(Object.assign({}, parsed.model || parsed, { keyValue: parsed.keyValue }))
        if (!r.ok) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify(r))
          return
        }
        const list = await apiModelsPayload()
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(Object.assign({}, r, { models: list.models })))
        return
      }
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(await apiModelsPayload()))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
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

