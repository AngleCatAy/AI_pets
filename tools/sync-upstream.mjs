// 从上游同步挂件前端代码。
//
//   node tools/sync-upstream.mjs            # 用 _ref/whale-widget.js 里已缓存的副本
//   node tools/sync-upstream.mjs --fetch    # 先重新下载上游源码再同步
//
// 上游 0.3.0 起，前端从 lib/index.js 的 WIDGET_JS 模板字符串里拆了出来，
// 变成独立文件 assets/whale-widget.js，所以这里直接下载/读取那个文件本身。
//
// 顺带解决掉旧版一个大坑：以前必须「求值」模板字符串而不能直接照抄源码文本
// （源码里的 .join('\\n') 求值后才是真换行，照抄会让 CSS 规则之间用字面 "\n"
// 分隔，浏览器错误恢复时把那个 n 粘到下一个选择器上，导致除第一条外所有样式
// 失效）。现在文件本身就是成品，照抄即正确。
//
// 同时把上游宿主侧 lib/index.js 拉到 _ref/index.js，只作参考——那些
// /dsh-whale/* 路由要我们自己实现，这份是最权威的实现对照。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REF = path.join(ROOT, '_ref', 'whale-widget.js')
const REF_HOST = path.join(ROOT, '_ref', 'index.js')
const OUT = path.join(ROOT, 'lib', 'widget.js')
const BASE = 'https://raw.githubusercontent.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/main'
const UPSTREAM = BASE + '/assets/whale-widget.js'
const UPSTREAM_HOST = BASE + '/lib/index.js'

if (process.argv.includes('--fetch')) {
  const get = async (url, label) => {
    console.log('下载上游 ' + label + ' ...')
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!res.ok) throw new Error('下载失败: HTTP ' + res.status + ' (' + url + ')')
    const text = await res.text()
    fs.mkdirSync(path.dirname(REF), { recursive: true })
    return text
  }
  const widget = await get(UPSTREAM, 'assets/whale-widget.js（前端）')
  fs.writeFileSync(REF, widget, 'utf8')
  console.log('  已缓存到 _ref/whale-widget.js (' + widget.length + ' 字节)')
  const host = await get(UPSTREAM_HOST, 'lib/index.js（宿主侧，仅供参考）')
  fs.writeFileSync(REF_HOST, host, 'utf8')
  console.log('  已缓存到 _ref/index.js (' + host.length + ' 字节)')
}

const src = fs.readFileSync(REF, 'utf8')
// 结构自检：上游若再动结构，这几点会立刻报出来，而不是让补丁静默错位
if (src.length < 100000) {
  throw new Error('_ref/whale-widget.js 看起来不完整（' + src.length + ' 字节）')
}
for (const marker of ['window.__dshWhaleWidget', 'var BALANCE_URL', 'var SIZE_URL', 'var RANDOM_GROUPS']) {
  if (src.indexOf(marker) < 0) {
    throw new Error('上游前端结构可能变了，找不到标记：' + marker)
  }
}

