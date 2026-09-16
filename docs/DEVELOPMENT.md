# 开发笔记

面向要改这个项目的人。用户向的说明见 [README](../README.md)。

## 目录结构

```text
ds_pet/
├── start.cmd / start-pet.cmd  # 双击启动：浏览器标签页 / 桌面桌宠
├── server.js                  # 本地服务：余额、配额、记账、定价、路由；也可被主进程内嵌
├── index.html                 # 标签页模式的页面
├── pet.html                   # 桌宠模式的页面（透明背景）
├── lib/
│   └── widget.js              # 挂件前端本体（生成物！见下）
├── pet/
│   ├── main.cjs               # Electron 主进程：内置服务、透明置顶窗口、托盘、IPC
│   ├── preload.cjs            # 桌宠窗口的受限 IPC 桥
│   └── adapter.js             # 页内适配器：点击穿透、设置转发、点击诊断
├── assets/                    # 鲸鱼图、gif、音效（来自上游，MIT）
│   └── personas/glm/          # GLM 模式的贴图（按厂商出图）
├── tools/
│   ├── start.ps1              # 启动器逻辑（环境检查、拉起服务、打开界面）
│   ├── sync-upstream.mjs      # 从上游同步 widget.js（补丁表在这里）
│   ├── check-wiring.mjs       # 检查页面 / 桥 / IPC 的接线是否一致
│   ├── probe-glm.mjs          # 用真 key 复核 GLM 配额接口结构
│   └── package.mjs            # 打包免安装版
├── docs/DEVELOPMENT.md        # 本文件
├── dist/                      # 打包产物（.gitignore 排除）
├── data/                      # 开发态运行时数据（.gitignore 排除）
├── config.json                # 你的配置（.gitignore 排除，含 Key）
└── _ref/index.js              # 上游源码缓存，供同步脚本比对（.gitignore 排除）
```

## 实现方式

窗口不是「包住角色的小窗」，而是**覆盖整个工作区、透明、置顶、默认整窗穿透点击**的一个窗口，角色只是画在其中右下角的挂件。

这么做是因为挂件前端**本来就是**为「覆盖在界面之上但不挡操作」设计的——它内置了贴图 PNG 的 alpha 命中测试和透明区穿透意图。桌面于是变成了它的「视口」，拖拽、四边吸附、点击刷新、按压音效、Q 弹反馈**全部保持原版行为，零改动**。

`pet/adapter.js` 只补挂件本身不该管的事：

1. **点击穿透**：鼠标移动时做像素级 alpha 判定，不在角色上就调 `setIgnoreMouseEvents(true, {forward:true})` 让事件穿到桌面。按住鼠标期间强制保持可交互——否则快速拖拽时角色有 transition 动画会落在光标后面，按像素判定会中途「丢失」命中，导致 `pointerup` 收不到、角色卡住。
2. **菜单入口**：只有一条路——左键点角色头旁的蓝色按钮。右键刻意不绑定任何动作（`adapter.js` 里不注册 `contextmenu`，也不 `preventDefault`），托盘里也没有「打开设置菜单」的捷径。`tools/check-wiring.mjs` 会检查这两点，防止以后被顺手加回去。
3. **设置落地**：菜单里挂件原有的控件由挂件自己处理并持久化；桌宠侧新增的那几项（模型与凭据合并成的「模型配置」栏 / 自动冒泡 / 开机自启）通过 `__dsPetHost.*` 转给主进程落地，主进程再把真值推回来回显。气泡能被点到，靠的是 `overBubbleShape()` 里用 `elementFromPoint` 复用浏览器自己的命中测试——气泡开着时 SVG 形状是 `pointer-events:visiblePainted`，`elementFromPoint` 正好只返回画出来的部分。

### 窗口默认不抢焦点，只在「需要激活的控件」被点/悬停时才临时可聚焦

窗口默认 `focusable: false`，好处是点角色不会把你正在用的应用抢走焦点。但那种窗口
（Windows 上是 `WS_EX_NOACTIVATE`）**拿不到键盘焦点**，key 输入框会完全打不进字；
更隐蔽的是**原生弹层也弹不出来**——`<select>` 下拉、文件选择框都会「点不动」。

所以 `adapter.js` 的判据是 `needsActivation(el)`，分两类：

