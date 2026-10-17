# W1 Gitee mirror setup: fill $GiteeRepoUrl, run once. Requires Gitee account + empty repo (no README init).
# Private token auth: embed as https://<token>@gitee.com/<user>/<repo>.git OR use credential manager.
$GiteeRepoUrl = "<paste: https://gitee.com/<user>/mentora.git>"
if ($GiteeRepoUrl -like "<*") { Write-Host "[FAIL] edit this script first: set GiteeRepoUrl" -ForegroundColor Red; exit 1 }
Set-Location (Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent)
git remote remove gitee 2>$null
git remote add gitee $GiteeRepoUrl
git push -u gitee feature/huawei-cloud-upgrade
if ($LASTEXITCODE -eq 0) { Write-Host "[OK] branch pushed to Gitee. Then: git push gitee --tags" -ForegroundColor Green }
Write-Host "next: push main baseline when ready: git push gitee main"
