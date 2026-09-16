// 小鲸鱼桌宠 —— Electron 主进程
//
// 设计要点：窗口不"包住"鲸鱼，而是覆盖整个工作区，透明 + 置顶 + 点击穿透。
// 这样挂件前端可以零改动地工作——它本来就设计成覆盖在界面之上、只在鲸鱼
// 像素处接收操作（内置 alpha 命中测试与透明区穿透意图）。桌面就是它的"视口"，
// 于是拖拽、四边吸附、点击交互、音效全部保持原版行为。
//
// 窗口是全屏置顶的，所以必须有一个可靠的退出通道：托盘图标（见 createTray）。
// 即使点击穿透出问题，托盘和鲸鱼右键也都能退出。

const { app, BrowserWindow, Menu, Tray, ipcMain, screen, shell, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..')

// 打包后安装目录可能只读（而且升级会被覆盖），所以配置和运行数据放用户目录；
// 开发态直接放项目里，方便查看和手改。
const IS_PACKAGED = app.isPackaged
const USER_DIR = app.getPath('userData')
const DATA_DIR = IS_PACKAGED ? path.join(USER_DIR, 'data') : path.join(ROOT, 'data')
const CONFIG_PATH = IS_PACKAGED ? path.join(USER_DIR, 'config.json') : path.join(ROOT, 'config.json')
const LOG_PATH = path.join(DATA_DIR, 'pet.log')

// 桌宠模式下推荐的初始大小。挂件原本是给浏览器视口用的，同一份 scale 在
// 全屏窗口里算出来的基准尺寸会明显更大（基准 = min(250, min(vw,vh)*0.28) * scale），
// 所以这里给一个偏小的桌宠默认值；用户随时可以右键调。
const DEFAULT_PET_SCALE = 0.8

function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.join(' ')
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(LOG_PATH, line + '\n')
  } catch (err) {}
  if (process.env.DS_PET_DEBUG) console.log(line)
}

function readPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return Number(cfg.port) || 3080
  } catch (err) {
    return 3080
  }
}

const PORT = readPort()
const BASE = 'http://127.0.0.1:' + PORT

// ---------------------------------------------------------------------------
// 内置本地服务
//
// 打包后由主进程把服务跑在自己的进程里，这样朋友那边完全不需要装 Node。
// server.js 里用的是 Node 内置模块（http/fs/…）和全局 fetch，Electron 都提供。
// ---------------------------------------------------------------------------

let embeddedServer = null

async function startEmbeddedServer() {
  const serverPath = path.join(ROOT, 'server.js')
  const mod = await import(pathToFileURL(serverPath).href)
  mod.configure({
    root: ROOT,
    configFile: CONFIG_PATH,
    dataDir: DATA_DIR,
  })
  embeddedServer = mod
  try {
    const info = await mod.startServer({ port: PORT })
    log('内置服务已启动 ' + info.host + ':' + info.port +
        (info.apiKeySet ? '（已配置 Key）' : '（未配置 Key）'))
    return { ok: true, apiKeySet: info.apiKeySet }
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      // 端口上已经有服务在跑（比如用户之前用 start.cmd 起过），直接复用它
      log('端口 ' + PORT + ' 已有服务在运行，复用它')
      return { ok: true, reused: true, apiKeySet: null }
    }
    log('内置服务启动失败: ' + String((err && err.message) || err))
    return { ok: false, error: String((err && err.message) || err) }
  }
}

let win = null
let tray = null
let clickThrough = true
let balanceText = '--'

// ---------------------------------------------------------------------------
// 设置菜单
// ---------------------------------------------------------------------------

function applySetting(key, value) {
  // 这两个设置挂件里没有对应控件（是桌宠侧独有的），由主进程直接落地
  if (key === 'autoPopMs') {
    saveAutoPop(value)
    return
  }
  if (key === 'openAtLogin') {
    setOpenAtLogin(!!value)
    return
  }
  if (!win || win.isDestroyed()) return
  const js =
    'window.__dsPet && window.__dsPet.applySetting(' +
    JSON.stringify(String(key)) + ', ' + JSON.stringify(value) + ')'
  win.webContents.executeJavaScript(js, true).catch((err) => log('applySetting 失败', key, err.message))
}

// ---------------------------------------------------------------------------
// 桌宠侧独有的两个设置：自动冒泡、开机自启动
// ---------------------------------------------------------------------------