| 类别 | 例子 | 为什么要激活 |
|---|---|---|
| 需要键盘 | `input`（非 checkbox/radio/range/button/file）、`textarea`、`contenteditable` | 不然打不进字 |
| 需要系统原生弹层 | `select`、`input[type=file]` | 不然下拉 / 文件框弹不出来 |

做法：
- **点**到这类控件 → `setFocusable(true)`；文本类还会隔 60/200/450ms 补 `focus()`+`select()`
  （窗口激活与点击的默认聚焦有时序竞争）。
- **悬停**到 `select` / `file` 上就提前激活——原生下拉是鼠标**抬起**时才弹的，
  只在 pointerdown 里切可能来不及。`setFocusable` 幂等，扫过几个下拉只会触发一次。
- 点到**其它**控件 → 立刻 `setFocusable(false)` 交还焦点。**别依赖 `focusout`**：
  实测桌面窗口里 `blur()` 不一定触发它，靠它释放会漏。

> 早先的规则是「菜单/弹层一打开就切可聚焦」，实测的后果是：点一下桌宠，别的窗口就
> 像卡住了（Windows 会把前台窗口换掉，而且**不会自动还回去**），而菜单里大多数操作
> 根本不打字。所以改成按需激活。**代价**：只要往挂件里加新的原生控件（下拉、文件框…），
> 必须记得加进 `needsActivation`，否则就是静默的「点不动」。

另外输入框聚焦时会全选已有内容——否则用户直接打字会把新 Key 插进旧 Key 中间，拼出一个坏值（踩过）。

### 凭据是怎么存的（按模式分开）

| 模式 | 存在哪 | 形式 |
|---|---|---|
| DeepSeek | `config.json` 的 `apiKey` | API Key，发请求时加 `Bearer` |
| GLM | `config.json` 的 `providers.glm.planToken` | Coding Plan 令牌，**裸 token，不加 `Bearer`** |
| 纯桌宠模式 | 不存 | 不需要任何凭据（菜单里那一行会隐藏） |

菜单「**模型配置**」栏里那一行填的是「**当前模式的**凭据」：`adapter.js` 把值交给主进程，
主进程用 `currentProvider()`（读服务端配置，这是权威来源）决定写哪个字段，再把该字段的值
推回页面回显，占位符也跟着模式换（`sk-...` ↔ `粘贴令牌`）。

两个凭据分开存、互不覆盖——**别把它们并成一个字段**，否则切到 GLM 会看到 DeepSeek 的 Key，
填进去还会把 DeepSeek 的 Key 覆盖掉。

## `lib/widget.js` 是生成物，不要手改

它由 `tools/sync-upstream.mjs` 从上游 `lib/index.js` 里的 `WIDGET_JS` 模板字符串抽取 + 打补丁生成：

```cmd
node tools/sync-upstream.mjs           # 用本地缓存的上游副本
node tools/sync-upstream.mjs --fetch   # 先重新下载上游再抽取
```

改前端要**在补丁表里加条目**：

```js
{ from: '唯一匹配的原文', to: '替换后', why: '为什么改（必填）' }
// 需要改多处时加 count: 2
```

补丁**必须精确命中**，命中数不符直接报错——这是防止上游更新后补丁静默失效。目前 **38 处**（以脚本末尾打印的 `补丁数` 为准），分组如下：

