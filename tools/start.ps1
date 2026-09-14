# 小鲸鱼余额桌宠 —— 启动器（tab 模式=普通标签页，pet 模式=贴右下角小窗）
#
# 为什么逻辑都放在 PowerShell 里、.cmd 只做纯 ASCII 转发：
# cmd.exe 不会因为批处理文件里执行了 chcp 65001 就按 UTF-8 重新读取自身，
# 文件里的中文会被按当前代码页错误解码，甚至泄漏成非法命令。PowerShell
# 读取带 BOM 的 UTF-8 文件则没有这个问题，所以中文提示统一放这里。
#
# 本文件必须保存为「UTF-8 with BOM」，否则 Windows PowerShell 5.1 会按 ANSI
# 解码，中文全变乱码并可能直接解析失败。

[CmdletBinding()]
param(
  [ValidateSet('tab', 'pet')]
  [string]$Mode = 'tab'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $root          # tools\ -> 项目根
Set-Location $root

function Say([string]$msg) { Write-Host $msg }

# ---------- 1. 环境检查 ----------

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say ''
  Say '  [错误] 没找到 node，请先安装 Node.js 18 或更高版本：'
  Say '         https://nodejs.org/'
  Say ''
  Read-Host '  按回车键退出'
  exit 1
}

$configPath = Join-Path $root 'config.json'
if (-not (Test-Path $configPath)) {
  Copy-Item (Join-Path $root 'config.json.example') $configPath -Force
  Say ''
  Say '  还没有 config.json，已从 config.json.example 复制一份。'
  Say '  请填入你的 DeepSeek API Key 后重新运行：'
  Say "    $configPath"
  Say ''
  Read-Host '  按回车键退出'
  exit 1
}

# ---------- 2. 读配置 ----------

$port = 3080
$apiKeySet = $false
try {
  $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.port) { $port = [int]$cfg.port }
  if ($cfg.apiKey -and $cfg.apiKey.Trim() -ne '') { $apiKeySet = $true }
} catch {
  Say ''
  Say "  [警告] config.json 解析失败（$($_.Exception.Message)），将按默认端口 $port 启动。"
  Say ''
}

if (-not $apiKeySet) {
  Say ''
  Say '  [提示] config.json 里的 apiKey 还是空的，挂件会显示未配置。'
  Say '         填上 API Key 后就能看到余额了：'
  Say '         https://platform.deepseek.com/api_keys'
  Say ''
}

$url = "http://127.0.0.1:$port/"

function Test-Port([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $p)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

# ---------- 3. 服务没起就起一个 ----------
# 桌宠模式不用在这里起：Electron 主进程会把服务跑在自己进程里（打包后朋友
# 就完全不需要装 Node）。这里起的话反而会占住端口，让桌宠复用它。
# 标签页模式没有 Electron，才需要这个独立服务。

if ($Mode -eq 'tab') {
  if (Test-Port $port) {
    Say "  服务已在 $port 端口运行，直接开窗口。"
  } else {
    Say "  正在启动服务（端口 $port）..."
    # 隐藏窗口后台运行，不该带一个常驻黑色控制台；要看日志请用 npm start
    Start-Process -FilePath 'node' -ArgumentList 'server.js' `
      -WorkingDirectory $root -WindowStyle Hidden | Out-Null

    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 250
      if (Test-Port $port) { $ready = $true; break }
    }
    if (-not $ready) {
      Say ''
      Say '  [错误] 服务 10 秒内没起来。'
      Say "         想看具体报错，请在项目目录手动执行：node server.js"
      Say ''
      Read-Host '  按回车键退出'
      exit 1
    }
    Say '  服务已就绪。'
  }
}

# ---------- 4. 打开界面 ----------

if ($Mode -eq 'pet') {
  # 桌宠窗口：Electron 透明置顶窗口，覆盖整个工作区，只在鲸鱼像素上接收操作
  $electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electron)) {
    Say ''
    Say '  [错误] 没找到 Electron —— 桌宠窗口需要它，浏览器标签页模式不需要。'
    Say '         请先在项目目录执行：npm install'
    Say ''
    Read-Host '  按回车键退出'
    exit 1
  }
  Say '  正在启动桌宠窗口（右键鲸鱼可设置，托盘图标可退出）...'
  Start-Process -FilePath $electron `
    -ArgumentList (Join-Path $root 'pet\main.cjs') `
    -WorkingDirectory $root -WindowStyle Hidden
} else {
  Say '  正在打开页面...'
  Start-Process $url
}
