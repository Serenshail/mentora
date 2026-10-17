# Step0 本地模型接线：粘贴模型 Key -> .env.local（不入仓） -> 自动验证调用
# 运行：powershell -ExecutionPolicy Bypass -File deploy\hw\step0-local-model.ps1
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$envFile = Join-Path $RepoRoot ".env.local"
if (-not (Test-Path $envFile)) { Write-Host "[FAIL] 缺少 .env.local" -ForegroundColor Red; exit 1 }

$existing = Get-Content $envFile -Raw
if ($existing -match "(?m)^CUSTOM_API_KEY\s*=\s*\S") {
  Write-Host "[OK] CUSTOM_API_KEY 已配置，直接验证..." -ForegroundColor Green
} else {
  Write-Host "粘贴你的模型 API Key（输入不回显，不进任何对话/日志）：" -ForegroundColor Cyan
  $s = Read-Host "  API Key" -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
  if (-not $key) { Write-Host "[FAIL] Key 为空" -ForegroundColor Red; exit 1 }
  Add-Content $envFile "CUSTOM_API_KEY=$key"
  Write-Host "[OK] 已写入 .env.local（gitignore 内，永不入仓）" -ForegroundColor Green
}

Write-Host "[..] 验证模型调用（tokenrhythm/qwen3.8-flash）..."
node (Join-Path $PSScriptRoot "verify-model.mjs")
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] 模型调用失败（Key 无效或网络问题）" -ForegroundColor Red; exit 1 }
Write-Host "[OK] 模型接线完成：AI_PROVIDER=custom 已生效（本地 dev 与部署一致）" -ForegroundColor Green