| 补丁主题 | 条数 | 原因 |
|---|---|---|
| 独立版接入 | 2 | 上游 0.3.0 的「只在 DSH 主聊天界面挂载」自检会让挂件在桌宠窗口里完全不执行；`CLICK_SQ` 9 → 100（3px 点击/拖拽阈值太紧，轻微抖动会让左键点击被当成拖拽而「没反应」） |
| 桌宠侧菜单 | 5 | 「模型配置」合并栏（模型切换 + key 输入一体，置于菜单首行，替代原分离的两栏）；桌宠侧设置并入菜单底部（自动冒泡 / 开机自启 + 设置回显）；入口可见性与可点性（白描边+投影、直连 hover、给菜单控件放行 click——按钮压在贴图不透明像素上时 click 会被角色区域的拦截吞掉） |
| 多厂商：数据与文案 | 9 | 厂商是「设置」不是数据副产品：从 `size.json` 读取并应用，不再依赖余额响应里有没有 `provider`；气泡首行标签与用量前缀改为数据驱动；按响应换贴图 / 换配色；GLM 配额以百分比直接显示；标签在 `render()` 里同步（切换后不再滞留旧名） |
| 峰谷与额度预警 | 4 | 峰谷倒计时按模型算（GLM 高峰只有工作日 14–18，DeepSeek 是 9–12 与 14–18）；余额预警/今日预算是**金额口径**，GLM（配额百分比）下必须跳过；GLM 自己的配额预警（5 小时窗 / 周窗剩余低于阈值） |
| 角色按模型保存 | 3 | 切角色上报服务端落到当前模型槽位；导入角色默认用文件名；默认角色缩略图随当前模型重拉（面板 DOM 复用、URL 不变时浏览器不会重拉） |
| 泡泡配置与随机语句池 | 6 | 编辑器「重置」改为恢复**当前模型**的默认序列（DELETE 存档），不再灌上游 DeepSeek 出厂默认；随机语句池按模型两档（通用 + 本模型专属）；行级 `ds`/`glm`/`pet` 标记由渲染期按当前模型过滤（两处渲染器） |
| 自动冒泡入口 | 1 | 末端追加 `window.__dshWhaleApi`（`showRandomLine` / `isBubbleShown` / `applyProvider`）——原版这条路径只能由点击气泡触发，而随机台词相关状态都在同一个闭包里 |
| 旧抽签池的按厂商过滤 | 8 | `RANDOM_GROUPS` 里给组标 `ds: true` 并在 `pickRandomLines()` 里过滤。**注意**：自动冒泡已不走它，现在只有「旧配置里 `kind:'random'` 步骤」这条遗留路径还会用到 |

> **一个已经消失的大坑（留个记录）**：上游 0.2.x 把前端放在 `lib/index.js` 的 `WIDGET_JS`
> 模板字符串里，那时**必须「求值」而不能切片源码文本**——源码里的 `.join('\\n')` 求值后是
> 真换行，照抄会让 CSS 规则之间用字面 `\n` 分隔，浏览器错误恢复时把那个 `n` 粘到下一个
> 选择器上，**除第一条外所有 CSS 失效**。
> 上游 0.3.0 把前端拆成了独立文件 `assets/whale-widget.js`，直接读文件即可，这个问题
> 自然消失。**别退回去切片 `lib/index.js`**：那个文件现在只作宿主侧参考（缓存在 `_ref/`）。

改完 `widget.js` 相关的任何东西，**必须跑**：

```cmd
node tools/sync-upstream.mjs
node tools/check-wiring.mjs
```

## 随机台词池怎么调

上游 0.3.0 起，**点击泡泡的内容由「泡泡点击序列」配置决定**，不再是写死的抽签池：

- 序列按模式各存一份（`.dshw-bubble-<模式>.json`）；没有存档时服务端下发该模式的默认序列。
- 随机台词是序列里的 `type: 'random'` 模块：`lines: [{ t, w, ... }]`，**按 `w` 权重抽一行**，
  并避免与上一行连续重复。每行还能带字号 / 加粗 / 配色（`size` / `bold` / `rgb` / `color`）。
- 行上的 **`ds` / `glm` / `pet` 标记**决定该句只在对应模式弹出；没有标记的通用句两边都弹。
  过滤发生在**渲染期**（`bubbleModuleText` 与提醒内容渲染器两处），所以把两档池混装进同一个
  模块也不会串味。

**句子与归属的唯一权威**是 `tools/sync-upstream.mjs` 里的三个常量：

| 常量 | 内容 |
|---|---|
| `DSHWV_LINES` | 48 句（通用 33 + DeepSeek 专属 15，专属句带 `ds: true`） |
| `DSHWV_GLM_LINES` | GLM 专属 3 句（带 `glm: true`） |
| `DSHWV_PET_LINES` | 纯桌宠模式专属 3 句（带 `pet: true`） |

`dshwvRandomPool(kind)` 负责组装：`ds` = 通用 + DS 专属，`glm` = 通用 + GLM 专属，
`pet` = 通用 + pet 专属。调色板上的三个「随机语句」按钮就是用它预填的。

改完这些常量要重跑 `node tools/sync-upstream.mjs`（服务端 `server.js` 内嵌的 DeepSeek 默认池
用的是同一份分类，见那里的 `BUBBLE_ALL_LINES`）。

**自动冒泡**（`showRandomLine`）用的是同一个池函数，按当前模式取 `ds` / `glm` / `pet`；
鲸鱼动图（`rua.gif`）只在 DeepSeek 模式下出，概率沿用老抽签池的 `10/28`。

