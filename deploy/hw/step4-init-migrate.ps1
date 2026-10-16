# ============================================================
# Mentora 华为云部署 - Step4 RDS 建表与存量迁移（用户本机执行）
# 作用：init-rds-schema.mjs 建三表 → migrate-to-rds.mjs 迁移（预检/UPSERT/对账/抽样解密）
# 前置：step2 已开 RDS 且绑公网地址；仓库 .env.local 含 AUTH_SECRET（迁移前后必须一致）
# 原则：密码交互输入；校验失败非 0 退出，主通道不受影响
# ============================================================
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$LogDir = Join-Path $RepoRoot "docs\evidence\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("step4-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
Start-Transcript -Path $LogFile | Out-Null

function Step-Done { param($m) Write-Host "[OK] $m" -ForegroundColor Green }
function Step-Fail { param($m) Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }
function Step-Info { param($m) Write-Host "[..] $m" -ForegroundColor Cyan }
function Read-Secret { param($m) $s = Read-Host $m -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
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
  Write-Host "=== Mentora Step4: RDS 建表与迁移（仓库：$RepoRoot）==="

  # ---- 0. 前置检查 ----
  $resPath = Join-Path $PSScriptRoot "hw-resources.ps1"
  if (Test-Path $resPath) { . $resPath } else { Step-Fail "缺少 $resPath，请先执行 step2-open-cloud.ps1" }
  if (-not $RdsHostPublic) { Step-Fail "hw-resources.ps1 中 RdsHostPublic 为空：RDS 未绑公网地址（step2 有指引）" }
  $envLocal = Join-Path $RepoRoot ".env.local"
  if (-not (Test-Path $envLocal)) { Step-Fail "缺少 $envLocal（迁移需要其中 AUTH_SECRET 与旧通道凭据）" }
  $envRaw = Get-Content $envLocal -Raw
  if ($envRaw -notmatch "AUTH_SECRET\s*=") { Step-Fail ".env.local 缺少 AUTH_SECRET（加密迁移必须与线上一致）" }
  Step-Done "前置检查通过（RDS 公网 $RdsHostPublic，.env.local 含 AUTH_SECRET）"

  # ---- 1. 构造 DATABASE_URL（密码交互输入，仅入环境变量不落盘）----
  $rdsPwd = Read-Secret "  输入 RDS root 密码（step2 设置的，输入不回显）"
  if (-not $rdsPwd) { Step-Fail "RDS 密码不能为空" }
  # URL 转义密码中的特殊字符
  Add-Type -AssemblyName System.Web
  $pwdEsc = [System.Web.HttpUtility]::UrlEncode($rdsPwd)
  $env:DATABASE_URL = "postgresql://root:${pwdEsc}@${RdsHostPublic}:${RdsPort}/postgres?sslmode=disable"
  Step-Done "DATABASE_URL 已设置（postgres@${RdsHostPublic}:${RdsPort}）"

  # ---- 2. 建表 ----
  Step-Info "执行 init-rds-schema.mjs（users/sessions/events 三表，DDL 与 src/lib/server/db.ts 一致）..."
  node scripts/init-rds-schema.mjs
  if ($LASTEXITCODE -ne 0) { Step-Fail "建表失败（常见原因：公网白名单未放行本机 IP / 密码错误 / EIP 带宽未购买）。日志：$LogFile" }
  Step-Done "三表就绪"

  # ---- 3. 迁移（脚本自动读 .env.local 的 AUTH_SECRET/GITHUB_DB_*）----
  Step-Info "执行 migrate-to-rds.mjs（密钥预检 → 密文透传 UPSERT → 对账 → 抽样解密校验）..."
  node scripts/migrate-to-rds.mjs
  if ($LASTEXITCODE -ne 0) { Step-Fail "迁移校验失败非 0 退出：主通道保持旧通道未受影响。日志：$LogFile" }
  Step-Done "迁移全绿（对账 + 抽样解密校验通过）"

  Write-Host ""
  Write-Host "=== Step4 完成。下一步：step5-deploy-verify.ps1（CCE 部署 + health 验证）===" -ForegroundColor Cyan
  Write-Host "提示：迁移完成且新通道验证后，可在 RDS 控制台解绑公网地址（省 EIP 费用）"
  Write-Host "日志已存：$LogFile"
} finally {
  Stop-Transcript | Out-Null
}