async function readServerConfig() {
  try {
    const res = await fetch(BASE + '/dsh-whale/size.json')
    const cfg = await res.json()
    return cfg && typeof cfg === 'object' ? cfg : {}
  } catch (err) {
    return {}
  }
}

let autoPopTimer = null

function popRandomLine() {
  if (!win || win.isDestroyed() || !win.isVisible()) return
  win.webContents
    .executeJavaScript('window.__dshWhaleApi ? window.__dshWhaleApi.showRandomLine() : false', true)
    .then((shown) => log('自动冒泡 -> ' + (shown ? '已弹出' : '跳过（气泡关着或正在显示消耗）')))
    .catch((err) => log('自动冒泡失败', err.message))
}

function startAutoPopTimer(ms) {
  if (autoPopTimer) {
    clearInterval(autoPopTimer)
    autoPopTimer = null
  }
  const period = Number(ms) || 0
  if (period <= 0) return
  // 下限 30 秒，避免配置写了个很小的值导致疯狂弹泡
  autoPopTimer = setInterval(popRandomLine, Math.max(30000, period))
  log('自动冒泡已开启，间隔约 ' + Math.round(period / 60000) + ' 分钟')
}

// autoPopMs 没有对应的挂件控件，所以走整包 PUT：先把服务端当前配置读回来，
// 只改这一个字段再写回，免得把其它设置重置成默认值
async function saveAutoPop(ms) {
  const cfg = await readServerConfig()
  if (typeof cfg.scale !== 'number') cfg.scale = DEFAULT_PET_SCALE
  cfg.autoPopMs = Number(ms) > 0 ? Math.round(Number(ms)) : 0
  try {
    const res = await fetch(BASE + '/dsh-whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    const out = await res.json()
    if (!out || !out.ok) log('保存自动冒泡间隔失败', out && out.error)
  } catch (err) {
    log('保存自动冒泡间隔异常', err.message)
  }
  startAutoPopTimer(cfg.autoPopMs)
}

function isOpenAtLogin() {
  try {
    return !!app.getLoginItemSettings().openAtLogin
  } catch (err) {
    return false
  }
}

function setOpenAtLogin(on) {
  try {
    // 开发态（未打包）跑的是 electron.exe，不带入口脚本参数的话开机只会启动
    // 一个空的 Electron。打包后 process.execPath 就是应用本体，不需要参数。
    const args = app.isPackaged ? [] : [path.join(__dirname, 'main.cjs')]
    app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: args })
    log('开机自启动 -> ' + (on ? '开' : '关'))
  } catch (err) {
    log('设置开机自启动失败', err.message)
  }
}

// 把桌宠侧设置的当前值推给页面，让挂件菜单里那两行控件显示正确状态。
// （自动冒泡存在服务端配置里，开机自启在系统启动项里，挂件自己都不知道）
async function pushPetSettings() {
  if (!win || win.isDestroyed()) return
  let autoPopMs = 0
  let provider = 'deepseek'
  try {
    const cfg = await readServerConfig()
    if (typeof cfg.autoPopMs === 'number') autoPopMs = cfg.autoPopMs
    if (typeof cfg.provider === 'string') provider = cfg.provider
  } catch (err) {}
  const payload = {
    provider: provider,
    autoPopMs: autoPopMs,
    openAtLogin: isOpenAtLogin(),
    // 当前厂商的凭据（字段名保持 apiKey，值随厂商变：DeepSeek 的 Key 或 GLM 的令牌）
    apiKey: readCredential(provider),
  }
  // 贴图/配色立即切到位：不然要等余额接口回来（1~2 秒）才换皮，能看见旧角色闪一下
  try {
    await win.webContents.executeJavaScript(
      'window.__dshWhaleApi && window.__dshWhaleApi.applyProvider(' +
        JSON.stringify(provider) + ')',
      true,
    )
  } catch (err) {}
  try {
    await win.webContents.executeJavaScript(
      'window.__dshWhalePetSettings && window.__dshWhalePetSettings(' +
        JSON.stringify(payload) + ')',
      true,
    )
  } catch (err) {
    log('同步桌宠设置到页面失败 ' + err.message)
  }
}

// 服务端配置的本地缓存。原生菜单必须紧跟输入事件同步弹出，中间不能 await
// 网络请求，所以 autoPopMs 这类存在服务端的值先读进缓存，菜单只用缓存值，
// 同时后台刷新缓存供下次使用。
// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function workArea() {
  return screen.getPrimaryDisplay().workArea
}