> `RANDOM_GROUPS` 这套旧抽签池现在只服务「旧配置里 `kind:'random'` 步骤」这条遗留路径，
> 别以为它还是冒泡池。

以 DeepSeek 为例（总权重 73，怪话合计 24.66%、动图 13.70%、时段 61.64%）：

| 组 | 权重 | 句子 | 组内每句 |
|---|---|---|---|
| 时段组 | 45 | 当前时间段为: / 空闲｜高峰时段 / 今日已用 ¥x | — |
| 怪话 B 组 | 7 | `好模型... ↓`、`压力一只蓝色大肥鱼？！` | 各 4.79% |
| 怪话 A 组（6 句） | 7 | `不知道用户有什么用，先赶走吧~`、`我...我...我也要挣钱吗？`、`我去吃饭啦，测完叫我`、`好女孩...↓`、`DeepSleep...`、`坏了...用户彻底怒了！` | 各 1.60% |
| 动图 | 10 | `rua.gif`（只显示动图，文字行隐藏） | — |
| 怪话 A 组（3 句） | 3 | `你目录里的dsh是什么...大烧货吗...?`、`恭喜你实现token自由！token全跑了！`、`真当我是便宜货啊...` | 各 1.37% |
| 怪话 B 组（1 句） | 1 | `哦鲸鲸... ` | 1.37% |

定向验证：把 `Math.random` 钉成某个值就能命中某一组（`r*73` 落在哪段就是哪一组：0.3→时段、0.62→怪话 B、0.85→动图、0.99→哦鲸鲸）。注意探针会覆盖页面的 `Math.random`，同一个页面测完要 `reload()` 才能恢复真随机。

## 和原版的功能对照

| 功能 | 状态 |
|---|---|
| 余额展示、60 秒自动刷新、点击手动刷新、数字滚动动画、网络抖动沿用上次余额 | ✅ 一致 |
| 今日已用（记账，余额差值本地记账、跨天归档） | ✅ 一致 |
| 今日已用（实时·令牌，平台用量接口 + 峰谷定价换算） | ✅ 一致 |
| 峰谷定价（工作日 9–12 / 14–18 高峰，2026-08-23 起周末全天谷价） | ✅ 一致 |
| 拖拽、四边四分之一吸附、左吸附镜像翻转、按压 Q 弹 | ✅ 一致 |
| 音效、随机台词、gif | ✅ 一致（GLM 下没有台词池与动图） |
| 设置项（大小 / 音效 / 音量 / 用量 / 峰谷文案 / 气泡 / 自动关闭 / 避让滚动条） | ✅ 一致 |
| 自动冒泡、开机自启 | ➕ 桌宠侧新增，并进挂件自带菜单 |
| 位置记忆 | ✅ 一致（存在 localStorage） |
| **每轮对话消耗统计** | ⚠️ 需额外接一层本地反向代理，见下 |

### 每轮对话消耗（未完成）

这一项在原版里是从 DSH 的会话事件流里读精确 usage 的，脱离 DSH 后没有等价数据源。

服务端已经把接口和结算逻辑准备好了（`POST /dsh-whale/report-turn`，带 `turn` / `model` / `inputTokens` / `cacheReadTokens` / `outputTokens` / `reasoningTokens`），缺的只是一层本地反向代理：把客户端的 `base_url` 指向本地代理，代理转发到 `api.deepseek.com`，从每个响应里读出 `usage` 后调用上面这个接口。

在代理接上之前，该功能会安静地不显示，不影响其它功能。

## 打包

```cmd
:: 国内网络必须挂镜像：packager 要取 Electron 的校验文件（SHASUMS256.txt），
:: 不挂就会去连 github.com 然后超时 / ECONNRESET，直接打包失败
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run package
```

产出 `dist/DeepSeekPet-win32-x64/`，整个文件夹压缩后发给对方即可——**对方不需要装 Node，也不需要装 Electron**，解压双击 `DeepSeekPet.exe` 就跑。压缩后约 150MB（体积基本全是 Electron 运行时，我们的代码不到 1MB）。包内会自动生成一份 `使用说明.txt`。

### 为打包做的三处调整

