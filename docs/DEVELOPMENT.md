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
3. **设置落地**：菜单里挂件原有的控件由挂件自己处理并持久化；桌宠侧新增的那几项（模型 / 自动冒泡 / 开机自启 / API Key）通过 `__dsPetHost.*` 转给主进程落地，主进程再把真值推回来回显。气泡能被点到，靠的是 `overBubbleShape()` 里用 `elementFromPoint` 复用浏览器自己的命中测试——气泡开着时 SVG 形状是 `pointer-events:visiblePainted`，`elementFromPoint` 正好只返回画出来的部分。

### 菜单里有输入框，所以窗口要临时可聚焦

窗口默认 `focusable: false`，好处是点角色不会把你正在用的应用抢走焦点。但**那种窗口永远拿不到键盘焦点**——菜单最底部的 API Key 输入框就会完全打不进字（而且不报错，纯粹静默失效）。

所以 `adapter.js` 用 MutationObserver 盯着菜单的开合，菜单一开就通知主进程 `setFocusable(true)` **并 `win.focus()`**，菜单一关再切回 `false`。两点都别省：只改 focusable 不够，实测窗口仍然拿不到前台，必须显式 focus 一次。

另外输入框聚焦时会全选已有内容——否则用户直接打字会把新 Key 插进旧 Key 中间，拼出一个坏值（踩过）。

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

补丁**必须精确命中**，命中数不符直接报错——这是防止上游更新后补丁静默失效。目前 **25 处**（以脚本末尾打印的 `补丁数` 为准），分组如下：

| 补丁 | 条数 | 原因 |
|---|---|---|
| 菜单里的 `实时·令牌 (用法：去问dsh)` → `(需填平台令牌)` | 1 | 独立版没有 dsh，文案改指向 `config.json` |
| 末端追加 `window.__dshWhaleApi`（`showRandomLine` / `isBubbleShown` / `applyProvider`，`applyProvider` 里还负责把 GLM 下不可设的两行变灰） | 1 | 自动冒泡需要从外部触发随机台词；并按厂商调整菜单可用性 |
| `var CLICK_SQ = 9` → `100` | 1 | 3px 的点击 / 拖拽阈值太紧，真实鼠标的轻微抖动会让左键点击被当成拖拽而「没反应」 |
| `menuBox` 追加桌宠侧设置行（自动冒泡、开机自启、模型、API Key 折叠栏 + `__dshWhalePetSettings`） | 1 | 桌宠侧设置并入挂件自带菜单 |
| 多厂商：加 `applyProvider` 调用、`provider`/`providerLabel`/`usageLabel` 数据驱动、百分比显示、`render()` 同步标签 | 8 | 支持 DeepSeek ↔ GLM 切换，换贴图 / 换配色，气泡文案随厂商变 |
| 多厂商：时段台词按厂商分支（GLM 固定「空闲 / 高峰时段」并去掉用量行，`peakMode` 只作用于 DeepSeek） | 2 | 峰谷文案与「周配额已用」不该跨模型串到 GLM 上 |
| 多厂商：台词组标 `ds: true` + `pickRandomLines()` 按厂商过滤抽签池 | 6 | GLM 暂时没有自己的台词池：DeepSeek 的怪话与动图都不该在 GLM 下出现 |
| 台词组归属调整（「好女孩...↓」与「压力一只蓝色大肥鱼？！」对调） | 2 | 调整这两句各自的出现概率 |
| 菜单入口可见性与可点性：加白描边 + 投影、直连 hover、给菜单控件放行 click | 3 | 深色按钮压深色贴图上会隐形；按钮压在贴图不透明像素上时 click 会被角色区域的拦截吞掉 |

**抽取必须「求值」模板字符串，不能切片源码文本。** 源码里有转义（如 `.join('\\n')` 求值后是真换行），照抄会让 CSS 之间用字面 `\n` 分隔，浏览器错误恢复时把那个 `n` 粘到下一个选择器上，**除第一条外所有 CSS 失效**。脚本通过真正 import 该声明来求值。

改完 `widget.js` 相关的任何东西，**必须跑**：

```cmd
node tools/sync-upstream.mjs
node tools/check-wiring.mjs
```

## 随机台词池怎么调

点气泡（或自动冒泡）时，从挂件里的 `RANDOM_GROUPS` **按 `w` 权重抽一组**，组内再用 `pickOne` **等概率抽一句**。所以：

- 想改**某一类台词的总频率** → 调那一组的 `w`（总权重变了，各组占比会自动重新分配）
- 想改**组内某一句的概率** → `pickOne` 是等概率的，只能靠「把那句多写几遍」来加权，或者把它单独拆成一组、单独给 `w`
- 标了 `ds: true` 的组只在 DeepSeek 下参与抽签（GLM 下整组跳过，剩下的组会重新归一化）

改完重跑 `node tools/sync-upstream.mjs`。

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
3. **API Key 改成在菜单里填**。原先有一个独立的「首次运行引导窗口」，现在去掉了——Key 直接是菜单最底部的一行。

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
