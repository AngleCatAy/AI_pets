// 生成应用图标 assets/icon.ico（打包 exe 用）。
//
//   npx electron tools/make-icon.cjs
//
// 为什么单独做一个工具：Windows 的 exe 图标必须是 .ico，而 @electron/packager
// 不会自己转换 PNG。这里用 Electron 自带的 nativeImage 缩放（零新依赖），
// 再手写 ICO 容器——每个尺寸塞一张 PNG（Vista 起支持 PNG 条目，Electron 默认
// 图标也是这么做的），省掉 BMP/DIB 那套手工编码。
//
// 源图是桌宠默认贴图 assets/DSniang1.png（大肥鱼），与托盘图标同源。

const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'assets', 'DSniang1.png')
const OUT = path.join(ROOT, 'assets', 'icon.ico')
// Windows 会按场景挑尺寸：16/24/32 用于任务栏与资源管理器，48/64 用于中等图标，
// 128/256 用于大图标与“超大图标”视图（256 是 ICO 的上限）
const SIZES = [16, 24, 32, 48, 64, 128, 256]

function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(entries.length, 4)

  let offset = 6 + entries.length * 16
  const dirs = []
  for (const e of entries) {
    const d = Buffer.alloc(16)
    // 宽高各 1 字节，256 用 0 表示
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 0)
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 1)
    d.writeUInt8(0, 2) // 调色板色数（真彩填 0）
    d.writeUInt8(0, 3) // reserved
    d.writeUInt16LE(1, 4) // color planes
    d.writeUInt16LE(32, 6) // bits per pixel
    d.writeUInt32LE(e.png.length, 8)
    d.writeUInt32LE(offset, 12)
    offset += e.png.length
    dirs.push(d)
  }
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)])
}

app.whenReady().then(() => {
  try {
    const base = nativeImage.createFromPath(SRC)
    if (base.isEmpty()) throw new Error('读不到源图: ' + SRC)
    const size0 = base.getSize()
    console.log('源图 ' + path.relative(ROOT, SRC) + '：' + size0.width + '×' + size0.height)

    const entries = SIZES.map((size) => {
      const img = base.resize({ width: size, height: size, quality: 'best' })
      return { size, png: img.toPNG() }
    })
    const ico = buildIco(entries)
    fs.writeFileSync(OUT, ico)
    console.log('已生成 ' + path.relative(ROOT, OUT) + '（' + SIZES.join('/') + '，' +
      (ico.length / 1024).toFixed(1) + ' KB）')
    app.exit(0)
  } catch (err) {
    console.error('生成失败：' + err.message)
    app.exit(1)
  }
})