1. **服务内置进主进程**。原来桌宠是两个进程：启动器先起 `node server.js`，再起 Electron，这依赖系统里的 Node。现在主进程直接 `import('../server.js')` 把服务跑在自己进程里，所以对方零依赖。`server.js` 因此改成了可嵌入形式（导出 `configure()` / `startServer()`），只有在被直接 `node server.js` 运行时才自己监听端口。顺带修了一个隐患：嵌入时端口冲突不能再 `process.exit`——那会把整个桌宠干掉，现在改成返回错误交给主进程决定。
2. **配置和运行数据改到用户目录**。打包后安装目录可能只读、升级还会被覆盖，所以配置、尺寸记忆、记账账本、日志都放 `app.getPath('userData')`；开发态仍然放在项目里，方便查看和手改。
3. **API Key 改成在菜单里填**。原先有一个独立的「首次运行引导窗口」，现在去掉了——Key 直接是「模型配置」栏里的一行。

### 打包脚本里几道防呆

- `config.json` **硬性排除**（里面有使用者自己的 API Key），还会额外提示一次
- `REQUIRED` 白名单：必需文件缺失就中止打包。`assets/personas/glm/character.png` 在里面——漏了它 GLM 模式会**静默**回落到鲸鱼（不报错、只是人物不对）
- `IGNORE` 排除 `HANDOFF.md`、`draw_glm.py`（内部笔记和作图脚本，不参与运行）、根目录杂散图片、`start*.cmd`、`tools/`、`_ref/`、`data/`

### 两个踩过的坑

- **EBUSY 覆盖失败**：`dist/DeepSeekPet-win32-x64` 刚被写出来就删，会报 `EBUSY: resource busy or locked, rmdir`（杀软在扫那个 368MB 目录，不是句柄占用）。解法是改名再删：`mv DeepSeekPet-win32-x64 _old_build` → `rm -rf _old_build` → 重新打包。
- **为什么用 @electron/packager 而不是 electron-builder**：electron-builder 出安装包还要另外下载 NSIS / winCodeSign 之类的二进制，国内网络容易卡住。packager 直接用已经装好的 Electron，不额外下载任何东西。产物是个文件夹而不是单文件安装程序，但压缩后发给朋友用起来没差别。

## 排查

```cmd
:: 启动、窗口尺寸、厂商切换、菜单开合、可聚焦切换、每次点击的坐标与命中元素、自动冒泡
type data\pet.log

:: 想看穿透判定的实时明细（光标位置 + 是否命中）
set DS_PET_DEBUG=1
start-pet.cmd
```

日志里有用的几行：

- `菜单按钮位置 4,1173 尺寸 26x26（窗口坐标）` —— 启动时记一次菜单入口坐标
- `菜单已开：菜单框 …；API Key 输入框 …` —— 菜单打开时才准的坐标（关着时它的 rect 是未定位的静态值）
- `窗口可聚焦 -> 开/关 … isFocusable=` —— 输入框打不进字时先看这行
- `左键点击角色：位移 Npx 命中=…` —— 挂件把位移超过阈值的按下 / 抬起当**拖拽**，那样不弹气泡，看起来像「点了没反应」。阈值原本只有 3px，已放宽到 10px

桌面透明窗口**没法用截图可靠验证**（气泡 5 秒、菜单焦点、远程桌面等因素干扰）。有效办法是**在浏览器里做确定性验证**：同一份 `widget.js` 在标签页里跑，可以用 Playwright 真实鼠标事件验证交互、用 `evaluate` 读计算后的样式和文本，零延迟、可断言。注意自己 `dispatchEvent(new PointerEvent(...))` **不会生成 click**，测按钮类交互必须用真实点击。

日志里如果看到「启动静默失败」（进程在跑、服务在听、就是没窗口），查 `whenReady()` 链有没有漏 `.catch()`——那种 ReferenceError 会被吞掉。

## 启动脚本的写法约束

两个 `.cmd` 都**只做纯 ASCII 转发**，全部逻辑和中文提示放在 `tools/start.ps1` 里。这不是绕远路，而是必须的：

- `.cmd` **只能纯 ASCII** + **必须 CRLF**。`cmd.exe` 不会因为文件里执行了 `chcp 65001` 就按 UTF-8 重读自身，中文会泄漏成非法命令；LF 会让 `for /f` 之类的语句解析错误。
- 反过来，`tools/start.ps1` **必须保存为 UTF-8 with BOM**，否则 Windows PowerShell 5.1 会按 ANSI 解码，中文变乱码并可能直接解析失败。

`.gitattributes` 已经把这两个类型的换行钉成 CRLF，所以不管谁的 `core.autocrlf` 设成什么，checkout 出来都是对的。注意 git 里**最后匹配的规则生效**，所以通配规则必须写在具体规则前面。
