# ============================================================
# Mentora 华为云部署 - Step1 工具检查与安装（用户本机执行）
# 作用：检查 node/git/docker/kubectl/hcloud；缺 hcloud 时自动安装
# 原则：不改系统配置；安装仅到用户目录，卸载即删目录
# ============================================================
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$LogDir = Join-Path $RepoRoot "docs\evidence\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("step1-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
Start-Transcript -Path $LogFile | Out-Null

function Step-Done { param($m) Write-Host "[OK] $m" -ForegroundColor Green }
function Step-Fail { param($m) Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }
function Step-Info { param($m) Write-Host "[..] $m" -ForegroundColor Cyan }

try {
  Write-Host "=== Mentora Step1: 工具检查（仓库根：$RepoRoot）==="

  # ---- 1. Node >= 18（scripts/*.mjs 依赖）----
  try {
    $nodeVer = (node --version) 2>$null
    $nodeMajor = [int]($nodeVer -replace '^v(\d+)\..*','$1')
    if ($nodeMajor -lt 18) { Step-Fail "Node 版本过低：$nodeVer（需 >= 18）" }
    Step-Done "Node $nodeVer"
  } catch { Step-Fail "未检测到 node，请先安装 Node.js 18+：https://nodejs.org" }

  # ---- 2. Git（取短 sha 作为镜像 tag）----
  try { $gitVer = (git --version); Step-Done $gitVer }
  catch { Step-Fail "未检测到 git：https://git-scm.com/download/win" }

  # ---- 3. Docker Desktop（daemon 必须运行中）----
  $dockerOk = $false
  try {
    $dockerSrv = (docker version --format '{{.Server.Version}}') 2>$null
    if ($LASTEXITCODE -eq 0 -and $dockerSrv) { $dockerOk = $true; Step-Done "Docker daemon $dockerSrv" }
  } catch { }
  if (-not $dockerOk) {
    Step-Info "Docker daemon 未运行。尝试启动 Docker Desktop（首次启动约 1-2 分钟）..."
    $dd = Join-Path $env:LOCALAPPDATA "Docker\Docker Desktop.exe"
    if (-not (Test-Path $dd)) { $dd = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe" }
    if (-not (Test-Path $dd)) { $dd = "C:\Program Files\Docker\Docker\Docker Desktop.exe" }
    if (-not (Test-Path $dd)) { Step-Fail "未找到 Docker Desktop，请安装：https://www.docker.com/products/docker-desktop/" }
    Start-Process -FilePath $dd
    $ready = $false
    for ($i = 1; $i -le 24; $i++) {
      Start-Sleep -Seconds 5
      try {
        $null = (docker version --format '{{.Server.Version}}') 2>$null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
      } catch { }
      Write-Host "    等待 Docker daemon 就绪... ($($i*5)s)"
    }
    if ($ready) { Step-Done "Docker daemon 已就绪" } else { Step-Fail "Docker daemon 120 秒未就绪。请手动打开 Docker Desktop，等它启动完成后重跑本脚本" }
  }

  # ---- 4. kubectl（v1.28+ 即可，无需集群上下文）----
  try {
    $kubectlVer = (kubectl version --client=true -o json | ConvertFrom-Json).clientVersion.gitVersion
    Step-Done "kubectl $kubectlVer"
  } catch { Step-Fail "未检测到 kubectl，请安装：https://kubernetes.io/docs/tasks/tools/ （或 choco install kubernetes-cli）" }

  # ---- 5. 华为云 KooCLI（hcloud）----
  $hcloudDir = Join-Path $env:USERPROFILE "hcloud-cli"
  $hcloudExe = Join-Path $hcloudDir "hcloud.exe"
  if (Get-Command hcloud -ErrorAction SilentlyContinue) {
    Step-Done "hcloud 已在 PATH：$((hcloud version) 2>$null)"
  } elseif (Test-Path $hcloudExe) {
    Step-Done "hcloud 已安装于 $hcloudDir"
  } else {
    Step-Info "未检测到 hcloud，开始安装到 $hcloudDir ..."
    New-Item -ItemType Directory -Force -Path $hcloudDir | Out-Null
    $zipPath = Join-Path $env:TEMP "hcloud_windows_64.zip"
    # KooCLI 官方下载（Windows 64 位）；候选地址逐个尝试，全部失败则给出手动指引
    $urls = @(
      # 2026-10 官方新地址（旧 hwcloudcli/hcloud_windows_64.zip 已 404）
      "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/huaweicloud-cli-windows-amd64.zip",
      "https://obs.cn-north-4.myhuaweicloud.com/hwcloudcli/hcloud_windows_64.zip"
    )
    $downloaded = $false
    foreach ($u in $urls) {
      try {
        Step-Info "尝试下载 $u"
        if ($u -like "*.zip") {
          Invoke-WebRequest -Uri $u -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
          Expand-Archive -Path $zipPath -DestinationPath $hcloudDir -Force
          # zip 内可能嵌套目录，把 hcloud.exe 找出来提升到根
          $found = Get-ChildItem -Path $hcloudDir -Recurse -Filter "hcloud.exe" | Select-Object -First 1
          if ($found -and $found.FullName -ne $hcloudExe) { Copy-Item $found.FullName $hcloudExe -Force }
          $downloaded = $true
        } else {
          Invoke-WebRequest -Uri $u -OutFile $hcloudExe -UseBasicParsing -TimeoutSec 120
          $downloaded = $true
        }
        break
      } catch { Write-Host "    下载失败：$($_.Exception.Message)" -ForegroundColor Yellow }
    }
    if (-not $downloaded) {
      Step-Fail @"
自动下载失败。请手动安装 KooCLI：
  1) 打开 https://www.huaweicloud.com/koocli-tools/ 下载 Windows 64 位版
  2) 解压 hcloud.exe 到 $hcloudDir
  3) 重跑本脚本
"@
    }
    if (-not (Test-Path $hcloudExe)) { Step-Fail "hcloud.exe 未就位：$hcloudExe" }
    Step-Done "hcloud 安装完成：$hcloudExe"
  }

  # ---- 6. 把 hcloud 目录加入用户 PATH（幂等）----
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$hcloudDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$hcloudDir", "User")
    Step-Done "已将 $hcloudDir 加入用户 PATH（新开终端生效；当前会话临时生效）"
    $env:Path += ";$hcloudDir"
  } else { Step-Info "hcloud 目录已在 PATH 中" }

  Write-Host ""
  Write-Host "=== Step1 全部通过。下一步：step2-open-cloud.ps1（开通云资源）===" -ForegroundColor Cyan
  Write-Host "日志已存：$LogFile"
} finally {
  Stop-Transcript | Out-Null
}