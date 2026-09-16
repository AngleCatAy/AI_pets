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

## 路由清单

### 二进制 / 静态资源

| 路由 | 响应 | 数据源 |
|---|---|---|
| `GET image.png` | `image/png` | `assets/DSniang1.png`（我们按厂商出图） |
| `GET rua.gif` | `image/gif` | `assets/rua.gif` |
| `GET role-image.png?id=` | `image/gif` 或 `image/png` | 自定义角色图；id 为 `default` 时前端不走这条（走 `image.png`） |
| `GET bubble-img.png?id=` | `image/gif` 或 `image/png` | 先查用户图库，再查内置（`bimg_petpet`/`bimg_money1`） |
| `GET audio-fragment.wav?id=` | MIME **按片段类型动态给**（预设 mp3 段是 `audio/mpeg`，其余 `audio/wav`） | 内置片段 → 预设片段 → 用户上传片段 |
| `GET sound/press.mp3?set=` / `sound/release.mp3?set=` | 组槽位为空串 → **204 无 body**（静音）；否则片段字节 | 预设组 `duck`(Ya1/Ya2) / `fx1`(D1/D2)，或自定义组 |
| `GET widget.js` | `application/javascript` | 我们构建出的 `lib/widget.js` |

### JSON

| 路由 | 方法 | 响应要点 |
|---|---|---|
| `size.json` | GET/PUT/POST | `{scale,sound,vol,soundSet,usageMode,peakMode,bubbleOn,turnCostOn,turnCostCloseMs,scrollGapOn,scrollGapPx,menuBtnHide}`；PUT 缺 `scale` → 400。**0.3.0 新增 `menuBtnHide`** |
| `balance.json` | GET | 成功 `{ok,totalBalance,currency,updatedAt,isPeak,todayUsage,usageMode}`；失败 `{ok:false,code,error,transient?}`。**0.3.0 不再有 `providerLabel`/`usageLabel` 概念**（我们自己的补丁又加回来了） |
| `last-turn.json` | GET | `{ok,seq,turn,amount,tokens,ts}`；空态 seq:0 + 全 null |
| `bubble.json` | GET/PUT/POST | `{ok,config:{v:1,items:[],lib:[],tapAdvance} \| null}`。PUT 必须同时含 `items[]`/`lib[]`，否则 400；只持久化这 4 个键。**`config:null` 是合法的「未配置」** |
| `bubble-imgs.json` | GET | `{ok,images:[{id,name,format,url,createdAt,builtin?}]}`，内置两条常驻前置 ✅ 已实现 |
| `bubble-img-upload.json` | POST | `{action:'upload'\|'delete', ...}`；body 上限 10MB；图 64B–8MB |
| `roles.json` | GET/POST/PUT | GET `{ok,roles:[{id,name,url,pinned,pinnedAt,createdAt,format}]}`；POST 导入角色（`{name,image:'data:image/...'}`，body 上限 30MB） |
| `role-pin.json` | POST | `{id,pinned}` → `{ok,roles:[...]}`；`default` 不可删 |
| `role-delete.json` | POST | `{id}` → `{ok,roles:[...]}`；`id==='default'` → 400 |
| `audio.json` | GET/POST/PUT | GET `{ok,groups:[...],fragments:[...]}`；POST 按 `action` 分派：`upload-fragment`/`save-group`/`delete-group`/`delete-fragment`/`pin-group` |
| `usage-settings.json` | GET/PUT/POST | `{ok,settings:{taskEnd,alert,budget,turnCost,models}}` |
| `usage-records.json` | GET | `{ok,today,days7,total7,all:{days,events},settings}` |
| `api-models.json` | GET/POST | GET `{ok,builtinId,templates:[...],models:[...]}`；POST 按 `action`：`save`/`delete`/`probe`/`set-key`/`delete-key`/`model-settings` |

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
