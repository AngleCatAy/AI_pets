# AI余额桌宠

常驻 Windows 桌面的小挂件，一抬眼就能看到大模型平台的余额 / 配额，目前仅支持windows操作系统。

<p align="center">
  <img src="assets/DSniang1.png" width="150" alt="DeepSeek 模式">
  &nbsp;&nbsp;&nbsp;
  <img src="assets/personas/glm/character.png" width="150" alt="GLM 模式">
</p>

支持两个厂商，切换后人物贴图和气泡配色会一起换：

|  | DeepSeek | GLM Coding Plan |
|---|---|---|
| 气泡主数字 | 现金余额（¥） | 5 小时窗剩余百分比 |
| 气泡提示行 | 今日已用 | 周配额已用百分比 |
| 峰谷规则 | 工作日 9–12、14–18 为高峰 | 工作日 14:00–18:00 为高峰，其余含周末全天为谷 |
| 需要填 | API Key（`sk-xxxx`） | Coding Plan 令牌 |

不需要装 DSH 或任何宿主环境。

## 怎么用

| 操作 | 效果 |
|---|---|
| **左键点角色头旁的蓝色按钮** | 开 / 关设置菜单——**这是菜单唯一的入口**。按钮只在鼠标悬停在角色上时显形 |
| **左键点角色** | 弹出气泡（余额 / 配额 + 今日已用或周配额） |
| **左键点气泡** | 换成一句随机台词或动图，再点关闭。GLM 模式下目前只显示时段提示 |
| **按住拖拽** | 拖到桌面任意位置，靠近四边会吸附，吸到左边会整体镜像翻转 |
| **右键托盘图标** | 显示 / 隐藏、打开配置文件、退出 |
| **点角色以外的地方** | 事件穿透到桌面，不影响你正常用电脑 |

菜单里能调的：大小、音效、音量、用量统计方式、峰谷文案、气泡开关、每轮消耗提示、避让滚动条，以及下面这几项桌宠独有的：

- **模型**：DeepSeek / GLM 一键切换，贴图和配色跟着换
- **自动冒泡**：每隔一段时间主动说一句（关闭 / 5 / 15 / 30 分钟 / 1 / 2 小时）
- **开机自启**
- **凭据**（菜单最底部那一行）：填的是**当前厂商的**凭据——DeepSeek 模式填 API Key，GLM 模式填 Coding Plan 令牌（原样粘贴，**不要加 `Bearer` 前缀**）。两个厂商的凭据分开存，互不覆盖

## 功能

- 余额 / 配额展示，60 秒自动刷新，点角色可手动刷新，数字有滚动动画
- 今日已用（按余额差值本地记账，跨天归档）
- DeepSeek ↔ GLM 切换，人物贴图与气泡配色随厂商变化
- 峰谷时段提示（两个厂商各按自己的规则）
- 随机台词、动图、按压音效、Q 弹反馈
- 拖拽 + 四边吸附 + 左吸附镜像翻转，位置记忆
- 窗口置顶且点击穿透，不挡桌面操作

## 安装

### 发行版

到 [Releases](https://github.com/AngleCatAy/AI_pets/releases) 下载 zip → 解压 → 双击 `DeepSeekPet.exe`。

第一次打开时角色会出现在桌面右下角，气泡里提示「未配置」。填 Key 的方法：

1. 把鼠标移到角色身上，头部一旁会出现一个菜单按钮
2. 左键点它打开菜单，最底部一行就是填凭据的地方（DeepSeek 显示 `API Key`，GLM 显示 `GLM 令牌`）
3. 填进去按回车（或点别处）立即生效

DeepSeek 的 Key 在 https://platform.deepseek.com/api_keys 申请；GLM 用的是 Coding Plan 的令牌，**原样粘贴、不要加 `Bearer` 前缀**。

### 从源码跑

```cmd
npm install          :: 只需一次。桌宠模式要 Electron，浏览器标签页模式不需要
start-pet.cmd        :: 桌宠：出现在桌面右下角
start.cmd            :: 或者只要浏览器标签页模式
```

## 配置

打包版把配置放在 `%APPDATA%\ds-pet\config.json`；源码运行则放在项目根目录的 `config.json`（可复制 `config.json.example` 改）。**推荐使用桌宠自带菜单填入**

| 字段 | 必填 | 说明 |
|---|---|---|
| `platformToken` | 否 | `platform.deepseek.com` 的网页会话令牌。只有把用量模式切到「实时·令牌」才需要，留空会自动回落到本地记账 |
| `providers.glm.planToken` | 否 | GLM Coding Plan 令牌（原样粘贴，**不要加 `Bearer` 前缀**） |

也可以用环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_PLATFORM_TOKEN` / `GLM_PLAN_TOKEN`，优先级高于配置文件。

## 已知限制

- 窗口是**置顶**的，会浮在全屏视频 / 游戏之上；不想要时右键托盘 → 隐藏
- **只覆盖主显示器的**工作区，多显示器下角色只能在主屏活动
- 「每轮对话消耗」还没接通（需要额外一层本地反向代理）
- GLM 模式暂时没有自己的彩蛋池，点气泡仅显示时段提示

## 许可

MIT，见 [LICENSE](LICENSE)。

挂件前端（`lib/widget.js`）以及 `assets/` 下的鲸鱼图片、动图、音效来自
[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT），
原始授权见 [LICENSE-MeteorNOX](LICENSE-MeteorNOX)。

GLM 配额接口与峰谷规则参考官方插件 [zai-org/zai-coding-plugins](https://github.com/zai-org/zai-coding-plugins)。
