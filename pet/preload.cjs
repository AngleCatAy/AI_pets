// 预加载脚本：只暴露桌宠需要的几个能力，不开 nodeIntegration。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__dsPetHost', {
  // 整窗穿透开关（true = 鼠标事件穿透到桌面）
  setClickThrough: (ignore) => ipcRenderer.send('pet:set-click-through', ignore),
  // 启动时的光标位置（窗口内坐标），用于立刻判定要不要开穿透
  onInitialCursor: (cb) => ipcRenderer.on('pet:initial-cursor', (event, pt) => cb(pt)),
  // 把当前余额告诉主进程，用于托盘提示
  reportBalance: (text) => ipcRenderer.send('pet:balance', text),
  // 桌宠侧独有设置：挂件菜单里的控件通过这几个转发给主进程落地
  setAutoPop: (ms) => ipcRenderer.send('pet:set-auto-pop', ms),
  setOpenAtLogin: (on) => ipcRenderer.send('pet:set-open-at-login', on),
  setApiKey: (key) => ipcRenderer.send('pet:set-api-key', key),
  // 菜单开合时切换窗口可聚焦（菜单里有文本输入框，需要能拿到键盘焦点）
  setFocusable: (on) => ipcRenderer.send('pet:set-focusable', on),
  // 多厂商：切换 DeepSeek / GLM（主进程落地并触发一次刷新）
  setProvider: (p) => ipcRenderer.send('pet:set-provider', p),
  // 左键点击诊断：记录"点在哪、移动了多少像素"，用于排查"点了没反应"
  clickDiag: (info) => ipcRenderer.send('pet:click-diag', info),
  quit: () => ipcRenderer.send('pet:quit'),
  // 调试用：把命中判定明细报给主进程（仅在 DS_PET_DEBUG 下打日志）
  debugHit: (info) => ipcRenderer.send('pet:debug-hit', info),
})