function layout() {
  if (!win || win.isDestroyed()) return
  const wa = workArea()
  win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height })
}

function createWindow() {
  const wa = workArea()
  win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // 点击鲸鱼不抢走当前应用的焦点——桌宠不该打断你正在做的事
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  // screen-saver 层级：浮在普通窗口之上，包括最大化窗口
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true)
  // 初始整窗穿透，鼠标移到鲸鱼像素上时由页内适配器再打开
  win.setIgnoreMouseEvents(true, { forward: true })
  clickThrough = true

  win.once('ready-to-show', () => {
    win.showInactive()
    log('窗口已显示', JSON.stringify(wa))
  })
  // 启动时把当前光标位置交给页面：否则如果光标本来就在鲸鱼上，适配器要等到
  // 用户动一下鼠标才把它切成可交互，那之前鲸鱼点不动，看起来像坏了
  win.webContents.on('did-finish-load', () => {
    try {
      const pt = screen.getCursorScreenPoint()
      const area = workArea()
      win.webContents.send('pet:initial-cursor', { x: pt.x - area.x, y: pt.y - area.y })
    } catch (err) {}
    // 挂件菜单里那两行桌宠设置的当前值只有主进程知道，加载完推给它
    pushPetSettings()
  })
  win.on('closed', () => {
    win = null
  })

  win.loadURL(BASE + '/pet').catch((err) => log('加载页面失败', err.message))
}

// 桌宠默认尺寸：只在还没有任何尺寸记录时写一次。
// 顺带把服务端配置返回出去，调用方要用里面的 autoPopMs 起自动冒泡定时器。
async function ensureDefaultScale() {
  try {
    const cfg = await readServerConfig()
    if (typeof cfg.scale === 'number') {
      log('沿用已有尺寸 scale=' + cfg.scale)
      return cfg
    }
    const res = await fetch(BASE + '/dsh-whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: DEFAULT_PET_SCALE }),
    })
    const out = await res.json()
    log('写入桌宠默认尺寸 scale=' + DEFAULT_PET_SCALE)
    return out && out.ok ? out : cfg
  } catch (err) {
    log('读取/写入尺寸失败（服务可能还没起来）', err.message)
    return {}
  }
}

// ---------------------------------------------------------------------------
// 托盘：全屏置顶窗口的可靠退出通道
// ---------------------------------------------------------------------------

function createTray() {
  let icon
  try {
    icon = nativeImage
      .createFromPath(path.join(ROOT, 'assets', 'DSniang1.png'))
      .resize({ width: 16, height: 16 })
  } catch (err) {
    log('托盘图标加载失败', err.message)
  }
  if (!icon || icon.isEmpty()) {
    log('托盘图标为空，跳过托盘')
    return
  }

  tray = new Tray(icon)
  tray.setToolTip('小鲸鱼余额桌宠')
  // 菜单只有一条入口：左键点鲸鱼旁边的汉堡按钮。托盘这里只放应用级操作，
  // 不再提供"打开设置菜单"的捷径——那会变成第二条入口。
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示 / 隐藏',
      click: () => {
        if (!win) return
        if (win.isVisible()) win.hide()
        else win.showInactive()
      },
    },
    { type: 'separator' },
    { label: '打开配置文件', click: () => shell.openPath(CONFIG_PATH) },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() },
  ]))
}

// 顺带在托盘提示里显示余额，省得为了看一眼余额去点鲸鱼
async function pollBalanceForTray() {
  if (!tray) return
  try {
    const res = await fetch(BASE + '/dsh-whale/balance.json')
    const d = await res.json()
    if (d && d.ok) {
      balanceText = Number(d.totalBalance).toFixed(2) + ' ' + (d.currency || 'CNY')
      tray.setToolTip('小鲸鱼余额桌宠\n余额：' + balanceText)
    } else {
      tray.setToolTip('小鲸鱼余额桌宠\n' + (d && d.error ? d.error : '余额不可用'))
    }
  } catch (err) {}
}


// ---------------------------------------------------------------------------
// API Key 读写
//
// Key 直接填在挂件自带菜单最底部那一行（不再有独立的引导窗口）。
// 这里只负责读写 config.json 的 apiKey 字段，其余字段原样保留。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 凭据读写（按厂商分开存）
//
// DeepSeek 的 Key 存 config.json 的 apiKey；GLM 的令牌存 providers.glm.planToken。
// 菜单最底下那一行是「当前厂商的凭据」——切到 GLM 就该填 GLM 令牌。
// 之前这一行无论什么厂商都读写成 apiKey，于是切到 GLM 会看到 DeepSeek 的 Key，
// 填进去还会把 DeepSeek 的 Key 覆盖掉（两个厂商共用一个值）。
// ---------------------------------------------------------------------------

