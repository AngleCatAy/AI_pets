// 从上游同步挂件前端代码。
//
//   node tools/sync-upstream.mjs            # 用 _ref/index.js 里已缓存的副本
//   node tools/sync-upstream.mjs --fetch    # 先重新下载上游 lib/index.js 再同步
//
// 关键点：上游把整个前端放在一个模板字符串里（const WIDGET_JS = `...`）。
// 必须取它的「运行时求值结果」，不能直接切片源码文本——源码里存在转义
// （如 .join('\\n') 求值后是真换行）。照抄源码会让 CSS 规则之间用字面
// "\n" 分隔，浏览器错误恢复时把那个 n 粘到下一个选择器上，导致除第一条
// 外所有样式失效。本脚本通过真正 import 该声明来求值，保证与原版一致。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REF = path.join(ROOT, '_ref', 'index.js')
const OUT = path.join(ROOT, 'lib', 'widget.js')
const UPSTREAM = 'https://raw.githubusercontent.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/main/lib/index.js'

if (process.argv.includes('--fetch')) {
  console.log('下载上游 lib/index.js ...')
  const res = await fetch(UPSTREAM, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error('下载失败: HTTP ' + res.status)
  const text = await res.text()
  fs.mkdirSync(path.dirname(REF), { recursive: true })
  fs.writeFileSync(REF, text, 'utf8')
  console.log('已缓存到 _ref/index.js (' + text.length + ' 字节)')
}

const src = fs.readFileSync(REF, 'utf8')
const decl = /^const WIDGET_JS = `[\s\S]*?`$/m.exec(src)
if (!decl) throw new Error('没能在 _ref/index.js 里定位 const WIDGET_JS 声明')

// 把该声明单独落成一个模块并 import，取到的就是模板字符串的求值结果
const tmp = path.join(os.tmpdir(), 'dspet-widget-sync-' + process.pid + '.mjs')
fs.writeFileSync(tmp, decl[0] + '\nexport default WIDGET_JS\n', 'utf8')
let evaluated
try {
  const mod = await import(pathToFileURL(tmp).href)
  evaluated = mod.default
} finally {
  try { fs.unlinkSync(tmp) } catch (err) {}
}

if (typeof evaluated !== 'string' || evaluated.length === 0) {
  throw new Error('模板字符串求值结果为空，上游结构可能变了')
}

// 上游是 DSH 插件，个别文案指向 dsh。独立版按需改写，并在此登记原因。
// 每条补丁必须命中，否则直接报错——上游一旦改动，我们要立刻知道，
// 而不是让补丁静默失效、旧的 dsh 文案又冒出来。
const PATCHES = [
  {
    from: "'实时·令牌 (用法：去问dsh)'",
    to: "'实时·令牌 (需填平台令牌)'",
    why: '原版让用户去问 dsh 怎么拿令牌；独立版没有 dsh，改为指向 config.json 的 platformToken',
  },
  {
    // 锚点用单行，避免受文件换行符影响。挂件自己的 saveConfig() 不带这个字段，
    // 服务端会沿用已存的值，所以不会被覆盖。
    from: 'setInterval(pollLastTurn, 1000)',
    to: 'setInterval(pollLastTurn, 1000)\n' +
      [
        '',
        '// 桌宠模式需要一个「主动弹一句随机台词」的入口——原版只能靠用户点击气泡触发，',
        '// 而随机台词段、加权抽签、气泡动画全是这个闭包里的私有状态。这里只开一个最小',
        '// 口子，其余内部状态仍然保持私有。',
        '// 另外附带 applyProvider（v2.0 多厂商换贴图/换配色）。',
        'var appliedProvider = null',
        'window.__dshWhaleApi = {',
        '  showRandomLine: function () {',
        '    try {',
        '      if (!bubbleOn || costBubbleActive) return false',
        '      showBubble()',
        '      bubbleRandomActive = true',
        '      bubbleRandomLines = pickRandomLines()',
        '      swapBubbleContent(function () { applyBubbleLines(bubbleRandomLines) })',
        '      if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }',
        '      bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)',
        '      return true',
        '    } catch (err) {',
        '      return false',
        '    }',
        '  },',
        '  isBubbleShown: function () { return !!bubbleShown },',
        '  // v2.0 多厂商：按厂商换贴图与配色。幂等——重复应用同一厂商不重刷图片。',
        '  // 换贴图必须连命中遮罩一起重建：遮罩是从图片 alpha 现场算的，不重建的话',
        '  // 点击判定还按旧角色轮廓走（点新角色身上反而没反应）。',
        '  applyProvider: function (p) {',
        '    try {',
        "      var want = p === 'glm' ? 'glm' : 'deepseek'",
        '      // 厂商是「设置」，不是余额响应的副产品。在这里登记成权威值，供时段文案、',
        '      // 怪话过滤、用量行分支读取。放在幂等判断之前：即使贴图那套因为重复调用',
        '      // 被跳过，这个状态也永远是对的。',
        '      state.provider = want',
        '      if (want === appliedProvider) return true',
        '      appliedProvider = want',
        "      var bust = '/dsh-whale/image.png?p=' + want + '-' + Date.now()",
        '      img.src = bust',
        '      hitReady = false',
        '      hitCanvas = document.createElement("canvas")',
        '      hitCanvas.width = 610',
        '      hitCanvas.height = 610',
        '      var probe = new Image()',
        '      probe.onload = function () {',
        '        try { hitCanvas.getContext("2d").drawImage(probe, 0, 0, 610, 610); hitReady = true } catch (err) {}',
        '      }',
        '      probe.onerror = function () {}',
        '      probe.src = bust',
        '      // 配色：GLM 走黑色系。峰谷的绿/红是行内样式（优先级高于本表），不受影响。',
        '      var THEME_ID = "dshwv-theme-glm"',
        '      var old = document.getElementById(THEME_ID)',
        '      if (want !== "glm") {',
        '        if (old && old.parentNode) old.parentNode.removeChild(old)',
        '      } else if (!old) {',
        '        var st = document.createElement("style")',
        '        st.id = THEME_ID',
        '        st.textContent = [',
        '          ".dshwv-text{color:#1c1c1c}",',
        '          ".dshwv-hint{color:#7c7c7c}",',
        '          ".dshwv-menu-row{color:#1c1c1c}",',
        '          ".dshwv-menu{background:rgba(252,252,252,.94);border-color:rgba(0,0,0,.3)}",',
        '          ".dshwv-menu-btn{background:rgba(28,28,28,.85)}",',
        '          ".dshwv-menu-btn:hover{background:#1c1c1c}",',
        '          ".dshwv-number{color:#1c1c1c;border-color:rgba(0,0,0,.35)}",',
        '          ".dshwv-range{accent-color:#1c1c1c}",',
        '          ".dshwv-check{accent-color:#1c1c1c}",',
        '          ".dshwv-volpct{color:#1c1c1c}",',
        '          ".dshwv-menu-sep{background:rgba(0,0,0,.2)}",',
        '          ".dshwv-bubble svg path,.dshwv-bubble svg ellipse{stroke:#1c1c1c}",',
        '        ].join("")',
        '        document.head.appendChild(st)',
        '      }',
        '      // GLM 暂时不支持设置「用量」和「峰谷」——这两项都是 DeepSeek 的语义',
        '      // （记账/令牌、梁文峰谷文案）。变灰但**不改值**，切回 DeepSeek 立刻恢复。',
        "      var glmOff = want === 'glm'",
        '      var setRowOff = function (row, sel, why) {',
        '        try {',
        '          if (sel) {',
        '            sel.disabled = glmOff',
        '            sel.title = glmOff ? why : ""',
        '          }',
        '          if (row) row.style.opacity = glmOff ? ".4" : ""',
        '        } catch (err) {}',
        '      }',
        '      setRowOff(row4, usageSelect, "GLM 模式暂不支持设置用量")',
        '      setRowOff(row5, peakSelect, "GLM 模式暂不支持设置峰谷文案")',
        '      return true',
        '    } catch (err) {',
        '      return false',
        '    }',
        '  },',
        '}',
      ].join('\n'),
    why: '自动冒泡需要从外部触发随机台词；原版这条路径只能由点击气泡触发。同时提供按厂商换贴图/换配色的入口',
  },
  {
    // 原值 9 = 指针移动达到 3px 就算拖拽。真实鼠标点击很容易抖过 3px，
    // 于是左键被当成"拖拽落点"，走的是吸附settle 而不是 showBubble()，
    // 用户看到的就是"点鲸鱼没反应"（右键不经过这条路径，所以正常）。
    // 放宽到 100 = 10px，小抖动仍算点击。
    from: 'var CLICK_SQ = 9',
    to: 'var CLICK_SQ = 100',
    why: '点击/拖拽判定阈值过紧，真实鼠标的轻微抖动会让左键点击被当成拖拽而失效',
  },
  {
    // 桌宠侧的两个设置（自动冒泡间隔、开机自启动）在原版里不存在，值也不在
    // 挂件内部，所以这里只负责画控件和转发：读写由 Electron 主进程处理
    // （它才有定时器和系统启动项）。没有桌宠桥时（浏览器标签页模式）不添加，
    // 免得出现两个点了没用的控件。
    from: 'menuBox.appendChild(row9)',
    to: 'menuBox.appendChild(row9)\n' +
      [
        '',
        'if (window.__dsPetHost) {',
        '  try {',
        '    var rowAuto = menuRow()',
        "    rowAuto.appendChild(menuLabel('自动冒泡'))",
        "    var autoPopSelect = document.createElement('select')",
        "    autoPopSelect.className = 'dshwv-sound'",
        "    var AUTO_OPTS = [['0', '关闭'], ['300000', '每 5 分钟'], ['900000', '每 15 分钟'],",
        "      ['1800000', '每 30 分钟'], ['3600000', '每 1 小时'], ['7200000', '每 2 小时']]",
        '    for (var ai = 0; ai < AUTO_OPTS.length; ai++) {',
        '      autoPopSelect.appendChild(soundOpt(AUTO_OPTS[ai][0], AUTO_OPTS[ai][1]))',
        '    }',
        "    autoPopSelect.addEventListener('change', function () {",
        '      try { window.__dsPetHost.setAutoPop(Number(autoPopSelect.value) || 0) } catch (err) {}',
        '    })',
        '    rowAuto.appendChild(autoPopSelect)',
        '',
        '    var rowLogin = menuRow()',
        "    rowLogin.appendChild(menuLabel('开机自启'))",
        "    var openAtLoginToggle = document.createElement('input')",
        "    openAtLoginToggle.type = 'checkbox'",
        "    openAtLoginToggle.className = 'dshwv-check'",
        "    openAtLoginToggle.title = '开机后自动启动小鲸鱼'",
        "    openAtLoginToggle.addEventListener('change', function () {",
        '      try { window.__dsPetHost.setOpenAtLogin(!!openAtLoginToggle.checked) } catch (err) {}',
        '    })',
        '    rowLogin.appendChild(openAtLoginToggle)',
        '    menuBox.appendChild(rowAuto)',
        '    menuBox.appendChild(rowLogin)',
        '',
        '    // —— 折叠栏通用件 ——',
        '    // 三角用 CSS 边框画，不用字符：字符三角在 Windows 上可能被渲染成 emoji，',
        '    // 且大小只能靠字号间接控制。▶ = 收起，▼ = 展开。8×8 对 12px 文字比例合适。',
        '    var makeCollapseTri = function () {',
        "      var t = document.createElement('span')",
        "      t.style.cssText = 'width:0;height:0;flex:0 0 auto;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:8px solid #203170'",
        '      return t',
        '    }',
        '    var setCollapseTri = function (t, expanded) {',
        '      if (expanded) {',
        "        t.style.borderTop = '8px solid #203170'",
        "        t.style.borderBottom = '0'",
        "        t.style.borderLeft = '4px solid transparent'",
        "        t.style.borderRight = '4px solid transparent'",
        '      } else {',
        "        t.style.borderTop = '4px solid transparent'",
        "        t.style.borderBottom = '4px solid transparent'",
        "        t.style.borderLeft = '8px solid #203170'",
        "        t.style.borderRight = '0'",
        '      }',
        '    }',
        '    var makeCollapseRow = function (labelText) {',
        '      // 标题行基于 menuRow()：带 dshwv-menu-row 类（12px 字号），和其它行一致。',
        '      // 别用自定义 div + 手写字体——会继承 16px，比别的行大一圈（踩过）。',
        "      var row = document.createElement('div')",
        "      row.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:2px 0'",
        '      var head = menuRow()',
        "      head.style.margin = '0'",
        "      head.style.cursor = 'pointer'",
        '      var tri = makeCollapseTri()',
        '      var lbl = menuLabel(labelText)',
        '      head.appendChild(tri)',
        '      head.appendChild(lbl)',
        '      row.appendChild(head)',
        "      return { row: row, head: head, tri: tri, label: lbl }",
        '    }',
        '',
        '    // —— 模型（折叠栏，默认收起：切换是低频操作，收起来防误触）——',
        '    // deepseek=余额/今日已用，glm=Coding Plan 配额。切换由主进程落地',
        '    //（PUT 服务端配置 + 触发一次刷新），页面不用自己拉数据。',
        '    var modelCtl = makeCollapseRow(\'模型\')',
        "    var providerSelect = document.createElement('select')",
        "    providerSelect.className = 'dshwv-sound'",
        "    providerSelect.appendChild(soundOpt('deepseek', 'DeepSeek'))",
        "    providerSelect.appendChild(soundOpt('glm', 'GLM'))",
        "    providerSelect.style.display = 'none'",
        "    providerSelect.addEventListener('change', function () {",
        '      try { window.__dsPetHost.setProvider(providerSelect.value) } catch (err) {}',
        '    })',
        "    modelCtl.head.addEventListener('click', function () {",
        "      var willExpand = providerSelect.style.display === 'none'",
        "      providerSelect.style.display = willExpand ? '' : 'none'",
        '      setCollapseTri(modelCtl.tri, willExpand)',
        '    })',
        '    modelCtl.row.appendChild(providerSelect)',
        '    menuBox.appendChild(modelCtl.row)',
        '',
        '    // —— API Key（折叠栏，紧跟在模型栏下方）——',
        '    // 标题行和输入行都基于 menuRow()：它带 dshwv-menu-row 类（12px 字号、8px 间距），',
        '    // 和上方其它设置行完全一致。别用自定义 div + 手写样式——上一版就是那么写的，',
        '    // 少了那个类导致文字继承 16px，比别的行大一圈（被反馈过）。',
        "    var apiCtl = makeCollapseRow('API Key')",
        '    var apiKeyHead = apiCtl.head',
        '    var apiKeyTri = apiCtl.tri',
        "    var apiKeyInput = document.createElement('input')",
        "    apiKeyInput.type = 'password'",
        "    apiKeyInput.className = 'dshwv-number'",
        "    apiKeyInput.style.cssText = 'width:100%;box-sizing:border-box'",
        "    apiKeyInput.placeholder = 'sk-...'",
        "    apiKeyInput.title = 'DeepSeek API Key；填完按回车（或点别处）生效，只存在本机'",
        "    apiKeyInput.addEventListener('change', function () {",
        "      try { window.__dsPetHost.setApiKey(apiKeyInput.value.trim()) } catch (err) {}",
        "    })",
        '    // change 只在失焦时触发，而这个输入框不在 <form> 里，回车不一定会触发。',
        '    // 显式在回车时失焦，保证「填完按回车就生效」这条路一定通。',
        "    apiKeyInput.addEventListener('keydown', function (e) {",
        "      if (e.key === 'Enter') apiKeyInput.blur()",
        "    })",
        '    // 框里预填的是已有 Key。不聚焦时全选的话，用户直接打字会把新 Key 插进',
        '    // 旧 Key 中间，拼出一个坏值（实测踩到）。聚焦即全选，一打字就整体替换。',
        "    apiKeyInput.addEventListener('focus', function () {",
        "      try { apiKeyInput.select() } catch (err) {}",
        "    })",
        '    // 用 var + 函数表达式而不是 function 声明：这段代码在 if 里的 try 块中，',
        '    // 块内的函数声明在严格/非严格模式下的提升行为不一样，不值得赌。',
        '    var setApiKeyExpanded = function (on) {',
        "      apiKeyInput.style.display = on ? '' : 'none'",
        '      setCollapseTri(apiKeyTri, on)',
        '    }',
        '    // 点标题那一行开合——三角本身只有几个像素，光点三角很难点中。',
        '    // 输入框在下一行，点它不会触发开合，免得想选中文本时被收起来。',
        "    apiKeyHead.addEventListener('click', function () {",
        "      var willExpand = apiKeyInput.style.display === 'none'",
        "      setApiKeyExpanded(willExpand)",
        "      try {",
        "        window.__dsPetHost.clickDiag({ kind: 'ui', detail: 'API Key 栏点击 -> ' + (willExpand ? '展开' : '收起') })",
        "      } catch (err) {}",
        "      if (willExpand) {",
        "        try { apiKeyInput.focus() } catch (err) {}",
        "      }",
        "    })",
        '    apiCtl.row.appendChild(apiKeyInput)',
        '    menuBox.appendChild(apiCtl.row)',
        '',
        '    // 真实值只有主进程知道（存在服务端配置和系统启动项里），它推送过来后同步控件',
        '    window.__dshWhalePetSettings = function (s) {',
        '      try {',
        '        if (!s) return',
        "        if (typeof s.provider === 'string') {",
        "          // 最底下那行填的是「当前厂商的凭据」：GLM 要的是 Coding Plan 令牌，",
        "          // 不是 DeepSeek 的 API Key，所以标题和占位符都跟着换；",
        "          // 值本身由主进程按厂商读写对应字段（apiKey / providers.glm.planToken）。",
        "          var isGlm = s.provider === 'glm'",
        "          providerSelect.value = s.provider",
        "          if (apiCtl.label) apiCtl.label.textContent = isGlm ? 'GLM 令牌' : 'API Key'",
        "          apiKeyInput.placeholder = isGlm ? '粘贴令牌' : 'sk-...'",
        "          apiKeyInput.title = isGlm",
        "            ? 'GLM Coding Plan 令牌（原样粘贴，不要加 Bearer 前缀）；填完按回车生效，只存在本机'",
        "            : 'DeepSeek API Key；填完按回车（或点别处）生效，只存在本机'",
        '        }',
        "        if (typeof s.autoPopMs === 'number') autoPopSelect.value = String(s.autoPopMs)",
        "        if (typeof s.openAtLogin === 'boolean') openAtLoginToggle.checked = s.openAtLogin",
        "        if (typeof s.apiKey === 'string') {",
        '          apiKeyInput.value = s.apiKey',
        '          // 已经配好了就默认收起，只留一个下三角；没配则直接展开让人能填',
        '          setApiKeyExpanded(s.apiKey.length === 0)',
        '        }',
        '      } catch (err) {}',
        '    }',
        '  } catch (err) {}',
        '}',
      ].join('\n'),
    why: '桌宠侧设置需要并入挂件自带菜单（原版菜单里没有这几项）',
  },
  {
    // GLM 配额是百分比，"98.00 %" 难看；整数 + 紧贴的 % 才像配额显示
    from: "  return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency",
    to: "  if (currency === '%') return Math.round(num) + '%'\n" +
      "  return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency",
    why: 'v2.0 多厂商：GLM 配额以百分比直接显示（不换算积分）',
  },
  {
    from: '  todayUsage: null,',
    to: '  todayUsage: null,\n' +
      "  provider: 'deepseek',\n" +
      "  providerLabel: 'DeepSeek 余额',\n" +
      "  usageLabel: '今日已用',",
    why: 'v2.0 多厂商：气泡首行标签与用量前缀改为数据驱动（GLM 时显示 GLM余额/周配额已用）；' +
      '另外记住当前厂商，供时段台词按厂商分支',
  },
  {
    from: '        state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null',
    to: '        state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null\n' +
      "        state.usageLabel = String(data.usageLabel || '今日已用')",
    why: 'v2.0 多厂商：从 balance.json 读取用量前缀（provider 的唯一来源是 applyProvider；' +
      'providerLabel 在 ok 判断之前读——见各自补丁）',
  },
  {
    from: "    hint = '今日已用 ' + (state.todayUsage !== null && state.todayUsage !== undefined ? fmt(state.todayUsage, state.currency) : '--')",
    to: "    hint = (state.usageLabel || '今日已用') + ' ' + (state.todayUsage !== null && state.todayUsage !== undefined ? fmt(state.todayUsage, state.currency) : '--')",
    why: 'v2.0 多厂商：气泡提示行前缀不再写死「今日已用」',
  },
  {
    from: "    { t: '今日已用 ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' },",
    to: "    { t: (state.usageLabel || '今日已用') + ' ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' },",
    why: 'v2.0 多厂商：随机台词的时段组前缀不再写死「今日已用」',
  },
  {
    // 余额响应里带 provider，拿到就自应用一次贴图/配色——这样浏览器标签页模式
    // 也能自动换皮（那边没有桌宠适配器可以代为调用）。
    // 必须判 data.provider 存在：错误响应（比如 GLM 没配令牌）里没有这个字段，
    // 无条件调用会把 applyProvider 里的权威状态误判回 deepseek。
    from: "        state.usageLabel = String(data.usageLabel || '今日已用')",
    to: "        state.usageLabel = String(data.usageLabel || '今日已用')\n" +
      "        if (data.provider && window.__dshWhaleApi && window.__dshWhaleApi.applyProvider) {\n" +
      "          window.__dshWhaleApi.applyProvider(data.provider)\n" +
      "        }",
    why: 'v2.0 多厂商：按余额响应里的厂商自动换贴图与配色（标签页模式也生效）',
  },
  {
    // 只改 restoreBubbleLines 里那处（2 空格缩进、state 已存在）。
    // 初始化处（顶层、无缩进）的 labelEl 赋值在 state 声明之前执行，引用 state
    // 会直接抛 TypeError、整个挂件起不来（踩过）——那行保持静态默认值即可，
    // 首次点鲸鱼时 restoreBubbleLines 会用 state 里的厂商标签覆盖它。
    from: "  labelEl.textContent = 'DeepSeek 余额'",
    to: "  labelEl.textContent = state.providerLabel || 'DeepSeek 余额'",
    count: 1,
    why: 'v2.0 多厂商：气泡首行标签改为读厂商标签（仅恢复渲染处）',
  },
  {
    // 切换厂商后标签滞留：labelEl 原本只在气泡弹出（restoreBubbleLines）时更新，
    // 而手动刷新走 render() 不走那条路——切回 DeepSeek 后数字变了、标签还是
    // "GLM 配额"（踩过）。render() 的非随机分支里同步一次。
    from: '  amountEl.textContent = amount\n' +
      '  if (bubbleRandomActive && bubbleRandomLines) {\n' +
      '    applyBubbleLines(bubbleRandomLines)\n' +
      '  } else {\n' +
      '    setHint(hint)\n' +
      '  }',
    to: '  amountEl.textContent = amount\n' +
      '  if (bubbleRandomActive && bubbleRandomLines) {\n' +
      '    applyBubbleLines(bubbleRandomLines)\n' +
      '  } else {\n' +
      "    labelEl.textContent = state.providerLabel || 'DeepSeek 余额'\n" +
      '    setHint(hint)\n' +
      '  }',
    why: 'v2.0 多厂商：切换厂商后气泡标签立即更新，不再滞留旧厂商名',
  },
  {
    // 按钮本身是深色，而 GLM 娘那块正好是黑头发——悬停显形时它压在深色贴图上
    // 等于隐形（这也是用户一度找不到入口的直接原因）。加白描边 + 投影，任何背景上都跳得出来。
    from: 'width:26px;height:26px;border:none;border-radius:6px;background:rgba(32,49,112,.85);',
    to: 'width:26px;height:26px;border:2px solid rgba(255,255,255,.92);border-radius:6px;background:rgba(32,49,112,.85);box-shadow:0 1px 4px rgba(0,0,0,.5);',
    why: '深色按钮压在深色贴图上会隐形，加白描边+投影保证在任意背景上都可见',
  },
  {
    from: "  '.dshwv-menu-btn.dshwv-menu-btn-visible{opacity:1}',",
    to: "  '.dshwv-menu-btn.dshwv-menu-btn-visible{opacity:1}',\n" +
      "  '.dshwv-menu-btn:hover{opacity:1}',",
    why: '直连悬停也把按钮变实（不再只依赖挂件自己加的 visible 类）',
  },
  {
    // 菜单按钮恰好压在贴图上：当那块像素不透明时 isWhaleHit 为真，下面这个 click
    // 拦截会把按钮/菜单控件的点击一起吃掉 → 按钮点不动。
    // 换 GLM 贴图后必现（按钮位置正压在黑头发上）：用户连点 37 次、菜单一次没开。
    // 上游只有按钮那块恰好透明时才正常，属于上游 bug —— 这里给 UI 控件放行。
    from: '  if (!isWhaleHit(e)) return\n' +
      '  try { e.preventDefault(); e.stopPropagation() } catch (err) {}\n' +
      '}',
    to: '  // 菜单按钮和菜单面板上的点击必须放行：它们压在贴图不透明像素上时\n' +
      '  // isWhaleHit 为真，拦截会把控件的 click 一起吞掉（按钮点不动的根因）\n' +
      '  if (e.target && e.target.closest &&\n' +
      "      (e.target.closest('.dshwv-menu-btn') || e.target.closest('.dshwv-menu'))) return\n" +
      '  if (!isWhaleHit(e)) return\n' +
      '  try { e.preventDefault(); e.stopPropagation() } catch (err) {}\n' +
      '}',
    count: 1,
    why: '菜单控件压在贴图不透明像素上时 click 被鲸鱼区域的拦截吞掉，导致按钮点不动',
  },
  {
    // 「梁文峰谷 / !?强强?!」这套峰谷文案是 DeepSeek 专属的趣味显示。切到 GLM 后时段
    // 文案固定用「空闲时段 / 高峰时段」，不受菜单里那个选择影响（用户要求：不要跨模型）。
    from: "  if (peakMode === 'liangwen') {\n" +
      "    offText = '梁文谷'\n" +
      "    peakText = '梁文峰'\n" +
      "  } else if (peakMode === 'qiangqiang') {\n" +
      "    offText = '!?谷谷?!'\n" +
      "    peakText = '!?峰峰?!'\n" +
      '  }',
    to: "  if (state.provider !== 'glm') {\n" +
      "    if (peakMode === 'liangwen') {\n" +
      "      offText = '梁文谷'\n" +
      "      peakText = '梁文峰'\n" +
      "    } else if (peakMode === 'qiangqiang') {\n" +
      "      offText = '!?谷谷?!'\n" +
      "      peakText = '!?峰峰?!'\n" +
      '    }\n' +
      '  }',
    why: '峰谷文案选择只应影响 DeepSeek：GLM 的时段气泡固定显示「空闲时段 / 高峰时段」',
  },
  {
    // GLM 的用量行是「周配额已用 n%」，放进时段气泡里没有意义（用户要求去掉）。
    // DeepSeek 保持原样——那一行是「今日已用 ¥x」。所以改成先组数组再按厂商决定加不加。
    from: '  return [\n' +
      "    { t: '当前时间段为:', s: 'A', c: '' },\n" +
      "    { t: peak ? peakText : offText, s: 'P', c: peak ? '#e0433f' : '#2fa24c' },\n" +
      "    { t: (state.usageLabel || '今日已用') + ' ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' },\n" +
      '  ]',
    to: '  var lines = [\n' +
      "    { t: '当前时间段为:', s: 'A', c: '' },\n" +
      "    { t: peak ? peakText : offText, s: 'P', c: peak ? '#e0433f' : '#2fa24c' },\n" +
      '  ]\n' +
      "  if (state.provider !== 'glm') {\n" +
      "    lines.push({ t: (state.usageLabel || '今日已用') + ' ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' })\n" +
      '  }\n' +
      '  return lines',
    why: 'GLM 的时段气泡不再显示用量（周配额已用）那一行',
  },
  {
    // GLM 暂时没有自己的台词池。下面这些组（怪话 + 动图）都是 DeepSeek 专属的，
    // 标上 ds 之后由 pickRandomLines() 在 GLM 下整组跳过，所以 GLM 点气泡只剩时段组。
    from: "  { w: 7, lines: function () { return singleCenter('B', pickOne(['好模型... ↓', '好女孩...↓'])) } },",
    to: "  { w: 7, ds: true, lines: function () { return singleCenter('B', pickOne(['好模型... ↓', '好女孩...↓'])) } },",
    why: 'v2.0：DeepSeek 专属怪话池只在 DeepSeek 模式下生效（GLM 暂时不说怪话）',
  },
  {
    from: "  { w: 7, lines: function () { return singleCenter('A', pickOne(['不知道用户有什么用，先赶走吧~', '我...我...我也要挣钱吗？', '我去吃饭啦，测完叫我', '压力一只蓝色大肥鱼？！', 'DeepSleep...', '坏了...用户彻底怒了！']), '', true) } },",
    to: "  { w: 7, ds: true, lines: function () { return singleCenter('A', pickOne(['不知道用户有什么用，先赶走吧~', '我...我...我也要挣钱吗？', '我去吃饭啦，测完叫我', '压力一只蓝色大肥鱼？！', 'DeepSleep...', '坏了...用户彻底怒了！']), '', true) } },",
    why: 'v2.0：DeepSeek 专属怪话池只在 DeepSeek 模式下生效',
  },
  {
    from: "  { w: 3, lines: function () { return singleCenter('A', pickOne(['你目录里的dsh是什么...大烧货吗...?', '恭喜你实现token自由！token全跑了！', '真当我是便宜货啊...']), '', true) } },",
    to: "  { w: 3, ds: true, lines: function () { return singleCenter('A', pickOne(['你目录里的dsh是什么...大烧货吗...?', '恭喜你实现token自由！token全跑了！', '真当我是便宜货啊...']), '', true) } },",
    why: 'v2.0：DeepSeek 专属怪话池只在 DeepSeek 模式下生效',
  },
  {
    from: "  { w: 1, lines: function () { return singleCenter('B', '哦鲸鲸... ') } },",
    to: "  { w: 1, ds: true, lines: function () { return singleCenter('B', '哦鲸鲸... ') } },",
    why: 'v2.0：DeepSeek 专属怪话池只在 DeepSeek 模式下生效',
  },
  {
    // 动图也是 DeepSeek 的（rua.gif 是那只鲸鱼），GLM 下整组跳过。
    // 加了这个标记之后，GLM 的抽签池里就只剩时段组了。
    from: "  { w: 10, lines: function () { return { gif: true } } },",
    to: "  { w: 10, ds: true, lines: function () { return { gif: true } } },",
    why: 'v2.0：动图是 DeepSeek 的素材，GLM 模式下不出现',
  },
  {
    // v1.2：把「好女孩...↓」与「压力一只蓝色大肥鱼？！」对调所属的组。
    // 两组权重都是 7，所以组的占比不变，变的只是这两句各自的概率：
    //   好女孩...↓      4.79% -> 1.60%（进 6 句组，被 6 等分）
    //   压力一只蓝色大肥鱼？！ 1.60% -> 4.79%（进 2 句组，被 2 等分）
    from: "pickOne(['好模型... ↓', '好女孩...↓'])",
    to: "pickOne(['好模型... ↓', '压力一只蓝色大肥鱼？！'])",
    why: 'v1.2：按用户要求对调这两句的组别，改变它们各自的出现概率',
  },
  {
    from: "'我去吃饭啦，测完叫我', '压力一只蓝色大肥鱼？！', 'DeepSleep...'",
    to: "'我去吃饭啦，测完叫我', '好女孩...↓', 'DeepSleep...'",
    why: 'v1.2：上一条对调的另一半——「好女孩...↓」进入 6 句组',
  },
  {
    // 按 provider 过滤抽签池。用组上的 ds 标记而不是下标，这样上游增删/调整
    // 台词组时不会静默错位（下标方案会在上游改动后悄悄指到别的组）。
    from: 'function pickRandomLines() {\n' +
      '  var total = 0\n' +
      '  for (var i = 0; i < RANDOM_GROUPS.length; i++) total += RANDOM_GROUPS[i].w\n' +
      '  var r = Math.random() * total\n' +
      '  for (var i = 0; i < RANDOM_GROUPS.length; i++) {\n' +
      '    r -= RANDOM_GROUPS[i].w\n' +
      '    if (r < 0) return RANDOM_GROUPS[i].lines()\n' +
      '  }\n' +
      '  return RANDOM_GROUPS[RANDOM_GROUPS.length - 1].lines()\n' +
      '}',
    to: 'function pickRandomLines() {\n' +
      '  // GLM 暂时没有自己的台词池：标了 ds 的组（怪话 + 动图）都是 DeepSeek 专属的，\n' +
      '  // GLM 下整组跳过，只剩时段组。以后加 GLM 台词池时同理加标记。\n' +
      '  var pool = []\n' +
      '  for (var i = 0; i < RANDOM_GROUPS.length; i++) {\n' +
      "    if (state.provider === 'glm' && RANDOM_GROUPS[i].ds) continue\n" +
      '    pool.push(RANDOM_GROUPS[i])\n' +
      '  }\n' +
      '  // 兜底：万一所有组都被过滤掉（正常不会），退回时段组，避免空白气泡\n' +
      '  if (!pool.length) pool = [RANDOM_GROUPS[0]]\n' +
      '  var total = 0\n' +
      '  for (var j = 0; j < pool.length; j++) total += pool[j].w\n' +
      '  var r = Math.random() * total\n' +
      '  for (var k = 0; k < pool.length; k++) {\n' +
      '    r -= pool[k].w\n' +
      '    if (r < 0) return pool[k].lines()\n' +
      '  }\n' +
      '  return pool[pool.length - 1].lines()\n' +
      '}',
    why: 'v2.0：抽签池按厂商过滤，DeepSeek 的怪话与动图不在 GLM 模式下出现',
  },
  {
    // 厂商存在服务端配置里，是「设置」而不是余额响应的副产品。挂件启动时会拉一次
    // size.json 回显设置，顺手把厂商也读下来并应用——于是厂商的来源不再依赖
    // balance.json 里有没有 provider 字段。
    // 这条修的是一个实测 bug：GLM 没配令牌时余额接口返回的是错误对象（里面没有
    // provider），state.provider 就退回 deepseek，导致时段文案、怪话过滤、用量行
    // 全按 DeepSeek 走（切到 GLM 还能看到 DeepSeek 的怪话和动图）。
    from: "    if (d && typeof d.peakMode === 'string') {\n" +
      "      peakMode = d.peakMode === 'liangwen' || d.peakMode === 'qiangqiang' ? d.peakMode : 'default'\n" +
      '      peakSelect.value = peakMode\n' +
      '    }',
    to: "    if (d && typeof d.peakMode === 'string') {\n" +
      "      peakMode = d.peakMode === 'liangwen' || d.peakMode === 'qiangqiang' ? d.peakMode : 'default'\n" +
      '      peakSelect.value = peakMode\n' +
      '    }\n' +
      "    if (d && typeof d.provider === 'string') {\n" +
      "      state.provider = d.provider === 'glm' ? 'glm' : 'deepseek'\n" +
      '      if (window.__dshWhaleApi && window.__dshWhaleApi.applyProvider) {\n' +
      '        window.__dshWhaleApi.applyProvider(d.provider)\n' +
      '      }\n' +
      '    }',
    why: 'v2.0 多厂商：厂商改从 size.json（设置）读取并应用，不再依赖余额响应里有没有 provider',
  },
  {
    // 首行文案属于「设置」层面，不是「数据」层面：搬数据失败时（比如 GLM 还没配令牌）
    // 服务端也会把厂商信息一起返回，所以必须放在 ok 判断之前读。
    // 判断依据用 data.provider（两个厂商的响应都会带），providerLabel 缺失时退回该厂商
    // 的默认文案——不能只依赖 providerLabel 是否存在：DeepSeek 的响应原本不带这个字段，
    // 于是从 GLM 切回 DeepSeek 后标签会一直停在「GLM余额」（用户实测到的 bug）。
    from: '      if (data && data.ok) {',
    to: '      // 首行文案按厂商定，与这次数据拉没拉到无关\n' +
      '      if (data && data.provider) {\n' +
      "        state.providerLabel = (typeof data.providerLabel === 'string' && data.providerLabel)\n" +
      '          ? data.providerLabel\n' +
      "          : (data.provider === 'glm' ? 'GLM余额' : 'DeepSeek 余额')\n" +
      '      }\n' +
      '      if (data && data.ok) {',
    why: 'v2.0 多厂商：首行文案在 ok 判断之前按厂商定，缺失 providerLabel 时用厂商默认文案兜底',
  },
]

let patched = evaluated
for (const p of PATCHES) {
  const want = p.count || 1
  const hits = patched.split(p.from).length - 1
  if (hits !== want) {
    throw new Error('补丁未命中（出现 ' + hits + ' 次，应为 ' + want + '）：' + p.from + '\n原因：' + p.why)
  }
  patched = patched.split(p.from).join(p.to)
  console.log('已应用补丁: ' + p.from.slice(0, 60) + (p.from.length > 60 ? '…' : ''))
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, patched, 'utf8')

// 用 --check 让 Node 自己确认产出是合法 JS，避免写坏前端还浑然不觉
const { execFileSync } = await import('node:child_process')
execFileSync(process.execPath, ['--check', OUT], { stdio: 'inherit' })

console.log('已写出 lib/widget.js')
console.log('  源文本长度 : ' + decl[0].length)
console.log('  求值后长度 : ' + evaluated.length)
console.log('  补丁数     : ' + PATCHES.length)
console.log('  语法检查   : 通过')
