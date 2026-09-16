# 上游 0.3.0 契约备忘（移植用）

这份是**上游 `MeteorNOX/DeepSeek-Balance-Whale-Widget` 0.3.0 的宿主契约**，供我们
在自己的 `server.js` 里实现那些 `/dsh-whale/*` 路由时对照。上游宿主侧的权威实现是
`_ref/index.js`（149 KB，构建脚本会随前端一起拉下来），前端是 `_ref/whale-widget.js`。

> 0.2.10 → 0.3.0 的变化：前端从 `lib/index.js` 的 `WIDGET_JS` 模板字符串**拆成了独立文件**
> `assets/whale-widget.js`；后端路由 12 → 21 条；新增自定义泡泡点击序列、逐行样式与字体、
> 悬浮快捷编辑、自定义角色/动图/音效、吸附与翻转可配、隐藏菜单按钮、峰谷倒计时等。

## 通用约定

- 所有 JSON 响应：`Content-Type: application/json; charset=utf-8` + `Access-Control-Allow-Origin: *` + `Cache-Control: no-store`
- 二进制响应：`Cache-Control: no-store` + 显式 `Content-Length`
- **失败也用 HTTP 200 返回 `{ok:false,...}`**（余额那类业务失败；资源类才用 404）
- 前端防御很扎实：**21 条路由没有任何一条 404 会让它崩**，全都是安静降级。
  唯二「看起来坏掉」的是 `image.png` 破图、以及 `roles.json` 挂掉 + localStorage 记住了
  已删角色时 `role-image.png` 永久破图（没有回退路径）。

## 路由清单（✅ = 我们 server.js 已实现，2026-09-16 阶段三全部补齐）

### 二进制 / 静态资源

| 路由 | 响应 | 数据源 |
|---|---|---|
| ✅ `GET image.png` | `image/png` | `assets/DSniang1.png`（我们按厂商出图） |
| ✅ `GET rua.gif` | `image/gif` | `assets/rua.gif` |
| ✅ `GET role-image.png?id=` | `image/gif` 或 `image/png` | 自定义角色图；id 为 `default` 时前端不走这条（走 `image.png`） |
| ✅ `GET bubble-img.png?id=` | `image/gif` 或 `image/png` | 先查用户图库，再查内置（`bimg_petpet`/`bimg_money1`） |
| ✅ `GET audio-fragment.wav?id=` | MIME **按片段类型动态给**（预设 mp3 段是 `audio/mpeg`，其余 `audio/wav`） | 内置片段 → 预设片段 → 用户上传片段 |
| ✅ `GET sound/press.mp3?set=` / `sound/release.mp3?set=` | 组槽位为空串 → **204 无 body**（静音）；否则片段字节 | 预设组 `duck`(Ya1/Ya2) / `fx1`(D1/D2)，或自定义组 |
| ✅ `GET widget.js` | `application/javascript` | 我们构建出的 `lib/widget.js` |

### JSON