function readCredential(provider) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
    if (provider === 'glm') {
      const t = cfg && cfg.providers && cfg.providers.glm && cfg.providers.glm.planToken
      return typeof t === 'string' ? t.trim() : ''
    }
    return cfg && typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : ''
  } catch (err) {
    return ''
  }
}

// 只改当前厂商对应的那个字段，配置文件里其它字段原样保留
function writeCredential(provider, key) {
  let cfg = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''))
    if (parsed && typeof parsed === 'object') cfg = parsed
  } catch (err) {
    cfg = {}
  }
  const value = String(key || '').trim()
  if (provider === 'glm') {
    if (!cfg.providers || typeof cfg.providers !== 'object') cfg.providers = {}
    if (!cfg.providers.glm || typeof cfg.providers.glm !== 'object') cfg.providers.glm = {}
    cfg.providers.glm.planToken = value
  } else {
    cfg.apiKey = value
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  return value
}

// 当前厂商以服务端配置为准（它才是权威来源，页面上的状态可能还没刷新）
async function currentProvider() {
  const cfg = await readServerConfig()
  return cfg && cfg.provider === 'glm' ? 'glm' : 'deepseek'
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.on('pet:set-click-through', (event, ignore) => {
  if (!win || win.isDestroyed()) return
  const want = !!ignore
  if (want === clickThrough) return
  clickThrough = want
  win.setIgnoreMouseEvents(want, { forward: true })
  // 调试用：把状态翻转和当时的光标位置记下来，方便确认穿透到底在哪一点生效
  if (process.env.DS_PET_DEBUG) {
    let pt = null
    try { pt = screen.getCursorScreenPoint() } catch (err) {}
    log('穿透 -> ' + (want ? '开（事件给桌面）' : '关（鲸鱼可交互）') + '  光标=' + (pt ? pt.x + ',' + pt.y : '?'))
  }
})

// 挂件自带菜单里那两行桌宠设置的落地
ipcMain.on('pet:set-auto-pop', (event, ms) => {
  saveAutoPop(ms)
})

ipcMain.on('pet:set-open-at-login', (event, on) => {
  setOpenAtLogin(!!on)
})

// 窗口默认 focusable:false，好处是点鲸鱼不会把你正在用的应用抢走焦点。
// 但那样的窗口永远拿不到键盘焦点，菜单/弹层里的输入框就完全打不进字。
// 页面侧（adapter）只在**真的点进文本输入控件**时才请求切成可聚焦——早先是
// 「菜单/弹层一打开就切」，Windows 上会把前台窗口挤下去且不会自动还回去
// （用户实测：点一下桌宠，别的窗口就像卡住了）。
ipcMain.on('pet:set-focusable', (event, on) => {
  if (!win || win.isDestroyed()) return
  try {
    if (on) {
      // 只 setFocusable 不够：窗口还要被显式聚焦，键盘输入才真的进来
      win.setFocusable(true)
      win.focus()
    } else {
      win.setFocusable(false)
      // 交还焦点：让系统挑下一个前台窗口（通常回到用户刚才在用的那个），
      // 否则焦点可能留在本窗口上、别的应用看着像"卡住"
      try { win.blur() } catch (err) {}
    }
    log('窗口可聚焦 -> ' + (on ? '开（输入框聚焦）' : '关（输入框失焦）') +
        ' isFocusable=' + win.isFocusable())
  } catch (err) {
    log('切换可聚焦失败 ' + err.message)
  }
})

// 多厂商切换：写入服务端配置，再让挂件立刻刷新一次（等价于左键点鲸鱼）
ipcMain.on('pet:set-provider', (event, provider) => {
  const value = provider === 'glm' ? 'glm' : 'deepseek'
  fetch(BASE + '/dsh-whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: value }),
  })
    .then((r) => r.json())
    .then((out) => {
      if (!out || !out.ok) {
        log('切换厂商失败', out && out.error)
        return
      }
      log('当前厂商 -> ' + (value === 'glm' ? 'GLM Coding Plan' : 'DeepSeek'))
      // 先换贴图/配色再刷新数据，避免旧角色停留
      pushPetSettings()
      applySetting('refresh', true)
    })
    .catch((err) => log('切换厂商异常 ' + err.message))
})

