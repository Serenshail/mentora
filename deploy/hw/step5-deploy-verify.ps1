# ============================================================
# Mentora 华为云部署 - Step5 CCE 部署与验证（用户本机执行）
# 作用：创建/更新 mentora-secrets → deploy-hw-build.mjs 部署 → rollout → ELB health 验证
# 前置：step2 集群就绪且 kubeconfig 可用；step3 镜像已推送
# 原则：Secret 经 --from-literal 直传 kubectl 不落盘；AUTH_SECRET 与 .env.local 一致（迁移契约）
# ============================================================
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$LogDir = Join-Path $RepoRoot "docs\evidence\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("step5-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
Start-Transcript -Path $LogFile | Out-Null

function Step-Done { param($m) Write-Host "[OK] $m" -ForegroundColor Green }
function Step-Fail { param($m) Write-Host "[FAIL] $m" -ForegroundColor Red; Stop-Transcript | Out-Null; exit 1 }
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
function New-RandomHex { param($bytes = 32) $b = New-Object byte[] $bytes; [Security.Cryptography.RNGCryptoServiceProvider]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString("x2") }) -join "" }

try {
  Set-Location $RepoRoot
  Write-Host "=== Mentora Step5: CCE 部署与验证（仓库：$RepoRoot）==="

  # ---- 0. 前置 ----
  $resPath = Join-Path $PSScriptRoot "hw-resources.ps1"
  if (Test-Path $resPath) { . $resPath } else { Step-Fail "缺少 $resPath，请先执行 step2-open-cloud.ps1" }
  $envLocal = Join-Path $RepoRoot ".env.local"
  if (-not (Test-Path $envLocal)) { Step-Fail "缺少 $envLocal（AUTH_SECRET 必须与迁移一致）" }
  $authSecret = $null
  foreach ($line in (Get-Content $envLocal)) {
    if ($line -match "^\s*AUTH_SECRET\s*=\s*[""']?([^""'\r\n#]+)") { $authSecret = $Matches[1].Trim(); break }
  }
  if (-not $authSecret) { Step-Fail ".env.local 未解析到 AUTH_SECRET" }
  $null = kubectl config current-context 2>$null
  if ($LASTEXITCODE -ne 0) { Step-Fail "kubectl 无集群上下文。请把 step2 下载的 kubeconfig 放到 $env:USERPROFILE\.kube\config" }
  $ctx = kubectl config current-context
  Step-Done "kubectl 上下文：$ctx"

  # ---- 1. Secret（幂等更新；DATABASE_URL 用 VPC 内网地址，Pod 同 VPC 可达）----
  Write-Host ""
  Write-Host "—— 配置 Secret（mentora-secrets；回车跳过的项不写入，跳过必要项会导致对应功能降级）——"

  $secretArgs = @()
  $secretArgs += "--from-literal=AUTH_SECRET=$authSecret"
  $rdsPwd = Read-Secret "  RDS root 密码（step2 设置，输入不回显）"
  Add-Type -AssemblyName System.Web
  $pwdEsc = [System.Web.HttpUtility]::UrlEncode($rdsPwd)
  $secretArgs += "--from-literal=DATABASE_URL=postgresql://root:${pwdEsc}@${RdsHostPrivate}:${RdsPort}/postgres?sslmode=disable"
  $dcsPwd = Read-Secret "  DCS 密码（step2 设置，输入不回显）"
  $secretArgs += "--from-literal=REDIS_URL=redis://:${dcsPwd}@${DcsHost}:${DcsPort}/0"
  $aiKey = Read-Secret "  CUSTOM_API_KEY 模型 Key（输入不回显；回车跳过=AI 回落演示模式）"
  if ($aiKey) { $secretArgs += "--from-literal=CUSTOM_API_KEY=$aiKey" }
  # AI_PROVIDER=custom 的端点与模型名（非凭据；换模型通道时同步改这两行与 CCE 清单 AI_PROVIDER）
  $secretArgs += "--from-literal=AI_BASE_URL=https://tokenrhythm.studio/v1"
  $secretArgs += "--from-literal=AI_MODEL=qwen3.8-flash"
  $cronSecret = New-RandomHex 16
  $secretArgs += "--from-literal=CRON_SECRET=$cronSecret"
  Write-Host "  CRON_SECRET（周报触发 Bearer，已自动生成，请自行保存）：$cronSecret" -ForegroundColor Yellow
  $appUrl = Read-Host "  对外 Demo URL（ELB IP 出来后可再更新，如 http://1.2.3.4）"
  if (-not $appUrl) { $appUrl = "http://pending.local" }
  $secretArgs += "--from-literal=APP_URL=$appUrl"
  $adminPwd = Read-Secret "  ADMIN_PASSWORD 后台密码（输入不回显）"
  if ($adminPwd) { $secretArgs += "--from-literal=ADMIN_PASSWORD=$adminPwd" }
  $resendKey = Read-Secret "  RESEND_API_KEY（回车跳过=暂不用 Resend 发信）"
  if ($resendKey) { $secretArgs += "--from-literal=RESEND_API_KEY=$resendKey" }
  $mailFrom = Read-Host "  MAIL_FROM 发件地址（回车跳过）"
  if ($mailFrom) { $secretArgs += "--from-literal=MAIL_FROM=$mailFrom" }

  Step-Info "写入 Secret mentora-secrets（幂等）..."

  $cmd = "kubectl create secret generic mentora-secrets --dry-run=client -o yaml " + ($secretArgs -join " ") + " | kubectl apply -f -"
  cmd /c $cmd 2>&1 | Out-String | Write-Host
  if ($LASTEXITCODE -ne 0) { Step-Fail "Secret 写入失败。日志：$LogFile" }
  Step-Done "Secret 就绪"

  # ---- 2. 镜像 tag ----
  $dirty = (git status --porcelain)
  if ($dirty) { Step-Fail "工作区不干净（与 deploy-hw-build.mjs 纪律一致）：`n$dirty" }
  $tag = (git rev-parse --short HEAD).Trim()
  $swrOrg = if ($SwrOrg) { $SwrOrg } else { "mentora" }
  $env:SWR_REGISTRY = "swr.$Region.myhuaweicloud.com/$swrOrg"

  # ---- 3. 部署（复用入库脚本：替换镜像 tag 与 APP_BUILD_SHA 后 stdin apply）----
  Step-Info "node scripts/deploy-hw-build.mjs deploy --tag $tag ..."
  node scripts/deploy-hw-build.mjs deploy --tag $tag
  if ($LASTEXITCODE -ne 0) { Step-Fail "部署失败（确认镜像 tag $tag 已在 SWR：step3）。日志：$LogFile" }

  # ---- 4. rollout + ELB 地址 ----
  Step-Info "等待滚动升级完成..."
  kubectl rollout status deployment/mentora --timeout=300s
  if ($LASTEXITCODE -ne 0) { Step-Fail "rollout 未在 300s 内完成（kubectl logs deploy/mentora 排查）。日志：$LogFile" }
  Step-Done "Deployment 就绪（tag $tag）"
  Step-Info "等待 ELB 公网地址分配（首次约 3-5 分钟）..."
  $elbIp = $null
  for ($i = 1; $i -le 30; $i++) {
    $ip = kubectl get svc mentora -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
    if ($ip) { $elbIp = $ip.Trim(); break }
    Write-Host "    等待 ELB... ($($i*10)s)"
    Start-Sleep -Seconds 10
  }
  if (-not $elbIp) { Step-Fail "ELB 地址未分配成功（kubectl describe svc mentora 看 Event）。日志：$LogFile" }
  Step-Done "ELB 公网地址：$elbIp"

  # ---- 5. health 验证（双通道展示）----
  $ok = $false
  for ($i = 1; $i -le 15; $i++) {
    try {
      $h = Invoke-WebRequest -Uri "http://$elbIp/api/health" -UseBasicParsing -TimeoutSec 8
      if ($h.StatusCode -eq 200) { Write-Host "    /api/health => $($h.Content)"; $ok = $true; break }
    } catch { Write-Host "    等待 Pod 探针就绪... ($($i*8)s)" }
    Start-Sleep -Seconds 8
  }
  if (-not $ok) { Step-Fail "ELB 已分配但 /api/health 未就绪（readinessProbe 或依赖项问题，kubectl logs deploy/mentora）。日志：$LogFile" }
  Step-Done "/api/health 返回 200，DB_CHANNEL=huawei 生效（请截图归档 docs/evidence/）"

  Write-Host ""
  Write-Host "=== Step5 完成。Demo 地址：http://$elbIp ===" -ForegroundColor Cyan
  Write-Host "后续：T-036 回滚演练 → node scripts/deploy-hw-build.mjs rollback --tag <旧tag>"
  Write-Host "提示：APP_URL 若为占位值，重跑本脚本输入真实 URL 更新 Secret 即可"
  Write-Host "日志已存：$LogFile"
} finally {
  Stop-Transcript | Out-Null
}