| 路由 | 方法 | 响应要点 |
|---|---|---|
| ✅ `size.json` | GET/PUT/POST | `{scale,sound,vol,soundSet,usageMode,peakMode,bubbleOn,turnCostOn,turnCostCloseMs,scrollGapOn,scrollGapPx,menuBtnHide}`；PUT 缺 `scale` → 400。**`menuBtnHide` 已支持**（另有我们自己的 `autoPopMs`/`provider` 扩展字段） |
| ✅ `balance.json` | GET | 成功 `{ok,totalBalance,currency,updatedAt,isPeak,todayUsage,usageMode}`；失败 `{ok:false,code,error,transient?}`。我们额外带 `provider/providerLabel/usageLabel`（补丁消费） |
| ✅ `last-turn.json` | GET | `{ok,seq,turn,amount,tokens,ts}`；空态 seq:0 + 全 null |
| ✅ `bubble.json` | GET/PUT/POST | `{ok,config:{v:1,items:[],lib:[],tapAdvance} \| null}`。PUT 必须同时含 `items[]`/`lib[]`，否则 400。**我们按厂商分档存取（`.dshw-bubble-<provider>.json`），GET 无存档时按厂商生成默认配置而非 null** |
| ✅ `bubble-imgs.json` | GET | `{ok,images:[{id,name,format,url,createdAt,builtin?}]}`，内置两条常驻前置 |
| ✅ `bubble-img-upload.json` | POST | `{action:'upload'\|'delete', ...}`；body 上限 10MB；图 64B–8MB |
| ✅ `roles.json` | GET/POST/PUT | GET `{ok,roles:[{id,name,url,pinned,pinnedAt,createdAt,format}]}`；POST 导入角色（`{name,image:'data:image/...'}`，body 上限 30MB）。**首次运行 seed 预置：default（名「大肥鱼」）+ glm（「GLM娘」，图拷自 personas/glm）** |
| ✅ `role-pin.json` | POST | `{id,pinned}` → `{ok,roles:[...]}`；`default` 不可删 |
| ✅ `role-delete.json` | POST | `{id}` → `{ok,roles:[...]}`；`id==='default'` → 400 |
| ✅ `audio.json` | GET/POST/PUT | GET `{ok,groups:[...],fragments:[...]}`；POST 按 `action` 分派：`upload-fragment`/`save-group`/`delete-group`/`delete-fragment`/`pin-group` |
| ✅ `usage-settings.json` | GET/PUT/POST | `{ok,settings:{taskEnd,alert,budget,turnCost,models}}`（存账本 `settings` 字段） |
| ✅ `usage-records.json` | GET | `{ok,today,days7,total7,all:{days,events},settings}`；events 由我们的 `report-turn` 挂入（模型明细） |
| ✅ `api-models.json` | GET/POST | GET `{ok,builtinId,templates:[...],models:[...]}`；POST 按 `action`：`save`/`delete`/`probe`/`set-key`/`delete-key`/`model-settings`。**裁剪：模板表去掉 codex（独立版无 DSH 会话流）；密钥存注册表 `keys` 段（上游走 DSH 凭据系统）；`probe`/`save`/`model-settings` 全可用** |

## 三块机制的数据模型（迁移时要用）

### 角色系统

- 索引 `roles.json`：`{version:1, roles:[{id,name,pinnedAt,createdAt,format}]}`；每次都保证 `default` 存在
- **默认角色是保留 id `default`**，图片不在角色目录里，而是复用 `image.png`
- `format`：`png`/`gif`/`apng`；APNG 走 png 容器，**必须由客户端显式传 `format:'apng'`**
- **pin = 置顶（不是选中）**：`pinnedAt` 是时间戳，排序 = 有 pinnedAt 的优先（值大者在前）→ 再按 createdAt 降序
- **「当前选中的角色」不在服务端**，存在前端 `localStorage['dshw-role']`

### 泡泡点击序列（`bubble.json`）

- 存档 `{v:1, tapAdvance:boolean, items:[...], lib:[...]}`；`tapAdvance` = 点角色是「推进下一泡」还是「回到第 1 泡」
- 步骤两种形态：
  - 单选：`{kind:'custom', modules:[...]}` / `{kind:'random'}` / `{kind:'normal'}`
  - **并列泡**：`{kind:'choice', options:[{w, item}]}` —— 前端**只取前 2 个** option，A/B 二选一，权重 `w` 缺省按 1
- 模块 `type`：`text` / `link` / `balance`（`tpl:'{balance_ds}'`）/ `today`（`tpl:'今日已用 {expense_ds}'`）/ `quota` / `plan` / **`peak`**（`peakStyle:'mini'|'count'`、`tpl:'{status}'|'{countdown}'`）/ `image`（`imgId`）/ `randimg`（`imgs:[{imgId,w}]`）/ **`random`**（`lines:[{t,w}]`，按权重抽且不连续重复）
- 权重规则：`total = Σ max(1,w)`，避免连续重复最多重抽 6 次

### 音频

- 索引 `whale-audio/audio.json`：`{version:1, groups:[{id,name,press,release,pinnedAt,createdAt}], fragments:[{id,name,createdAt}]}`
- `press`/`release` 是**片段 id**；**空串 `''` = 显式静音（返回 204）**，与 `null`/缺失（回退预设）语义不同
- 预设组 `duck`/`fx1` 与预设片段 `ya1/ya2/d1/d2`（mp3）、`exp_orb`/`end_a`（wav）不可删
- `audio-fragment.wav` 的路径后缀是历史遗留，**字节可能是 mp3**，MIME 必须按片段类型给

## 实现优先级（缺了会怎样）