// 菜单最底部那行凭据（DeepSeek 的 API Key 或 GLM 的令牌，按当前厂商落在不同字段）。
// 只记长度和厂商，不要把凭据本身写进日志。
ipcMain.on('pet:set-api-key', async (event, key) => {
  try {
    const provider = await currentProvider()
    const saved = writeCredential(provider, key)
    log('已更新 ' + (provider === 'glm' ? 'GLM 令牌' : 'API Key') + '（长度 ' + saved.length + '）')
    // 再推一次设置：让菜单那行按新状态收起或展开（配好了就收起来，避免误触），
    // 并按当前厂商刷新那一行的标题
    pushPetSettings()
    // 让挂件立刻按新凭据拉一次数据（等价于左键点一下角色）
    applySetting('refresh', true)
  } catch (err) {
    log('保存凭据失败 ' + err.message)
  }
})

// 左键点击诊断：记录落点确实在鲸鱼上、以及按下到抬起移动了多少像素。
// 挂件把位移超过阈值的按下/抬起当成"拖拽"，那样走的是吸附而不是弹气泡，
// 表现出来就是"点鲸鱼没反应"。这条日志就是为了万一再出现时能一眼定位。
ipcMain.on('pet:click-diag', (event, info) => {
  if (!info) return
  if (info.kind === 'ui') {
    log('界面事件：' + info.detail)
    return
  }
  log('左键点击鲸鱼：位移 ' + info.movedPx + 'px' +
      (info.at ? ' 坐标=' + info.at[0] + ',' + info.at[1] : '') +
      (info.target ? ' 命中=' + info.target : '') +
      (info.movedPx > 10 ? '（按拖拽处理，不会弹气泡）' : '（按点击处理）'))
})

ipcMain.on('pet:debug-hit', (event, info) => {
  if (!process.env.DS_PET_DEBUG || !info) return
  log('命中判定 光标=' + info.x + ',' + info.y +
      ' 鲸鱼=' + (info.whale ? '是' : '否') +
      ' 气泡=' + (info.bubble ? '是' : '否') +
      ' 菜单=' + (info.menu ? '是' : '否') +
      ' 按钮=' + (info.btn ? '是' : '否') +
      ' 遮罩就绪=' + (info.mask ? '是' : '否'))
})

ipcMain.on('pet:quit', () => app.quit())
ipcMain.on('pet:balance', (event, text) => {
  if (typeof text === 'string' && text) balanceText = text
})

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

// 单实例：重复启动就聚焦已有的桌宠
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive()
  })

  app
    .whenReady()
    .then(async () => {
    log('启动，端口 ' + PORT + '，打包态=' + IS_PACKAGED)
    // 先把服务跑起来再开窗口：窗口加载的 /pet 就是它提供的
    const serverState = await startEmbeddedServer()
    if (!serverState.ok) {
      log('服务不可用，仍尝试打开窗口（并在界面上提示）')
    }
    const cfg = await ensureDefaultScale()
    createWindow()
    createTray()
    // 按已保存的间隔恢复自动冒泡。第一次弹泡在 period 之后，那时页面早就加载好了
    startAutoPopTimer(cfg && cfg.autoPopMs)
    pollBalanceForTray()
    setInterval(pollBalanceForTray, 60000)

    screen.on('display-metrics-changed', layout)
    screen.on('display-added', layout)
    screen.on('display-removed', layout)

    })
    // 启动流程里任何一步抛错都不能静默——那样会变成一个"进程在跑、服务在监听、
    // 但就是没有窗口"的鬼状态，日志里还看不出问题。（之前删代码漏了一处引用，
    // 就是这么炸的：reference 报错被吞掉，窗口再没被创建。）
    .catch((err) => {
      log('启动流程异常：' + String((err && err.stack) || err))
      try {
        if (!win || win.isDestroyed()) createWindow()
      } catch (e2) {
        log('兜底创建窗口也失败：' + e2.message)
      }
    })

  app.on('window-all-closed', () => app.quit())
}

// 渲染进程崩了要留痕，否则透明窗口里什么都看不见
app.on('render-process-gone', (event, contents, details) => {
  log('渲染进程退出：' + JSON.stringify(details))
  if (details && details.reason !== 'clean-exit') {
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.reload()
    }, 1000)
  }
})