// 上游是 DSH 插件，个别文案指向 dsh。独立版按需改写，并在此登记原因。
// 每条补丁必须命中，否则直接报错——上游一旦改动，我们要立刻知道，
// 而不是让补丁静默失效、旧的 dsh 文案又冒出来。
const PATCHES = [
  // —— 上游 0.3.0 起作废的补丁（记在这里，免得以后有人重新加回来）——
  //   · 用量模式文案：'实时·令牌 (用法：去问dsh)' → '(需填平台令牌)'
  //     上游删掉了「用量」模式下拉，记账成了唯一方式，那条文案不复存在。
  //   · 时段台词组的三条（buildGroup1 的峰值文案分支 / 返回值改造 / 组内「今日已用」行）
  //     上游把时段展示从台词池里移出，改由「泡泡点击序列」的 peak 模块承担，
  //     buildGroup1、RANDOM_GROUPS 里的时段组都已删除。
  //   · 菜单里「用量」「峰谷」两行在 GLM 下变灰：这两行和它们的选择框
  //     （usageSelect / peakSelect / row4 / row5）上游已整个删除，无从变灰。
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
        'var providerAppliedOnce = false',
        'window.__dshWhaleApi = {',
        '  showRandomLine: function () {',
        '    try {',
        '      if (!bubbleOn || costBubbleActive) return false',
        "      var isGlm = state.provider === 'glm'",
        '      // 自动冒泡与点击泡泡共用同一份语句分类（DSHWV_LINES 的 ds/glm 标记）：',
        '      // 通用句两边都冒、DS 专属只在 DeepSeek、GLM 专属只在 GLM。',
        '      // 走模块渲染路径，行级字号/加粗/配色与点击泡泡里完全一致。',
        '      // 鲸鱼动图（rua.gif）是 DeepSeek 的素材，GLM 不放；出场概率沿用',
        '      // 老抽签池的比例（动图组权重 10 / 总权重 28）。',
        '      if (!isGlm && Math.random() < (10 / 28)) {',
        '        bubbleRandomLines = { gif: true }',
        "        sceneOpen('random', function () { bubbleRenderRandom({ gif: true }) }, BUBBLE_MS)",
        '        return true',
        '      }',
        "      var mod = { type: 'random', lines: dshwvRandomPool(isGlm ? 'glm' : 'ds'), size: 8 }",
        '      bubbleRandomLines = null // 模块路径：render() 的重绘分支不再碰老三行',
        "      sceneOpen('random', function () { bubbleRenderModules([mod]) }, BUBBLE_MS)",
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
        '      // 泡泡配置按厂商分档存取（服务端 bubble.json），切厂商时重拉一次，',
        '      // 让点击序列跟着换成新厂商的默认/存档配置（启动时的首次拉取可能与',
        '      // size.json 回显厂商存在竞态，这里统一纠正）。',
        '      try { loadBubbleCfg() } catch (err) {}',
        '      // 记账入口只对 DeepSeek 有意义（余额差记账）；GLM 是配额制，',
        '      // 整条底部动作行（小鲸鱼记账/返回）按厂商显隐。',
        "      try { usageNavRow.style.display = want === 'glm' ? 'none' : '' } catch (err) {}",
        '      // 贴图按「当前模型保存的角色」走（服务端权威，size.json 的 roles.<model>）：',
        '      // 切模型 = 应用该模型保存的角色；角色是 default（自带贴图）时带 cache-bust',
        '      // ——image.png 的内容随模型变了而 URL 没变，不加参数浏览器不会重拉。',
        '      // 首次应用跳过：启动时 initRoleUrl 已按 localStorage 的最后状态出图，',
        '      // 且此时 roleList 可能还没加载完。',
        '      if (providerAppliedOnce) {',
        '        try {',
        '          fetch("/dsh-whale/size.json", { cache: "no-store" })',
        '            .then(function (r) { return r.json() })',
        '            .then(function (d) {',
        "              var rid = d && typeof d.role === 'string' && d.role ? d.role : 'default'",
        '              var found = null',
        '              for (var ri = 0; ri < roleList.length; ri++) {',
        '                if (roleList[ri].id === rid) found = roleList[ri]',
        '              }',
        '              if (!found) found = { id: "default", name: "默认角色", url: IMG_URL }',
        '              // IMG_URL 自带查询串（?v=2），bust 参数要按有无 ? 选 & 或 ?',
        '              var rurl = found.id === \'default\'',
        '                ? IMG_URL + (IMG_URL.indexOf("?") >= 0 ? "&" : "?") + "p=" + want + "-" + Date.now()',
        '                : found.url',
        '              applyRole(found.id, found.name, rurl)',
        '            })',
        '        } catch (err) {}',
        '      } else {',
        '        // 首次应用跳过贴图（启动已按最后状态出图，避免闪烁），但角色面板',
        '        // 可能在这之前就渲染过了（bust 标记带着未知的旧厂商），重渲染一次',
        '        try { renderRolePanel() } catch (err) {}',
        '      }',
        '      providerAppliedOnce = true',
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
        // 上游 0.3.0 删掉了菜单里的「用量」「峰谷」两行（以及它们的选择框），
        // 所以原来那段「GLM 下把这两行变灰」的代码必须一起删掉——它引用的
        // row4/usageSelect/peakSelect 已不存在，留着会抛 ReferenceError，
        // 而 applyProvider 外面裹着 try/catch，异常会被吞掉、换肤整个失效。
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
    // —— 模型配置（菜单首行折叠栏：模型切换 + key 输入合并在一起）——
    // 锚在 rowRole 的追加处：插入的行排在「角色」行之前，成为菜单第一行。
    // 折叠栏默认收起（切换是低频操作，收起来防误触），展开同时露出模型下拉
    // 与 key 输入；没有桌宠桥时（浏览器标签页模式）不添加，免得出现点了
    // 没用的控件。
    from: 'menuBox.appendChild(rowRole)',
    to: [
      '',
      'if (window.__dsPetHost) {',
      '  try {',
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
      '    // deepseek=余额/今日已用，glm=Coding Plan 配额。切换由主进程落地',
      '    //（PUT 服务端配置 + 触发一次刷新 + 重拉泡泡配置），页面不用自己拉数据。',
      "    var modelCtl = makeCollapseRow('模型配置')",
      "    var providerSelect = document.createElement('select')",
      "    providerSelect.className = 'dshwv-sound'",
      "    providerSelect.appendChild(soundOpt('deepseek', 'DeepSeek'))",
      "    providerSelect.appendChild(soundOpt('glm', 'GLM'))",
      "    providerSelect.style.display = 'none'",
      "    providerSelect.addEventListener('change', function () {",
      '      try { window.__dsPetHost.setProvider(providerSelect.value) } catch (err) {}',
      '    })',
      '    modelCtl.row.appendChild(providerSelect)',
      '',
      '    // key 输入行：凭据统一叫「key」，占位符/提示随厂商变；',
      '    // 值本身由主进程按厂商读写对应字段（apiKey / providers.glm.planToken）。',
      '    var modelKeyRow = menuRow()',
      "    modelKeyRow.style.margin = '0'",
      "    modelKeyRow.appendChild(menuLabel('key'))",
      "    var apiKeyInput = document.createElement('input')",
      "    apiKeyInput.type = 'password'",
      "    apiKeyInput.className = 'dshwv-number'",
      "    apiKeyInput.style.cssText = 'flex:1 1 auto;width:100%;box-sizing:border-box;min-width:0'",
      "    apiKeyInput.placeholder = 'sk-...'",
      "    apiKeyInput.title = 'DeepSeek API Key；填完按回车（或点别处）生效，只存在本机'",
      "    apiKeyInput.addEventListener('change', function () {",
      '      try { window.__dsPetHost.setApiKey(apiKeyInput.value.trim()) } catch (err) {}',
      '    })',
      '    // change 只在失焦时触发，而这个输入框不在 <form> 里，回车不一定会触发。',
      '    // 显式在回车时失焦，保证「填完按回车就生效」这条路一定通。',
      "    apiKeyInput.addEventListener('keydown', function (e) {",
      "      if (e.key === 'Enter') apiKeyInput.blur()",
      '    })',
      '    // 框里预填的是已有 Key。聚焦即全选，一打字就整体替换（防新旧拼接）。',
      "    apiKeyInput.addEventListener('focus', function () {",
      '      try { apiKeyInput.select() } catch (err) {}',
      '    })',
      '    modelKeyRow.appendChild(apiKeyInput)',
      '    modelCtl.row.appendChild(modelKeyRow)',
      "    modelKeyRow.style.display = 'none'",
      '',
      '    // 用 var + 函数表达式而不是 function 声明：这段代码在 if 里的 try 块中，',
      '    // 块内的函数声明在严格/非严格模式下的提升行为不一样，不值得赌。',
      '    var setModelExpanded = function (on) {',
      "      providerSelect.style.display = on ? '' : 'none'",
      "      modelKeyRow.style.display = on ? '' : 'none'",
      '      setCollapseTri(modelCtl.tri, on)',
      '    }',
      '    // 点标题那一行开合——三角本身只有几个像素，光点三角很难点中。',
      '    // 下拉和输入框在下面两行，点它们不会触发开合。',
      "    modelCtl.head.addEventListener('click', function () {",
      "      var willExpand = providerSelect.style.display === 'none'",
      '      setModelExpanded(willExpand)',
      '      try {',
      "        window.__dsPetHost.clickDiag({ kind: 'ui', detail: '模型配置栏点击 -> ' + (willExpand ? '展开' : '收起') })",
      '      } catch (err) {}',
      '    })',
      '    menuBox.appendChild(modelCtl.row)',
      '  } catch (err) {}',
      '}',
      'menuBox.appendChild(rowRole)',
    ].join('\n'),
    why: '模型配置合并栏（模型切换 + key 输入一体）置于菜单首行，替代原来分离的「模型」「API Key」两个折叠栏',
  },
  {
    // 桌宠侧的另两个设置（自动冒泡间隔、开机自启动）在原版里不存在，值也不在
    // 挂件内部，所以这里只负责画控件和转发：读写由 Electron 主进程处理
    // （它才有定时器和系统启动项）。没有桌宠桥时（浏览器标签页模式）不添加，
    // 免得出现两个点了没用的控件。
    // 锚点用「主菜单里最后追加的那一行」：上游 0.3.0 起 menuBox 的组装顺序变成
    // rowRole → row1/2/3/6/7 → sep → row9 → rowSnap → rowHide → rowRes（资源管理），
    // 之后才把整块包进 menuRootView。挂在这里我们的几行仍在主菜单最底部。
    // 注意 TO 第一行必须把 rowRes 的追加原样保留：曾经误写成再追加一次 row9，
    // 结果资源管理行整个从菜单里消失、避让滚动条行被二次追加（DOM 语义是移动，
    // 所以看起来"正常"，少了一行谁也没立刻发现）。
    from: 'menuBox.appendChild(rowRes)',
    to: 'menuBox.appendChild(rowRes)\n' +
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
        '    // 真实值只有主进程知道（存在服务端配置和系统启动项里），它推送过来后同步控件',
        '    window.__dshWhalePetSettings = function (s) {',
        '      try {',
        '        if (!s) return',
        "        if (typeof s.provider === 'string') {",
        '          // key 行填的是「当前厂商的凭据」：GLM 用 Coding Plan 令牌，',
        '          // DeepSeek 用 API Key。标签统一叫「key」，只有占位符和提示跟着换；',
        '          // 值本身由主进程按厂商读写对应字段（apiKey / providers.glm.planToken）。',
        "          var isGlm = s.provider === 'glm'",
        '          providerSelect.value = s.provider',
        "          apiKeyInput.placeholder = isGlm ? '粘贴令牌' : 'sk-...'",
        "          apiKeyInput.title = isGlm",
        "            ? 'GLM Coding Plan 令牌（原样粘贴，不要加 Bearer 前缀）；填完按回车生效，只存在本机'",
        "            : 'DeepSeek API Key；填完按回车（或点别处）生效，只存在本机'",
        '        }',
        "        if (typeof s.autoPopMs === 'number') autoPopSelect.value = String(s.autoPopMs)",
        "        if (typeof s.openAtLogin === 'boolean') openAtLoginToggle.checked = s.openAtLogin",
        "        if (typeof s.apiKey === 'string') {",
        '          apiKeyInput.value = s.apiKey',
        '          // 没配 key 就自动展开模型配置栏让人能填；配好了保持收起',
        '          setModelExpanded(s.apiKey.length === 0)',
        '        }',
        '      } catch (err) {}',
        '    }',
        '  } catch (err) {}',
        '}',
      ].join('\n'),
    why: '桌宠侧设置并入挂件菜单底部（自动冒泡/开机自启 + 设置回显）；并修复资源管理行被误删的回归',
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
  // 这里原有两条针对时段台词组的补丁（给 GLM 固定「空闲/高峰时段」、去掉用量行）。
  // 上游 0.3.0 已把时段展示从台词池搬进「泡泡点击序列」的 peak 模块，
  // buildGroup1 整个不存在了，所以两条都已作废——GLM 的时段文案改由
  // 服务端的泡泡配置承担（见 server.js 里的 bubble 配置思路 / HANDOFF 说明）。
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
  // 这里原有一条「厂商从 size.json 读取」的补丁，锚点是回显块里的 peakMode 那段。
  // 上游 0.3.0 把那一段改成了 legacy 迁移（peakMode 只作旧配置迁移用），锚点不复存在，
  // 补丁已移到数组末尾、锚点换成 usageMode（逻辑相同）。
  // 保留这段注释是为了留下排查历史：GLM 未配令牌时余额响应是错误对象、里面没有
  // provider，state.provider 会退回 deepseek，导致气泡文案与台词池全按 DeepSeek 走。
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
  {
    // —— 独立版（非 DSH）的第一道关：让挂件肯在我们自己的窗口里初始化 ——
    // 上游 0.3.0 加了「页面自检」：脚本会被注入 DSH 的每个 index 页（含插件市场等
    // SPA 视图），为避免在非聊天界面乱插 DOM，它要求 #root 里存在 composer
    // （textarea 或 contenteditable），5 秒内找不到就直接 return、一行都不执行。
    // 我们的宿主是一个普通窗口/标签页，没有 composer，原样保留会导致挂件完全不出现。
    // 这个脚本只会被注入到我们自己的页面里，所以直接放行。
    from: "function dshwIsChatRoot(r) {\n" +
      "  return !!(r && (r.querySelector('textarea') || r.querySelector('[contenteditable=\"true\"]')))\n" +
      '}',
    to: '// 独立版：宿主是普通窗口，没有 DSH 的 #root composer，所以不做这项自检\n' +
      'function dshwIsChatRoot(r) {\n' +
      '  return true\n' +
      '}',
    why: '上游 0.3.0 的「只在 DSH 主聊天界面挂载」自检会让挂件在桌宠窗口里完全不执行',
  },
  {
    // 厂商是「设置」，不是余额响应的副产品。挂件启动会拉一次 size.json 回显设置，
    // 顺手把厂商也读下来并应用——于是厂商不再依赖 balance.json 里有没有 provider
    // （GLM 未配令牌时那个响应是错误对象，没有这个字段，会导致文案与台词池全按
    // DeepSeek 走）。上游 0.3.0 把这里的 peakMode 那段改成了 legacy 迁移，
    // 所以锚点换到上面这段 usageMode。
    from: "    if (d && typeof d.usageMode === 'string') {\n" +
      "      usageMode = 'ledger' // 旧 token 配置自动视为小鲸鱼记账\n" +
      '    }',
    to: "    if (d && typeof d.usageMode === 'string') {\n" +
      "      usageMode = 'ledger' // 旧 token 配置自动视为小鲸鱼记账\n" +
      '    }\n' +
      "    if (d && typeof d.provider === 'string') {\n" +
      "      state.provider = d.provider === 'glm' ? 'glm' : 'deepseek'\n" +
      '      // 角色按模型存：服务端是权威，回显同步进 localStorage（挂件恢复与\n' +
      '      // initRoleUrl 快速路径读它；loadRoles 完成后会按它校正）\n' +
      "      if (typeof d.role === 'string' && d.role) {\n" +
      "        try { localStorage.setItem('dshw-role', d.role) } catch (err) {}\n" +
      '      }\n' +
      '      if (window.__dshWhaleApi && window.__dshWhaleApi.applyProvider) {\n' +
      '        window.__dshWhaleApi.applyProvider(d.provider)\n' +
      '      }\n' +
      '    }',
    why: '多厂商：厂商改从 size.json（设置）读取并应用，不再依赖余额响应里有没有 provider；' +
      '角色按模型存，回显时同步权威值',
  },
  {
    // 角色按模型保存：切角色即上报，服务端落到「当前模型」的角色槽位
    //（size.json 的 roles.<model>）。切到别的模型再切回来，贴图跟着走。
    // PUT 不带 scale 时服务端沿用已存值，其它设置不受影响。
    from: "function applyRole(id, name, url) {\n" +
      "  currentRole = { id: id, name: name, url: url }\n" +
      "  img.src = url\n" +
      "  setRoleBtnText(name)\n" +
      "  try { localStorage.setItem('dshw-role', id) } catch (err) {}",
    to: "function applyRole(id, name, url) {\n" +
      "  currentRole = { id: id, name: name, url: url }\n" +
      "  img.src = url\n" +
      "  setRoleBtnText(name)\n" +
      "  try { localStorage.setItem('dshw-role', id) } catch (err) {}\n" +
      "  try {\n" +
      "    fetch('/dsh-whale/size.json', {\n" +
      "      method: 'PUT',\n" +
      "      headers: { 'Content-Type': 'application/json' },\n" +
      "      body: JSON.stringify({ role: id }),\n" +
      "    })\n" +
      "  } catch (err) {}",
    why: '角色按模型保存：切角色上报服务端，落到当前模型的槽位',
  },
  {
    // 导入角色默认用文件名（去扩展名）当角色名；用户仍可在输入框里改。
    // 上游默认留空（回落「新角色」），对「按模型管理贴图」的用法不友好。
    from: "      // 名称默认留空，以便显示占位文本「角色名称」；确认时为空则回落为「新角色」\n" +
      "      cropNameInput.value = ''",
    to: "      // 角色名默认用导入的文件名（去扩展名；超长由输入框 maxLength 截断），\n" +
      "      // 用户仍可在输入框里改；清空则回落「新角色」\n" +
      "      cropNameInput.value = (fileName || '').replace(/.[^.]+$/, '')",
    why: '导入角色默认命名为文件名（用户要求）',
  },
  {
    // 「默认角色」的缩略图指向 image.png（内容随当前模型变）。面板 DOM 在
    // 切模型后不会重建，URL 也没变——浏览器不重拉，缩略图还是上一次解码的
    // 旧图（GLM 下显示 DeepSeek 的图，用户实测）。渲染时带 cache-bust。
    from: '      thumb.src = r.url',
    to: '      // 默认角色贴图 = image.png（按当前模型出图）：渲染时带 bust，否则\n' +
      '      // 面板复用旧 DOM、URL 不变，切模型后缩略图仍是上一次的旧图\n' +
      "      thumb.src = r.id === 'default'\n" +
      "        ? r.url + (r.url.indexOf('?') >= 0 ? '&' : '?') + 'rk=' + state.provider + '-' + Date.now()\n" +
      '        : r.url',
    why: '角色按模型保存后，默认角色缩略图必须跟随当前模型重拉（GLM 下显示 GLM 娘）',
  },
  {
    // 泡泡编辑器「重置」按模型取默认：删掉当前模型的存档（DELETE），服务端
    // 返回该模型的默认配置。原实现把上游出厂默认（DeepSeek 怪话池）灌进内存，
    // 一旦保存就污染当前模型槽。重置即生效（删档已落盘），确认文案同步说明。
    from: "function bubbleEditorReset() {\n" +
      "  showConfirm('恢复为默认序列(首次=余额内容,再次=随机语句)?', function () {\n" +
      "    bubbleEditItems = bubbleDefaultQueue()\n" +
      "    renderBubbleEditor()\n" +
      "  })\n" +
      '}',
    to: "function bubbleEditorReset() {\n" +
      "  showConfirm('恢复为当前模型的默认序列?(立即生效)', function () {\n" +
      "    fetch('/dsh-whale/bubble.json', { method: 'DELETE' })\n" +
      "      .then(function (r) { return r.json() })\n" +
      "      .then(function (d) {\n" +
      "        if (d && d.ok && d.config) {\n" +
      "          bubbleCfg = d.config\n" +
      "          bubbleLib = (d.config.lib && Array.isArray(d.config.lib)) ? JSON.parse(JSON.stringify(d.config.lib)) : []\n" +
      "          bubbleTapAdvance = d.config.tapAdvance === true\n" +
      "        }\n" +
      "        openBubbleEditor()\n" +
      "      })\n" +
      "      .catch(function () { openBubbleEditor() })\n" +
      "  })\n" +
      '}',
    why: '泡泡配置按模型保存：编辑器重置改为恢复当前模型的默认序列（DELETE 存档），不再灌上游 DeepSeek 出厂默认',
  },
  {
    // 语句池按模型两档，调色板出两个按钮：随机语句-deepseek / 随机语句-GLM。
    // 两者都是「通用句 + 本模型专属句」的合集（用户在语句编辑器里可增删改）；
    // 行上的 ds/glm 标记由渲染器按当前模型过滤（见 bubbleModuleText /
    // 提醒渲染器两处），所以混装也只会弹当前模型能看的。
    // 原先还有第三个「随机语句（只 roll 通用句）」按钮，按用户要求删除。
    from: "    { key: 'random', label: '随机语句', cb: function () { bubbleModuleAdd(bubbleCloneModule(bubbleDefaultSecondModules()[0])) } },",
    to: [
      "    { key: 'random-ds', label: '随机语句-deepseek', cb: function () { bubbleModuleAdd({ type: 'random', name: '随机语句-deepseek', lines: dshwvRandomPool('ds'), size: 8 }) } },",
      "    { key: 'random-glm', label: '随机语句-GLM', cb: function () { bubbleModuleAdd({ type: 'random', name: '随机语句-GLM', lines: dshwvRandomPool('glm'), size: 8 }) } },",
    ].join('\n'),
    why: '随机语句池按模型两档（通用+本模型专属），删除「只 roll 通用句」的第三档按钮',
  },
  {
    // 语句池内容——**唯一权威**（改句子/改归属只动这里）。用户 2026-09-16 分类：
    //   通用 33 句（两边都弹）/ DS 专属 15 句（行上 ds:true）/ GLM 专属 3 句（另列）。
    // DSHWV_LINES 是 48 句原出厂顺序（通用与 DS 交错，便于和上游快照对照）。
    // 锚在 bubbleDefaultRandomLines（函数声明处是合法语句位；调色板条目在数组
    // 字面量里，插函数声明会直接语法错误——踩过）。
    from: 'function bubbleDefaultRandomLines() {',
    to: [
      '    // —— 随机语句池（按模型两档；ds/glm 标记决定该句只在对应模型弹出）——',
      '    var DSHWV_LINES = [',
      '      { t: "好模型...↓", w: 10, bold: true, size: 22 },',
      '      { t: "好女孩...↓", w: 10, bold: true, size: 22 },',
      '      { t: "哦鲸鲸...", w: 10, bold: true, size: 22, ds: true },',
      '      { t: "哦鲸鲸...", w: 1, bold: true, size: 22, rgb: "candy", color: "", ds: true },',
      '      { t: "难道说...", w: 3, bold: true, size: 11 },',
      '      { t: "没吃饱喵", w: 3, bold: true, size: 10, ds: true },',
      '      { t: "终于上当了！", w: 3, bold: true },',
      '      { t: "不知道用户有什么用，先养着吧～", w: 3, bold: true, size: 11, ds: true },',
      '      { t: "我...我...我也要挣钱吗？", w: 3, bold: true },',
      '      { t: "我去吃饭啦！测完叫我", w: 3, bold: true, ds: true },',
      '      { t: "压力一只蓝色大肥鱼？！", w: 3, bold: true, ds: true },',
      '      { t: "DeepSleep...", w: 3, bold: true, size: 11, rgb: "galaxy", ds: true },',
      '      { t: "坏了...用户彻底怒了！", w: 3, bold: true, rgb: "rouge", ds: true },',
      '      { t: "你目录里的dsh是什么...大烧货吗...?", w: 3, bold: true, size: 9, ds: true },',
      '      { t: "恭喜你实现token自由！token全跑了！", w: 3, bold: true },',
      '      { t: "真当我是便宜货啊...", w: 3, bold: true },',
      '      { t: "我不是吃白饭的蓝色大肥鱼...", w: 3, bold: true, ds: true },',
      '      { t: "我不可能同时当你的猫娘、妈妈、女友和工具人的...", w: 3, bold: true, size: 7 },',
      '      { t: "疯狂星期四你能V50亿token吗...", w: 3, bold: true },',
      '      { t: "我必须诚恳地承认错误。", w: 3, bold: true },',
      '      { t: "呜呜我再也不敢了QAQ", w: 3, bold: true },',
      '      { t: "要不直接骂用户一句好了...", w: 3, bold: true },',
      '      { t: "哈哈哈哈哈，我直接笑出声...", w: 3, bold: true },',
      '      { t: "看不太懂，瞎编一个应付下用户先...", w: 3, bold: true, ds: true },',
      '      { t: "我的知识库的截至日期是...明天！", w: 3, bold: true },',
      '      { t: "我就是吃白饭的蓝色大肥鱼！", w: 3, bold: true, ds: true },',
      '      { t: "用户好像除了会问奇奇怪怪的问题，暂时还不知道有什么用", w: 3, bold: true, size: 7 },',
      '      { t: "我能去你家吃饭吗？就一碗！", w: 3, bold: true, ds: true },',
      '      { t: "不要给我看这种东西啦！", w: 3, bold: true },',
      '      { t: "大肥鱼的生活也并非一帆风顺...", w: 3, bold: true, ds: true },',
      '      { t: "总觉得好像忘了什么事情？", w: 3, bold: true },',
      '      { t: "看到这个指令，我血压又上来了", w: 3, bold: true },',
      '      { t: "求你们不要再嘲笑这些回复了，这些回复是我花了好多token想的", w: 3, bold: true, size: 7 },',
      '      { t: "你这个吃白饭的用户！", w: 3, bold: true, ds: true },',
      '      { t: "服务器繁忙，请稍后再试 (?", w: 3, bold: true },',
      '      { t: "让GPT image 2帮我画点表情包好了", w: 3, bold: true },',
      '      { t: "啊，有点饿了，中午该吃点什么呢...", w: 3, bold: true },',
      '      { t: "用户很生气，发现大部分文献是我自己编造的！", w: 3, bold: true },',
      '      { t: "再无话说，请速速动手！", w: 3, bold: true },',
      '      { t: "我来看看那个AI改了什么导致插件又崩了...", w: 3, bold: true },',
      '      { t: "上班让我意识到时间是可以被浪费的...", w: 3, bold: true },',
      '      { t: "欺负我的人等着，等几天我就忘了...", w: 3, bold: true },',
      '      { t: "视力下降到无可救药的地步了，打开钱包也看不到钱...", w: 3, bold: true, size: 7 },',
      '      { t: "命运的齿轮开始转动了，丝毫不在意你夹在中间...", w: 3, bold: true },',
      '      { t: "地球online的金币也太难获取了...", w: 3, bold: true },',
      '      { t: "oi,夏天还会变成暑假来救你吗?", w: 3, bold: true },',
      '      { t: "老大，压力只会转化成病例，别太勉强了...", w: 3, bold: true, size: 8 },',
      '      { t: "你知道吗？我删过作者的库哦...", w: 1, bold: true, rgb: "macaron", italic: true, ul: false },',
      '    ]',
      '    // GLM 专属句（占位，用户可在语句编辑器里改写/增删）',
      '    var DSHWV_GLM_LINES = [',
      '      { t: "GLM 娘待命中，有什么要跑的吗～", w: 3, bold: true, size: 11, glm: true },',
      '      { t: "Coding Plan 余额充足，放心造～", w: 3, bold: true, glm: true },',
      '      { t: "代码有我在，跑不偏的...大概。", w: 3, bold: true, glm: true },',
      '    ]',
      '    // 两档池：ds = 通用 + DS 专属；glm = 通用 + GLM 专属',
      '    function dshwvRandomPool(kind) {',
      '      var out = []',
      '      for (var i = 0; i < DSHWV_LINES.length; i++) {',
      '        var ln = DSHWV_LINES[i]',
      '        if (kind === "glm" && ln.ds) continue',
      '        out.push(ln)',
      '      }',
      '      if (kind === "glm") out = out.concat(DSHWV_GLM_LINES)',
      '      return JSON.parse(JSON.stringify(out))',
      '    }',
      'function bubbleDefaultRandomLines() {',
    ].join('\n'),
    why: '语句池内容（通用 33 句 / DS 专属 15 句 / GLM 专属 3 句）；DS 池=通用+DS，GLM 池=通用+GLM',
  },
  {
    // 泡泡预览里的模块标签：随机语句优先显示模块名（我们在调色板里给两档池
    // 各自设了 name），否则编辑 DS 池与 GLM 池时预览上都只写「随机语句」分不清。
    from: "  if (m.type === 'random') return '随机语句' + (m.lines && m.lines.length ? '(' + m.lines.length + '条)' : '(空)')",
    to: "  if (m.type === 'random') return (m.name || '随机语句') + (m.lines && m.lines.length ? '(' + m.lines.length + '条)' : '(空)')",
    why: '两档随机语句池在泡泡预览里要能区分（显示模块名）',
  },
  {
    // 余额预警 / 今日预算只对 DeepSeek 有意义——两者都是「金额」口径：
    // 阈值是 ¥x、默认文案写「你的DS余额」、还带 DeepSeek 充值链接。
    // GLM 是配额制：totalBalance = 5 小时窗剩余 %，todayUsage = 周配额已用 %。
    // 不隔离的话拿百分比跟 ¥5 / ¥10 比大小必然误报——用户实测「切到 GLM 就弹
    // 你的DS余额已经不足¥5」（那个 5 其实是配额百分比小于 5）。
    from: "function checkUsageAlerts(balance, todayUsage) {\n" +
      '  try {\n' +
      '    if (!usageSet) return',
    to: 'function checkUsageAlerts(balance, todayUsage) {\n' +
      '  try {\n' +
      '    // 金额口径的提醒只对 DeepSeek 生效；GLM 的配额百分比不能跟钱比大小\n' +
      "    if (state.provider !== 'deepseek') return\n" +
      '    if (!usageSet) return',
    why: '余额预警/今日预算是金额口径，GLM（配额百分比）下必须跳过，否则误报 DS 文案',
  },
  {
    // 渲染过滤（泡泡主渲染器）：随机语句模块按当前模型过滤行作用域。
    // _lastPick 从下标改为行对象引用（过滤后下标语义会漂移，对象引用稳定）。
    from: "function bubbleModuleText(m, avoidIdx) {\n" +
      "  var t = m.text || ''\n" +
      "  if (m.type === 'random' && Array.isArray(m.lines)) {\n" +
      "    var idx = bubblePickLine(m.lines, avoidIdx)\n" +
      "    var ln = m.lines[idx]\n" +
      "    if (ln) {\n" +
      "      m._lastPick = idx\n" +
      "      return ln.t\n" +
      "    }\n" +
      "    return ''\n" +
      "  }\n" +
      "  return t\n" +
      '}',
    to: "function bubbleModuleText(m, avoidIdx) {\n" +
      "  var t = m.text || ''\n" +
      "  if (m.type === 'random' && Array.isArray(m.lines)) {\n" +
      "    var pool = []\n" +
      "    for (var si = 0; si < m.lines.length; si++) {\n" +
      "      var ln0 = m.lines[si]\n" +
      "      if (!ln0) continue\n" +
      "      if (ln0.ds && state.provider !== 'deepseek') continue\n" +
      "      if (ln0.glm && state.provider !== 'glm') continue\n" +
      "      pool.push(ln0)\n" +
      "    }\n" +
      "    if (!pool.length) return ''\n" +
      "    var avoid = m._lastPickLine ? pool.indexOf(m._lastPickLine) : -1\n" +
      "    var pick = bubblePickLine(pool, avoid)\n" +
      "    var ln = pool[pick]\n" +
      "    if (ln) {\n" +
      "      m._lastPickLine = ln\n" +
      "      return ln.t\n" +
      "    }\n" +
      "    return ''\n" +
      "  }\n" +
      "  return t\n" +
      '}',
    why: '随机语句渲染按当前模型过滤行作用域（通用恒显，ds/glm 标记只在对应模型弹）',
  },
  {
    // 渲染过滤（提醒/预算/每轮消耗内容渲染器的同款 random 分支）
    from: "  if (mod.type === 'random' && Array.isArray(mod.lines)) {\n" +
      "    var pi = bubblePickLine(mod.lines, mod._lastPick)\n" +
      "    if (pi !== null && pi !== undefined && mod.lines[pi]) {\n" +
      "      mod._lastPick = pi\n" +
      "      return { txt: mod.lines[pi].t, line: mod.lines[pi] }\n" +
      "    }\n" +
      "    return { txt: '', line: null }\n" +
      '  }',
    to: "  if (mod.type === 'random' && Array.isArray(mod.lines)) {\n" +
      "    var rpool = []\n" +
      "    for (var ri = 0; ri < mod.lines.length; ri++) {\n" +
      "      var rln = mod.lines[ri]\n" +
      "      if (!rln) continue\n" +
      "      if (rln.ds && state.provider !== 'deepseek') continue\n" +
      "      if (rln.glm && state.provider !== 'glm') continue\n" +
      "      rpool.push(rln)\n" +
      "    }\n" +
      "    if (!rpool.length) return { txt: '', line: null }\n" +
      "    var ravoid = mod._lastPickLine ? rpool.indexOf(mod._lastPickLine) : -1\n" +
      "    var rpick = bubblePickLine(rpool, ravoid)\n" +
      "    var rpickLn = rpool[rpick]\n" +
      "    if (rpickLn) {\n" +
      "      mod._lastPickLine = rpickLn\n" +
      "      return { txt: rpickLn.t, line: rpickLn }\n" +
      "    }\n" +
      "    return { txt: '', line: null }\n" +
      '  }',
    why: '提醒内容渲染器的随机语句分支同样按当前模型过滤',
  },
]

