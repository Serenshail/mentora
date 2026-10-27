# Mentora 本机服务看门狗：3000 未监听则重启 next start；UUMit 客户端未运行则拉起。
# 由 Windows 计划任务每 5 分钟调用（SYSTEM 权限，无需用户登录交互）。
$ErrorActionPreference = "SilentlyContinue"
$log = "D:\zcode\agent\mentora\scripts\keep-alive.log"
function Log($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) }

# 1) 端口 3000 检查
$listen = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $listen) {
  Log "port 3000 down -> restarting next start"
  Start-Process -WindowStyle Hidden -FilePath "D:\zcode\agent\mentora\scripts\start-mentora.cmd" -WorkingDirectory "D:\zcode\agent\mentora"
  Start-Sleep -Seconds 8
  $ok = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  Log ("restart " + $(if ($ok) { "OK" } else { "FAILED" }))
}

# 2) UUMit 客户端检查
$uumit = Get-Process -Name "UUMit-Client" -ErrorAction SilentlyContinue
if (-not $uumit) {
  Log "UUMit-Client not running -> starting"
  Start-Process -WindowStyle Hidden -FilePath "$env:LOCALAPPDATA\Programs\UUMit\UUMit-Client.exe"
}
$conn = Get-Process -Name "uumit-connector" -ErrorAction SilentlyContinue
if (-not $conn) {
  Log "uumit-connector not running -> starting"
  Start-Process -WindowStyle Hidden -FilePath "$env:LOCALAPPDATA\Programs\UUMit\uumit-connector.exe"
}
