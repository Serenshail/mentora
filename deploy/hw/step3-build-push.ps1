# ============================================================
# Mentora 华为云部署 - Step3 镜像构建与推送 SWR（用户本机执行）
# 作用：docker build（tag=git 短 sha）→ SWR 临时登录 → push → 本地冒烟（可选）
# 原则：登录指令临时粘贴不落盘；推送后本地冒烟验证容器可起
# ============================================================
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$LogDir = Join-Path $RepoRoot "docs\evidence\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("step3-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
Start-Transcript -Path $LogFile | Out-Null

function Step-Done { param($m) Write-Host "[OK] $m" -ForegroundColor Green }
function Step-Fail { param($m) Write-Host "[FAIL] $m" -ForegroundColor Red; Stop-Transcript | Out-Null; exit 1 }
function Step-Info { param($m) Write-Host "[..] $m" -ForegroundColor Cyan }
# 自动化运行（stdin 重定向）时经管道读入、不回显；交互运行时走原生 Read-Host——两条路径凭据均不落盘
function Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  if ([Console]::IsInputRedirected) {
    $line = [Console]::ReadLine()
    if ($null -eq $line) { $line = "" }
    if ($AsSecureString) { return ConvertTo-SecureString -String $line -AsPlainText -Force }
    return $line
  }
  return Microsoft.PowerShell.Utility\Read-Host @PSBoundParameters
}

try {
  Set-Location $RepoRoot
  Write-Host "=== Mentora Step3: 镜像构建与推送（仓库：$RepoRoot）==="

  # ---- 0. 资源清单（拿 SWR 区域/组织）----
  $resPath = Join-Path $PSScriptRoot "hw-resources.ps1"
  if (Test-Path $resPath) { . $resPath } else { Step-Fail "缺少 $resPath，请先执行 step2-open-cloud.ps1" }
  $Registry = "swr.$Region.myhuaweicloud.com"
  $ImageFull = "$Registry/$SwrOrg/mentora"

  # ---- 1. Docker daemon ----
  $null = docker version --format '{{.Server.Version}}' 2>$null
  if ($LASTEXITCODE -ne 0) { Step-Fail "Docker daemon 未运行，请打开 Docker Desktop 后重跑" }
  Step-Done "Docker daemon 就绪"

  # ---- 2. 工作区干净（与 scripts/deploy-hw-build.mjs 纪律一致）----
  $dirty = (git status --porcelain)
  if ($dirty) { Step-Fail "工作区不干净（git status 非空）。先提交或 stash：`n$dirty" }
  $tag = (git rev-parse --short HEAD).Trim()
  Step-Done "工作区干净，镜像 tag = $tag"

  # ---- 3. Dockerfile 存在 ----
  if (-not (Test-Path (Join-Path $RepoRoot "Dockerfile"))) { Step-Fail "仓库根缺少 Dockerfile" }

  # ---- 4. 构建 ----
  Step-Info "docker build（约 3-8 分钟，视网络而定）..."
  docker build -t "${ImageFull}:${tag}" -t "${ImageFull}:latest" .
  if ($LASTEXITCODE -ne 0) { Step-Fail "docker build 失败" }
  Step-Done "镜像构建完成：${ImageFull}:${tag}"

  # ---- 5. SWR 临时登录（粘贴指令，不落盘）----
  Write-Host ""
  Write-Host "获取 SWR 临时登录指令：SWR 控制台 → 总览 → 客户端配置 → 生成临时登录指令（复制整条 docker login 命令）"
  $loginCmd = Read-Host "  粘贴临时登录指令"
  if ($loginCmd -notmatch "^docker login") { Step-Fail "指令应以 docker login 开头" }
  Invoke-Expression $loginCmd
  if ($LASTEXITCODE -ne 0) { Step-Fail "docker login 失败" }
  Step-Done "SWR 登录成功"

  # ---- 6. 推送 ----
  Step-Info "推送 ${ImageFull}:${tag} ..."
  docker push "${ImageFull}:${tag}"
  if ($LASTEXITCODE -ne 0) { Step-Fail "推送失败（确认组织 $SwrOrg 已创建、临时指令与 $Registry 匹配）" }
  Step-Info "推送 ${ImageFull}:latest ..."
  docker push "${ImageFull}:latest"
  if ($LASTEXITCODE -ne 0) { Step-Fail "推送 latest 失败" }
  Step-Done "推送完成（SWR 控制台 → 我的镜像 应可见 mentora，含 tag $tag / latest）"

  # ---- 7. 本地冒烟（可选，对应 T-031：容器能起、/api/health 有响应）----
  $smoke = Read-Host "是否本地容器冒烟？(y/N)"
  if ($smoke -eq "y") {
    Step-Info "docker run 冒烟：localhost:13000（应用对未配置通道有回退容错）..."
    docker rm -f mentora-smoke 2>$null | Out-Null
    docker run -d --name mentora-smoke -p 13000:3000 "${ImageFull}:${tag}" | Out-Null
    if ($LASTEXITCODE -ne 0) { Step-Fail "容器启动失败（用 docker logs mentora-smoke 查看原因）" }
    $ok = $false
    for ($i = 1; $i -le 15; $i++) {
      Start-Sleep -Seconds 4
      try {
        $h = Invoke-WebRequest -Uri "http://localhost:13000/api/health" -UseBasicParsing -TimeoutSec 5
        if ($h.StatusCode -eq 200) { Write-Host "    /api/health => $($h.Content)"; $ok = $true; break }
      } catch { Write-Host "    等待容器就绪... ($($i*4)s)" }
    }
    docker rm -f mentora-smoke | Out-Null
    if ($ok) { Step-Done "本地冒烟通过（T-031），容器已清理" }
    else { Step-Fail "冒烟失败：容器启动但 /api/health 未在 60 秒内就绪，日志：$LogFile（docker logs 可复现）" }
  }

  Write-Host ""
  Write-Host "=== Step3 完成。下一步：step4-init-migrate.ps1（RDS 建表与迁移），或先 step5 部署空库 ===" -ForegroundColor Cyan
  Write-Host "日志已存：$LogFile"
} finally {
  Stop-Transcript | Out-Null
}