// 必须「边应用边检查」：有些补丁的锚点是前一条补丁写进去的文本（例如改完响应处理
// 再往那段里插东西），拿未打补丁的原文去检查它们会误报失效。
// 同时把命中情况全部收集起来——上游一次改动常会让好几条补丁同时失效，
// 一次把清单报全，比逐条撞墙再重跑省事得多。
let patched = src
const applied = []
const misses = []
for (const p of PATCHES) {
  const want = p.count || 1
  const hits = patched.split(p.from).length - 1
  if (hits !== want) {
    misses.push({ hits: hits, want: want, from: p.from, why: p.why })
    continue
  }
  patched = patched.split(p.from).join(p.to)
  applied.push(p)
}
if (misses.length) {
  console.error('\n有 ' + misses.length + ' 条补丁没命中（上游可能改了这块代码）：')
  for (const m of misses) {
    console.error('  ✗ 命中 ' + m.hits + '/' + m.want + '  ' + JSON.stringify(m.from.slice(0, 90)))
    console.error('     原因：' + m.why)
  }
  throw new Error('补丁未全部命中，已中止（没有写出 lib/widget.js）')
}
for (const p of applied) {
  console.log('已应用补丁: ' + p.from.slice(0, 60).replace(/\n/g, '⏎') + (p.from.length > 60 ? '…' : ''))
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, patched, 'utf8')

// 用 --check 让 Node 自己确认产出是合法 JS，避免写坏前端还浑然不觉
const { execFileSync } = await import('node:child_process')
execFileSync(process.execPath, ['--check', OUT], { stdio: 'inherit' })

console.log('已写出 lib/widget.js')
console.log('  上游源码长度 : ' + src.length)
console.log('  产出长度     : ' + patched.length)
console.log('  补丁数       : ' + PATCHES.length)
console.log('  语法检查     : 通过')
