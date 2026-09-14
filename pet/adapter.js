// 桌宠模式适配器
//
// 在浏览器标签页模式下（没有 __dsPetHost 桥）本文件什么都不做，挂件保持原样。
//
// 桌宠模式下窗口覆盖整个工作区、透明、置顶，所以这里只做三件事：
//   1. 点击穿透：鼠标不在鲸鱼像素上时让事件穿到桌面，别挡住用户操作
//   2. 右键 → 交给主进程弹原生设置菜单
//   3. 暴露 window.__dsPet，让主进程的菜单项能驱动挂件自己的控件
//
// 刻意不去接管挂件的拖拽/点击：窗口足够大，挂件自身的拖拽、四边吸附、
// 点击刷新、音效反馈都能原样工作，这也正是能零改动复用它的原因。

(function () {
  var host = window.__dsPetHost
  if (!host) return

  var root = document.querySelector('.dshwv-root')
  var img = document.querySelector('.dshwv-img')
  if (!root || !img) return

  // 与挂件 isWhaleHit 用同一条坐标映射；素材是 610×610
  var MASK_SIZE = 610
  var mask = null
  var maskReady = false

  function buildMask() {
    try {
      var c = document.createElement('canvas')
      c.width = MASK_SIZE
      c.height = MASK_SIZE
      var ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0, MASK_SIZE, MASK_SIZE)
      mask = ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE)
      maskReady = true
    } catch (err) {
      // 取不到像素就退回几何判定（用包围盒），不会把整个屏幕判成可交互
      mask = null
      maskReady = false
    }
  }

  if (img.complete && img.naturalWidth > 0) buildMask()
  else img.addEventListener('load', buildMask)
  img.addEventListener('error', function () { maskReady = false })

  function isWhaleHit(x, y) {
    var r = img.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return false
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false
    if (!maskReady || !mask) {
      // 图片还没解码完：只认包围盒，避免整屏或整屏都不可点
      return true
    }
    var lx = (x - r.left) / r.width * MASK_SIZE
    var ly = (y - r.top) / r.height * MASK_SIZE
    if (lx < 0 || ly < 0 || lx >= MASK_SIZE || ly >= MASK_SIZE) return false
    // 贴左边吸附时挂件整体镜像（.dshwv-left / state.h === 'left'）
    if (root.classList.contains('dshwv-left')) lx = MASK_SIZE - lx
    var d = mask.data[(Math.floor(ly) * MASK_SIZE + Math.floor(lx)) * 4 + 3]
    return d > 10
  }

  function inRect(el, x, y) {
    if (!el) return false
    var r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }

  function overMenu(x, y) {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu || !menu.classList.contains('dshwv-menu-open')) return false
    return inRect(menu, x, y)
  }

  function overMenuBtn(x, y) {
    return inRect(document.querySelector('.dshwv-menu-btn'), x, y)
  }

  // 气泡打开后，它的 SVG 形状会变成 pointer-events:visiblePainted，也就是
  // "只有画出来的气泡本体可点"。用 elementFromPoint 直接复用浏览器这套命中
  // 测试，比自己算几何准确——而且气泡关闭时它是 pointer-events:none，
  // elementFromPoint 自然返回不到它，不需要额外判断开没开。
  function overBubbleShape(x, y) {
    try {
      var el = document.elementFromPoint(x, y)
      return !!(el && el.closest && el.closest('.dshwv-bubble'))
    } catch (err) {
      return false
    }
  }

  function interactiveAt(x, y) {
    return overMenu(x, y) || overMenuBtn(x, y) || overBubbleShape(x, y) || isWhaleHit(x, y)
  }

  // -------------------------------------------------------------------------
  // 点击穿透
  // -------------------------------------------------------------------------

  var pointing = false
  var lastIgnore = null

  function setIgnore(ignore) {
    if (ignore === lastIgnore) return
    lastIgnore = ignore
    host.setClickThrough(ignore)
  }

  var lastHitReport = 0
  function reportHit(x, y) {
    if (!host.debugHit) return
    var now = Date.now()
    if (now - lastHitReport < 600) return
    lastHitReport = now
    host.debugHit({
      x: Math.round(x), y: Math.round(y),
      whale: isWhaleHit(x, y),
      bubble: overBubbleShape(x, y),
      menu: overMenu(x, y),
      btn: overMenuBtn(x, y),
      mask: maskReady,
    })
  }

  function update(x, y) {
    reportHit(x, y)
    // 按住鼠标期间绝不切成穿透：快速拖拽时鲸鱼有 transition 动画会落在
    // 光标后面，按像素判定会中途"丢失"命中，导致 pointerup 收不到、鲸鱼卡住
    if (pointing) {
      setIgnore(false)
      return
    }
    setIgnore(!interactiveAt(x, y))
  }

  // 只观察、不拦截：挂件自己在 document 捕获阶段处理拖拽与点击。
  // 顺便记录一次左键点击的落点和位移，便于排查"点了没反应"——挂件把
  // 位移超过阈值的按下/抬起当成拖拽，那样就不会弹气泡。
  var clickStart = null
  window.addEventListener('pointerdown', function (e) {
    pointing = true
    setIgnore(false)
    if (e.button === 0 && isWhaleHit(e.clientX, e.clientY)) {
      clickStart = { x: e.clientX, y: e.clientY }
    } else {
      clickStart = null
    }
  }, true)
  window.addEventListener('pointerup', function (e) {
    pointing = false
    update(e.clientX, e.clientY)
    if (clickStart && host.clickDiag) {
      var dx = e.clientX - clickStart.x
      var dy = e.clientY - clickStart.y
      var t = e.target
      host.clickDiag({
        movedPx: Math.round(Math.sqrt(dx * dx + dy * dy)),
        // 记下坐标和实际命中的元素：万一再出现"点了没反应"，
        // 一眼就能看出是点偏了、还是被别的元素挡住了
        at: [Math.round(e.clientX), Math.round(e.clientY)],
        target: t ? (t.className || t.tagName || '?') : '?',
      })
    }
    clickStart = null
  }, true)
  window.addEventListener('pointercancel', function (e) {
    pointing = false
    clickStart = null
    update(e.clientX, e.clientY)
  }, true)
  window.addEventListener('mousemove', function (e) { update(e.clientX, e.clientY) }, true)

  // 右键不再做任何事——菜单只从左键点汉堡按钮这一条路进（按设计如此）。
  // 这里刻意不注册 contextmenu 处理器，也不 preventDefault：Chromium 对
  // 这类窗口本来就不弹默认菜单，右键等于空操作。
  // 注意别顺手在这里 calling btn.click()——那会让右键又变成第二条入口。

  // -------------------------------------------------------------------------
  // 菜单控件寻址：按行标签定位，不依赖顺序索引（挂件会迭代加行）
  // -------------------------------------------------------------------------

  function rowByLabel(label) {
    var rows = document.querySelectorAll('.dshwv-menu-row')
    for (var i = 0; i < rows.length; i++) {
      var text = (rows[i].textContent || '').replace(/\s+/g, '')
      if (text.indexOf(label) === 0) return rows[i]
    }
    return null
  }

  function ctrl(label, selector) {
    var row = rowByLabel(label)
    return row ? row.querySelector(selector) : null
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }))
  }

  // -------------------------------------------------------------------------
  // 驱动挂件自己的控件（主进程需要时用，比如保存 Key 后立刻刷新余额）
  // -------------------------------------------------------------------------

  function setRange(label, value) {
    var el = ctrl(label, '.dshwv-range')
    if (!el) return false
    el.value = String(value)
    fire(el, 'input')
    fire(el, 'change')
    return true
  }

  function setSelect(label, value) {
    var el = ctrl(label, 'select')
    if (!el) return false
    el.value = String(value)
    fire(el, 'change')
    return true
  }

  function setCheck(label, value) {
    var el = ctrl(label, 'input[type=checkbox]')
    if (!el) return false
    el.checked = !!value
    fire(el, 'change')
    return true
  }

  function setNumber(label, value) {
    var el = ctrl(label, '.dshwv-number')
    if (!el) return false
    el.value = String(value)
    fire(el, 'input')
    fire(el, 'change')
    return true
  }

  // 在鲸鱼的不透明像素里找一个点，用来合成一次"点一下鲸鱼"
  function findOpaquePoint() {
    var r = img.getBoundingClientRect()
    if (!maskReady || !mask) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    for (var gy = 0.9; gy > 0.1; gy -= 0.05) {
      for (var gx = 0.5; gx < 0.99; gx += 0.05) {
        var x = r.left + r.width * gx
        var y = r.top + r.height * gy
        if (isWhaleHit(x, y)) return { x: x, y: y }
      }
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }

  // 复用挂件自己的点击路径：合成 pointerdown/up，让它走 showBubble()+refresh(true)，
  // 连按压音效和 Q 弹反馈一起保留
  function tapWhale() {
    var pt = findOpaquePoint()
    var base = {
      bubbles: true, cancelable: true, composed: true,
      clientX: pt.x, clientY: pt.y, screenX: pt.x, screenY: pt.y,
      button: 0, pointerType: 'mouse', isPrimary: true, pointerId: 1,
    }
    var target = document.elementFromPoint(pt.x, pt.y) || document.body
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { buttons: 1 })))
      target.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { buttons: 0 })))
      return true
    } catch (err) {
      return false
    }
  }

  function resetPosition() {
    try { localStorage.removeItem('dshw-pos') } catch (err) {}
    location.reload()
  }

  window.__dsPet = {
    applySetting: function (key, value) {
      switch (key) {
        case 'scale': return setRange('大小', value)
        case 'vol': return setRange('音量', value)
        case 'soundSet': return setSelect('音效', value)
        case 'usageMode': return setSelect('用量', value)
        case 'peakMode': return setSelect('峰谷', value)
        case 'bubbleOn': return setCheck('气泡', value)
        case 'turnCostOn': return setCheck('每轮消耗提示', value)
        case 'turnCostCloseMs': return setNumber('每轮消耗提示', Number(value) / 1000)
        case 'scrollGapOn': return setCheck('避让滚动条', value)
        case 'refresh': return tapWhale()
        case 'resetPosition': return resetPosition()
        default: return false
      }
    },
  }

  // 让托盘提示能显示余额
  function report() {
    var amount = document.querySelector('.dshwv-amount')
    if (amount) host.reportBalance((amount.textContent || '').trim())
  }
  setInterval(report, 5000)
  setTimeout(report, 1500)

  // 菜单里有文本输入框（API Key），而窗口默认 focusable:false —— 那种窗口
  // 永远拿不到键盘焦点，输入框就是打不进字。所以菜单开合时临时把窗口切成
  // 可聚焦，关掉菜单再切回来，这样"点鲸鱼不抢你当前应用焦点"的默认行为不变。
  var menuEl = document.querySelector('.dshwv-menu')
  if (menuEl && window.MutationObserver) {
    var lastMenuOpen = false
    new MutationObserver(function () {
      var isOpen = menuEl.classList.contains('dshwv-menu-open')
      if (isOpen === lastMenuOpen) return
      lastMenuOpen = isOpen
      try {
        host.setFocusable(isOpen)
      } catch (err) {}
      if (!isOpen) return
      // 菜单刚打开、位置已定，这时记一次真实坐标（排查"点不到输入框"用）
      try {
        var mr = menuEl.getBoundingClientRect()
        var inp = menuEl.querySelector('input[type=password]')
        var ir = inp ? inp.getBoundingClientRect() : null
        if (host.clickDiag) {
          host.clickDiag({
            kind: 'ui',
            detail: '菜单已开：菜单框 ' + Math.round(mr.left) + ',' + Math.round(mr.top) +
              ' ' + Math.round(mr.width) + 'x' + Math.round(mr.height) +
              '；API Key 输入框 ' + (ir ? Math.round(ir.left) + ',' + Math.round(ir.top) +
                ' ' + Math.round(ir.width) + 'x' + Math.round(ir.height) : '无') +
              '（窗口坐标）',
          })
        }
      } catch (err) {}
    }).observe(menuEl, { attributes: true, attributeFilter: ['class'] })
  }

  // 记一次菜单入口的位置。菜单现在只有"左键点这个按钮"一条入口，按钮又只有
  // 26×26，出问题时（找不到入口）有这个坐标就能直接对上号。
  // 注意：菜单和 API Key 输入框的坐标不在这里记——菜单关着时它的 rect 是未定位
  // 的静态值（top/left 都是乱的），只有打开后才有意义，所以那两条日志放在
  // 下面 MutationObserver 的"菜单已开"分支里。
  setTimeout(function () {
    try {
      var btn = document.querySelector('.dshwv-menu-btn')
      if (!btn || !host.clickDiag) return
      var b = btn.getBoundingClientRect()
      host.clickDiag({
        kind: 'ui',
        detail: '菜单按钮位置 ' + Math.round(b.left) + ',' + Math.round(b.top) +
          ' 尺寸 ' + Math.round(b.width) + 'x' + Math.round(b.height) + '（窗口坐标）',
      })
    } catch (err) {}
  }, 2000)

  // 初始整窗穿透由主进程设好。主进程会在页面加载完后把当前光标位置送过来，
  // 这样即便光标本来就停在鲸鱼上，也能立刻切成可交互，不用等用户先动鼠标。
  lastIgnore = true
  if (host.onInitialCursor) {
    host.onInitialCursor(function (pt) {
      if (pt && isFinite(pt.x) && isFinite(pt.y)) update(pt.x, pt.y)
    })
  }
})()
