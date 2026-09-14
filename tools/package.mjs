// 打包成「解压即用」的免安装版
//
//   npm run package
//
// 产出 dist/DeepSeekPet-win32-x64/，里面 DeepSeekPet.exe 双击就跑。
// 朋友那边不需要装 Node，也不需要装 Electron —— 运行时全在包里。
//
// 用 @electron/packager 而不是 electron-builder：后者出安装包还要另外下载
// NSIS / winCodeSign 之类的二进制，国内网络容易卡住；packager 直接用已经
// 装好的 Electron，不额外下载，产物是个文件夹，压缩后发给朋友一样用。

import { packager } from '@electron/packager'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'dist')

// 打包时排除的东西。注意 config.json 一定要排除——里面有使用者自己的 API Key。
const IGNORE = [
  /^\/dist($|\/)/,
  /^\/tools($|\/)/,
  /^\/_ref($|\/)/,
  /^\/data($|\/)/,
  /^\/node_modules($|\/)/,
  /^\/config\.json$/,
  /^\/config\.json\.example$/,
  /^\/\.gitignore$/,
  /^\/README\.md$/,
  // 内部交接笔记和开发脚本不该发给朋友（HANDOFF.md 里写着工作约定和排查过程，
  // draw_glm.py 是画贴图用的脚本，都不参与运行）
  /^\/HANDOFF\.md$/,
  /^\/draw_glm\.py$/,
  /^\/package-lock\.json$/,
  /^\/lib\/widget\.js\.map$/,
  // 这两个启动器是开发用的，在包里跑不起来（它们指向 node_modules 里的
  // electron.exe）。留在包里只会让人误双击，然后看到"没找到 Electron"。
  /^\/start\.cmd$/,
  /^\/start-pet\.cmd$/,
  // 根目录的杂项设计稿不该进包
  /^\/手绘草图\.png$/,
  /^\/[^/]*\.(png|jpg|jpeg|gif)$/i,
]

// 应用需要的文件（白名单式确认，避免把密钥之类的顺手打进去）
const REQUIRED = [
  'server.js',
  'pet.html',
  'index.html',
  'lib/widget.js',
  'pet/main.cjs',
  'pet/preload.cjs',
  'pet/adapter.js',
  'assets/DSniang1.png',
  // GLM 模式的贴图。漏了它会静默回落到鲸鱼（GLM 下人物不对），所以放进必需清单
  'assets/personas/glm/character.png',
  'assets/rua.gif',
  'assets/Ya1.mp3',
  'assets/Ya2.mp3',
  'assets/D1.mp3',
  'assets/D2.mp3',
]

console.log('检查必需文件...')
let missing = 0
for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error('  ✗ 缺少 ' + rel)
    missing++
  }
}
if (missing) {
  console.error('\n缺少 ' + missing + ' 个必需文件，先补齐再打包。')
  process.exit(1)
}
console.log('  全部就位（' + REQUIRED.length + ' 个）')

// 硬性把关：绝不能把带 Key 的 config.json 打进去
const cfgPath = path.join(ROOT, 'config.json')
if (fs.existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    if (cfg && cfg.apiKey) {
      console.log('  注意：config.json 里有 API Key，已在排除列表里，不会被打进安装包。')
    }
  } catch (err) {}
}

console.log('\n开始打包（这一步只是复制文件，不下载任何东西）...')
// 版本号以 package.json 为准，这里只读一次，避免两处版本号漂移
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
console.log('版本：v' + VERSION)

const appPaths = await packager({
  dir: ROOT,
  name: 'DeepSeekPet',
  platform: 'win32',
  arch: 'x64',
  out: OUT,
  overwrite: true,
  // 不用 asar：桌宠主进程要动态 import 服务端模块，asar 里的 ESM 支持有坑；
  // 而且我们的应用文件总共才十几个，散着放没负担，出了问题也好排查。
  asar: false,
  prune: true,
  ignore: IGNORE,
  appVersion: VERSION,
  win32metadata: {
    CompanyName: 'ds-pet',
    FileDescription: 'DeepSeek 余额小鲸鱼桌宠',
    ProductName: '小鲸鱼余额桌宠',
    OriginalFilename: 'DeepSeekPet.exe',
  },
  quiet: false,
})

console.log('\n打包完成：')
for (const p of appPaths) {
  const exe = path.join(p, 'DeepSeekPet.exe')
  const size = dirSize(p)
  console.log('  ' + p)
  console.log('    可执行文件：' + exe + (fs.existsSync(exe) ? ' ✓' : ' ✗ 缺失'))
  console.log('    体积：' + (size / 1024 / 1024).toFixed(0) + ' MB')
}
console.log('\n把它整个文件夹压缩后发给朋友即可；对方解压双击 DeepSeekPet.exe，')
console.log('把鼠标移到小鲸鱼身上、左键点右上角的蓝色按钮，菜单最底部就能填 API Key。')

// 给朋友放一份纯文字的说明，免得他对着文件夹不知道点哪个
const GUIDE = `小鲸鱼余额桌宠 —— 使用说明

怎么用
  双击 DeepSeekPet.exe 就行，不需要装 Node 或其它任何东西。
  小鲸鱼会出现在桌面右下角。填 API Key 的方法：
    1. 把鼠标移到小鲸鱼身上，它右上角会出现一个蓝色按钮
    2. 左键点那个按钮打开菜单，菜单最底部一行就是「API Key」
    3. 把 Key 填进去按回车（或点别处），余额立刻就出来了
  还没有 Key 的话去这里建一个（形如 sk-xxxx）：
    https://platform.deepseek.com/api_keys
  余额是你自己账号的，别人的 Key 用不了，也不能共用。

怎么操作
  左键点那个蓝色按钮   开 / 关设置菜单（只有这一条路）
  左键点鲸鱼           弹余额气泡（余额 + 今日已用）
  左键点气泡           切换随机台词，再点关闭
  按住拖拽             拖到桌面任意位置，靠近四边会吸附
  右键                 不做任何事
  点鲸鱼以外的地方     事件穿透到桌面，不挡你用电脑

退出
  右键任务栏托盘的小鲸鱼图标 → 退出。

配置放在哪
  %APPDATA%\\ds-pet\\config.json
  里面是明文存的 API Key，别把这个文件发给别人。
  换 Key 直接在菜单最底部那行改；也可以右键托盘 → 打开配置文件。

关于「今日已用」
  默认用「小鲸鱼记账」：靠余额差值本地记账，不需要额外令牌。
  想用官方用量数据的话，需要填平台会话令牌——那个令牌会过期，比较麻烦，
  所以默认没开。

说明
  挂件前端、鲸鱼图、音效来自开源项目
  MeteorNOX/DeepSeek-Balance-Whale-Widget（MIT 协议）。
`
const outDir = appPaths[0]
try {
  fs.writeFileSync(path.join(outDir, '使用说明.txt'), GUIDE, 'utf8')
  console.log('\n已生成「使用说明.txt」到包内。')
} catch (err) {
  console.log('\n（使用说明.txt 写入失败：' + err.message + '）')
}

function dirSize(dir) {
  let total = 0
  const walk = (d) => {
    let items
    try {
      items = fs.readdirSync(d, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const it of items) {
      const p = path.join(d, it.name)
      if (it.isDirectory()) walk(p)
      else {
        try {
          total += fs.statSync(p).size
        } catch (err) {}
      }
    }
  }
  walk(dir)
  return total
}