1. **不实现就崩 / 等于没有**：`widget.js`、`image.png`、`size.json`(含 PUT)、`bubble-imgs.json` + `bubble-img.png`（默认泡泡第二泡就是图片模块）
2. **不实现则某功能不可用（安静降级）**：`balance.json`、`sound/*.mp3`、`bubble.json`、`roles.json` + `role-image.png`、`audio.json`、`audio-fragment.wav`、`usage-*`、`api-models.json`、`rua.gif`、`last-turn.json`
3. **只在用户主动操作时触发（纯管理向）**：各 POST（角色导入/置顶/删除、音频上传/组管理、泡泡图上传、泡泡配置保存）

## 前端对宿主的两个硬前提（独立版必须处理）

1. **页面自检**（`whale-widget.js` 开头）：要求 `#root` 内存在 `textarea` 或
   `[contenteditable="true"]`，5 秒找不到就 `return`、一行都不执行。
   → 我们用补丁把 `dshwIsChatRoot()` 改成恒真（我们只在自家页面注入这个脚本）。
2. **素材必须在**：`DSniang1.png`、`rua.gif`、`Ya1/Ya2/D1/D2.mp3`、
   `minecraft-exp-orb.wav`、`task-end-a.wav`、`bubble-petpet.gif`、`bubble-money1.gif`。

## 我们这边已经跟上的类名变化

- 气泡容器：`.dshwv-bubble` → **`.dshwv-pop`**（内部 `.dshwv-text` 承载三行文字、`.dshwv-gif` 承载动图）；`pet/adapter.js` 已改
- 三行文字仍是 `.dshwv-label` / `.dshwv-amount` / `.dshwv-hint`（`.dshwv-period` 由样式映射动态加）
- 菜单仍是 `.dshwv-menu` / `.dshwv-menu-row` / `.dshwv-menu-btn`
- 新增 103 个类名（泡泡编辑器、音频编辑器、角色列表、吸附配置、用量面板、裁剪窗口…）
- 泡泡序列的模块行是 **`.dshwv-trow`**（与老三行 label/amount/hint **并存**——老机制
  （`kind:'random'` 步骤 + `showRandomLine`）用老三行，配置化模块用 trow）

## 我们的定制：泡泡配置按厂商分档（bubble.json）

- 存档 `data/.dshw-bubble-{deepseek,glm}.json`，GET 按当前 `size.json` 的 provider 取档；
  **无存档时按厂商生成默认配置返回（不返回 null）**——前端拿到 null 会用出厂默认
  （`BUBBLE_DEFAULT_ITEMS`，全是 DeepSeek 鲸鱼娘的怪话池），GLM 模式下不该出现。
- DeepSeek 默认 = 上游出厂快照（余额泡 + 48 句怪话/petpet A/B 泡），
  由 `tools/_extract-default-bubble.mjs` 提取后内嵌 server.js（上游改出厂默认时重跑提取）。
- GLM 默认 = 余额泡（GLM余额 / 5h 窗剩余% / `周配额已用 {expense_ds}` / peak `{status}`）
  + petpet 图泡。**peak 不用 `count` 倒计时样式**：倒计时的前端本地推算写死了
  DeepSeek 时段表（工作日 9–12/14–18），对 GLM（14–18）会把切换点算错。
- 切厂商时补丁调 `loadBubbleCfg()` 重拉（启动时的首次拉取与 size.json 回显存在竞态，这里统一纠正）。
- 两套随机台词机制并存：配置里 `type:'random'` 模块（lines 配置驱动）是新的；
  `kind:'random'` 步骤 + `__dshWhaleApi.showRandomLine()` 仍走老 `RANDOM_GROUPS`
  （0.3.0 里它只剩怪话+gif，没有时段组）。**GLM 的自动冒泡在补丁里改为弹时段状态**，
  不走 `pickRandomLines()`（过滤后池空、兜底会退回怪话）。

## 我们的定制：角色系统预置

- 首次运行（roles.json 索引不存在）seed：`default`（名**「大肥鱼」**，复用 `image.png`
  动态按厂商出图 = 用户拍板的「默认方案」）+ `glm`（**「GLM娘」**，图拷贝自
  `assets/personas/glm/character.png`，想锁定 GLM 形象时手动选它）。删除预置角色后
  不会复活（seed 只在索引不存在时执行）。
- 补丁尊重角色锁定：`applyProvider` 里若 `localStorage['dshw-role']` 是非 default
  角色，跳过贴图替换（只换配色/泡泡配置），不覆盖用户锁定。
