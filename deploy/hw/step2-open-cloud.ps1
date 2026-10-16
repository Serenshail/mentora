# ============================================================
# Mentora 华为云部署 - Step2 开通云资源（用户本机执行）
# 作用：AK/SK 配置 hcloud；按序开通 VPC/子网/安全组/RDS/DCS/SWR/CCE
# 产物：deploy/hw/hw-resources.ps1（仅资源 ID/地址，不含任何密码）
# 原则：已存在的资源直接复用（幂等）；密码只交互输入绝不写盘
# ============================================================
$ErrorActionPreference = "Stop"
# hcloud 输出为 UTF-8，中文 Windows 控制台默认按 GBK 解码会乱码——本进程强制 UTF-8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$LogDir = Join-Path $RepoRoot "docs\evidence\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("step2-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
Start-Transcript -Path $LogFile | Out-Null

# ============ 配置区（按需修改，默认与 docs/DEPLOY-HUAWEICLOUD.md 一致） ============
$Region      = "cn-east-3"   # 华东-上海一
$VpcName     = "mentora-vpc"
$VpcCidr     = "192.168.0.0/16"
$SubnetName  = "mentora-subnet"
$SubnetCidr  = "192.168.0.0/24"
$SgName      = "mentora-sg"
$Az          = "$($Region)a"
$RdsName     = "mentora-rds"
$RdsFlavor   = "rds.pg.n1.large.2"   # 2vCPU/4GB 按需
$RdsVolume   = 40
$RdsPort     = 5432
$RdsDbVer    = "15"
$DcsName     = "mentora-redis"
$DcsSpecCode = "redis.single.nc.tiny.h2"  # 1GB 单机按需
$DcsCapacity = 1
$DcsEngine   = "redis"
$DcsVer      = "5.0"
$CceName     = "mentora-autopilot"
$SwrOrg      = "mentora"
# ===================================================================================

function Step-Done { param($m) Write-Host "[OK] $m" -ForegroundColor Green }
function Step-Fail { param($m) Write-Host "[FAIL] $m" -ForegroundColor Red; Write-Host "     修复后可重跑本脚本（已创建资源会复用）。日志：$LogFile" -ForegroundColor Yellow; exit 1 }
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

# 执行 hcloud 命令：成功返回解析后的 JSON，失败返回 $null（打印错误）
function Invoke-Hc {
  param([string]$ArgLine, [switch]$Quiet)
  # KooCLI 7.x：每条命令显式带 --cli-region 兜底；且 USE_ERROR/CLI_ERROR 退出码为 0，须按输出判失败
  if ($ArgLine -notmatch "--cli-region=" -and $ArgLine -notmatch "^configure") { $ArgLine = "$ArgLine --cli-region=$Region" }
  if (-not $Quiet) {
    # 回显脱敏：密码/密钥类参数只打掩码，绝不进日志
    $safe = $ArgLine -replace "(--(password|cli-secret-key|cli-access-key|sk)=)[^\s]+", '$1***'
    Step-Info "hcloud $safe"
  }
  # 预喂 3 个"b"（目标API参数）：KooCLI 对与系统参数同名的 API 参数（如 RDS 的 --password）会交互确认 a/b/c，非交互管道下 EOF 会炸
  $out = cmd /c "(echo b & echo b & echo b) | hcloud $ArgLine 2>&1" | Out-String
  # 剥 ANSI 转义（ESC[1;93m 这类——里面的 [ 会干扰 JSON 起点判断）
  $esc = [char]27
  $clean = ($out -replace ($esc + "\[[0-9;]*[A-Za-z]"), "")
  # 失败判定：非零退出码 / [USE_ERROR] 类标记 / KooCLI API 错误诊断表格（无标记，只有 +---+ 边框）
  if ($LASTEXITCODE -ne 0 -or $clean -match "\[(USE|CLI|API)_ERROR\]" -or $clean -match "\+---\+|请求诊断请参考") { Write-Host "    hcloud 失败：$($clean.Trim())" -ForegroundColor Yellow; return $null }
  # hcloud 会在 JSON 前打印版本选择等提示行——从首个 { 或 [ 截起再解析（兼容对象与数组返回）
  $iB = $clean.IndexOf("{"); $iA = $clean.IndexOf("[")
  $idx = if ($iB -ge 0 -and ($iA -lt 0 -or $iB -lt $iA)) { $iB } else { $iA }
  if ($idx -lt 0) { return $clean.Trim() }
  $json = $clean.Substring($idx)
  try { return ($json | ConvertFrom-Json) } catch {
    # JSON 后可能跟尾巴（警告等）——尝试截到最后一个 } 或 ] 再解析
    $lB = $json.LastIndexOf("}"); $lA = $json.LastIndexOf("]")
    $l = if ($lB -ge 0 -and ($lA -lt 0 -or $lB -gt $lA)) { $lB } else { $lA }
    if ($l -ge 0) { try { return ($json.Substring(0, $l + 1) | ConvertFrom-Json) } catch { } }
    return $json.Trim()
  }
}
function ConvertTo-HcArg { param($hashtable) ($hashtable.GetEnumerator() | Where-Object { $null -ne $_.Value -and "$($_.Value)" -ne "" } | ForEach-Object { "--$($_.Key)=$($_.Value)" }) -join " " }

try {
  Write-Host "=== Mentora Step2: 开通华为云资源（区域 $Region）==="

  # ---- 0. 前置：hcloud 可用 ----
  $hc = Get-Command hcloud -ErrorAction SilentlyContinue
  if (-not $hc) { $hcloudExe = Join-Path $env:USERPROFILE "hcloud-cli\hcloud.exe"; if (Test-Path $hcloudExe) { $env:Path += ";$(Split-Path $hcloudExe)" } else { Step-Fail "未检测到 hcloud，请先执行 step1-install-tools.ps1" } }

  # ---- 1. AK/SK 配置（不回显、不写盘；KooCLI 自行加密保存）----
  Step-Info "配置 AK/SK（获取方式：控制台右上角'我的凭证' → 访问密钥 → 新增）"
  $ak = Read-Host "  Access Key Id (AK)"
  $sk = Read-Secret "  Secret Access Key (SK，输入不回显)"
  if (-not $ak -or -not $sk) { Step-Fail "AK/SK 不能为空" }
  # KooCLI 7.x 参数名为 --cli-access-key/--cli-secret-key/--cli-region（旧 --ak/--sk/--region 会报"不正确的参数"且退出码 0）
  $r = Invoke-Hc "configure set --cli-access-key=$ak --cli-secret-key=$sk --cli-mode=AKSK --cli-region=$Region" -Quiet
  if ($null -eq $r) { Step-Fail "hcloud configure set 失败（AK/SK 可能无效，详见日志）" }
  $r = Invoke-Hc "configure list" -Quiet
  Step-Done "AK/SK 已配置（KooCLI 加密保存，不落明文）"

  # ---- 2. project_id ----
  $projects = Invoke-Hc "IAM KeystoneListProjects" -Quiet
  $projectId = $null
  if ($projects -and $projects.projects) {
    # KeystoneListProjects 返回的项目无 region 字段，标准区域项目名=区域名（如 cn-east-3），按 name 匹配
    $p = $projects.projects | Where-Object { $_.name -eq $Region } | Select-Object -First 1
    if ($p) { $projectId = $p.id }
  }
  if (-not $projectId) { Step-Fail "无法获取区域 $Region 的 project_id，请把日志贴回给助手排查" }
  Step-Done "project_id = $projectId"

  # ---- 3. VPC + 子网 ----
  $vpcs = Invoke-Hc "VPC ListVpcs --limit=200" -Quiet
  $vpc = $null
  if ($vpcs -and $vpcs.vpcs) { $vpc = $vpcs.vpcs | Where-Object { $_.name -eq $VpcName } | Select-Object -First 1 }
  if ($vpc) { Step-Done "VPC 已存在：$($vpc.id)" }
  else {
    $arg = ConvertTo-HcArg @{ project_id = $projectId; "vpc.name" = $VpcName; "vpc.cidr" = $VpcCidr }
    $vpc = Invoke-Hc "VPC CreateVpc $arg"
    if (-not $vpc -or -not $vpc.vpc) { Step-Fail "创建 VPC 失败（命令已打印，可把日志贴回排查）" }
    $vpc = $vpc.vpc
    Step-Done "VPC 已创建：$($vpc.id)"
  }
  Start-Sleep -Seconds 5
  $subnets = Invoke-Hc "VPC ListSubnets --vpc_id=$($vpc.id) --limit=200" -Quiet
  $subnet = $null
  if ($subnets -and $subnets.subnets) { $subnet = $subnets.subnets | Where-Object { $_.name -eq $SubnetName } | Select-Object -First 1 }
  if ($subnet) { Step-Done "子网已存在：$($subnet.id)" }
  else {
    # KooCLI 规则：POST 体参数用点路径（subnet.vpc_id），平铺 vpc_id 会被拒"不正确的参数"
    $arg = ConvertTo-HcArg @{ project_id = $projectId; "subnet.vpc_id" = $vpc.id; "subnet.name" = $SubnetName; "subnet.cidr" = $SubnetCidr; "subnet.gateway_ip" = ($SubnetCidr -replace '\.0/24$', '.1') }
    $subnet = Invoke-Hc "VPC CreateSubnet $arg"
    if (-not $subnet -or -not $subnet.subnet) { Step-Fail "创建子网失败" }
    $subnet = $subnet.subnet
    Step-Done "子网已创建：$($subnet.id)"
  }

  # ---- 4. 安全组 + 入站规则（80/443 对外；其余按需）----
  $sgs = Invoke-Hc "VPC ListSecurityGroups --limit=200" -Quiet
  $sg = $null
  if ($sgs -and $sgs.security_groups) { $sg = $sgs.security_groups | Where-Object { $_.name -eq $SgName } | Select-Object -First 1 }
  if ($sg) { Step-Done "安全组已存在：$($sg.id)" }
  else {
    # v3 API 安全组不绑 VPC（无 security_group.vpc_id 参数，传了被拒"不正确的参数"）
    $arg = ConvertTo-HcArg @{ project_id = $projectId; "security_group.name" = $SgName }
    $sg = Invoke-Hc "VPC CreateSecurityGroup $arg"
    if (-not $sg -or -not $sg.security_group) { Step-Fail "创建安全组失败" }
    $sg = $sg.security_group
    Step-Done "安全组已创建：$($sg.id)"
  }
  foreach ($port in @(80, 443)) {
    # v3 规则参数：multiport（非 port_range_min/max）+ action/priority
    $arg = ConvertTo-HcArg @{ project_id = $projectId; "security_group_rule.security_group_id" = $sg.id; "security_group_rule.direction" = "ingress"; "security_group_rule.protocol" = "tcp"; "security_group_rule.multiport" = "$port"; "security_group_rule.action" = "allow"; "security_group_rule.priority" = "1"; "security_group_rule.ethertype" = "IPv4"; "security_group_rule.remote_ip_prefix" = "0.0.0.0/0" }
    Invoke-Hc "VPC CreateSecurityGroupRule $arg" -Quiet | Out-Null
    # 409=规则已存在，忽略；其他错误不阻断（ELB 会兜底放行 80）
  }
  Step-Done "安全组入站规则已放行 80/443"

  # ---- 5. RDS PostgreSQL（异步创建 + 轮询）----
  $rdsList = Invoke-Hc "RDS ListInstances --limit=100" -Quiet
  $rds = $null
  if ($rdsList -and $rdsList.instances) { $rds = $rdsList.instances | Where-Object { $_.name -eq $RdsName } | Select-Object -First 1 }
  if ($rds) {
    Step-Done "RDS 已存在：$($rds.id)（状态 $($rds.status)）"
  } else {
    Write-Host "  RDS root 密码规则：8-32 位，至少含大写/小写/数字/特殊字符中三类，如 Mentora@2026"
    $rdsPwd = Read-Secret "  设置 RDS root 密码（输入不回显）"
    if ($rdsPwd.Length -lt 8) { Step-Fail "RDS 密码过短" }
    $arg = ConvertTo-HcArg @{
      project_id = $projectId; name = $RdsName; region = $Region
      "datastore.type" = "PostgreSQL"; "datastore.version" = $RdsDbVer
      mode = "Single"; flavor_ref = $RdsFlavor
      "volume.type" = "ULTRAHIGH"; "volume.size" = $RdsVolume
      vpc_id = $vpc.id; subnet_id = $subnet.id; security_group_id = $sg.id
      password = $rdsPwd; port = $RdsPort; availability_zone = $Az
    }
    $rds = Invoke-Hc "RDS CreateInstance $arg"
    if (-not $rds) { Step-Fail "创建 RDS 失败（命令已打印，可把日志贴回排查）" }
    $rdsList = Invoke-Hc "RDS ListInstances --limit=100" -Quiet
    $rds = $rdsList.instances | Where-Object { $_.name -eq $RdsName } | Select-Object -First 1
    Step-Done "RDS 创建任务已提交：$($rds.id)"
  }
  if ($rds.status -ne "ACTIVE") {
    Step-Info "等待 RDS 就绪（首次创建约 10-20 分钟，期间可挂着干别的）..."
    for ($i = 1; $i -le 60; $i++) {
      Start-Sleep -Seconds 30
      $rdsList = Invoke-Hc "RDS ListInstances --limit=100" -Quiet
      $rds = $rdsList.instances | Where-Object { $_.id -eq $rds.id } | Select-Object -First 1
      Write-Host "    RDS 状态：$($rds.status) ($($i*30)s)"
      if ($rds.status -eq "ACTIVE") { break }
      if ($rds.status -in @("FAILED","ABNORMAL")) { Step-Fail "RDS 进入异常状态 $($rds.status)" }
    }
    if ($rds.status -ne "ACTIVE") { Step-Fail "RDS 30 分钟未就绪，请到控制台查看（RDS → 实例管理）" }
  }
  Step-Done "RDS 就绪，内网地址 $($rds.private_ips -join ',')"

  # ---- 6. 为 RDS 绑定公网 IP（迁移/初始化脚本需要从本机访问；迁移完成后可解绑）----
  if (-not $rds.public_ips -or $rds.public_ips.Count -eq 0) {
    Step-Info "RDS 尚无公网地址。创建 EIP 并绑定（用于 step4 建表/迁移，完成后可解绑省费）..."
    $eipName = "mentora-rds-eip"
    $arg = ConvertTo-HcArg @{
      project_id = $projectId
      "publicip.type" = "5_bgp"
      "bandwidth.name" = $eipName; "bandwidth.size" = 5; "bandwidth.share_type" = "PER"; "bandwidth.charge_mode" = "bandwidth"
    }
    $eip = Invoke-Hc "EIP CreatePublicIp $arg"
    $eipAddr = $null; $eipId = $null
    if ($eip -and $eip.publicip) { $eipAddr = $eip.publicip.public_ip_address; $eipId = $eip.publicip.id }
    elseif ($eip -is [string] -and $eip -match '"public_ip_address":\s*"([^"]+)"') { $eipAddr = $Matches[1] }
    if (-not $eipAddr) {
      Write-Host "    EIP 自动创建未成功，请手动：VPC 控制台 → 弹性公网IP → 购买弹性公网IP（按带宽 5Mbit），然后 RDS 控制台 → 实例 → 连接管理 → 绑定公网地址" -ForegroundColor Yellow
    } else {
      Step-Info "EIP 已创建：$eipAddr，绑定到 RDS..."
      $bindArg = ConvertTo-HcArg @{ project_id = $projectId; instance_id = $rds.id; public_ip = $eipAddr; public_ip_id = $eipId; is_bind = "true" }
      Invoke-Hc "RDS AttachEip $bindArg" -Quiet | Out-Null
      Start-Sleep -Seconds 20
      $rdsList = Invoke-Hc "RDS ListInstances --limit=100" -Quiet
      $rds = $rdsList.instances | Where-Object { $_.id -eq $rds.id } | Select-Object -First 1
      Step-Done "RDS 公网地址：$($rds.public_ips -join ',')"
    }
  } else {
    Step-Done "RDS 公网地址：$($rds.public_ips -join ',')"
  }
  Step-Info "提醒：RDS 公网访问需在'RDS → 连接管理 → 公网带宽/白名单'放行你本机出口 IP（比赛期间可临时 0.0.0.0/0，结束后收紧）"

  # ---- 7. DCS Redis（异步创建 + 轮询）----
  $dcsList = Invoke-Hc "DCS ListInstances --limit=100" -Quiet
  $dcs = $null
  if ($dcsList -and $dcsList.instances) { $dcs = $dcsList.instances | Where-Object { $_.name -eq $DcsName } | Select-Object -First 1 }
  if ($dcs) {
    Step-Done "DCS 已存在：$($dcs.instance_id)（状态 $($dcs.status)）"
  } else {
    Write-Host "  DCS 密码规则：8-32 位，含字母与数字，如 Mentora2026"
    $dcsPwd = Read-Secret "  设置 DCS 访问密码（输入不回显）"
    # DCS：参数名 name（非 instance_name）、az_codes.[0]（非 availability_zones）、无 security_group_id
    $arg = ConvertTo-HcArg @{
      name = $DcsName; engine = $DcsEngine; engine_version = $DcsVer
      capacity = $DcsCapacity; spec_code = $DcsSpecCode
      vpc_id = $vpc.id; subnet_id = $subnet.id
      password = $dcsPwd; "az_codes.[0]" = $Az
    }
    $dcs = Invoke-Hc "DCS CreateInstance $arg"
    if (-not $dcs) { Step-Fail "创建 DCS 失败（命令已打印，可把日志贴回排查；单机规格名可按控制台可选值调整 `$DcsSpecCode）" }
    $dcsList = Invoke-Hc "DCS ListInstances --limit=100" -Quiet
    $dcs = $dcsList.instances | Where-Object { $_.name -eq $DcsName } | Select-Object -First 1
    Step-Done "DCS 创建任务已提交：$($dcs.instance_id)"
  }
  if ($dcs.status -ne "RUNNING") {
    Step-Info "等待 DCS 就绪（约 10-15 分钟）..."
    for ($i = 1; $i -le 40; $i++) {
      Start-Sleep -Seconds 30
      $dcsList = Invoke-Hc "DCS ListInstances --limit=100" -Quiet
      $dcs = $dcsList.instances | Where-Object { $_.instance_id -eq $dcs.instance_id } | Select-Object -First 1
      Write-Host "    DCS 状态：$($dcs.status) ($($i*30)s)"
      if ($dcs.status -eq "RUNNING") { break }
      if ($dcs.status -in @("CREATEFAILED","ERROR")) { Step-Fail "DCS 进入异常状态 $($dcs.status)" }
    }
    if ($dcs.status -ne "RUNNING") { Step-Fail "DCS 20 分钟未就绪，请到控制台查看（DCS → 缓存实例）" }
  }
  $dcsHost = $dcs.ip; $dcsPort = 6379
  Step-Done "DCS 就绪：${dcsHost}:${dcsPort}（REDIS_URL 用 redis://:<密码>@${dcsHost}:${dcsPort}/0，仅 VPC 内可连）"

  # ---- 8. SWR 组织（CLI 优先，失败给控制台指引）----
  $orgs = Invoke-Hc "SWR ListOrganizations" -Quiet
  $orgExists = $false
  if ($orgs) { $orgExists = ($orgs | Out-String) -match $SwrOrg }
  if ($orgExists) { Step-Done "SWR 组织已存在：$SwrOrg" }
  else {
    $arg = ConvertTo-HcArg @{ namespace = $SwrOrg }
    $r = Invoke-Hc "SWR CreateOrganization $arg" -Quiet
    if ($r -or $LASTEXITCODE -eq 0) { Step-Done "SWR 组织已创建：$SwrOrg" }
    else { Write-Host "    CLI 创建未成功，请手动：SWR 控制台 → 组织管理 → 新建组织，名称 $SwrOrg（然后重跑本脚本会识别为已存在）" -ForegroundColor Yellow }
  }

  # ---- 9. CCE Autopilot 集群（CLI 优先，失败给控制台指引）----
  $clusters = Invoke-Hc "CCE ListAutopilotClusters" -Quiet
  $cce = $null
  if ($clusters -and $clusters.items) {
    $cce = $clusters.items | Where-Object { $_.metadata.name -eq $CceName } | Select-Object -First 1
    if (-not $cce) { $cce = $clusters.items | Where-Object { $_.metadata.name -eq $CceName } | Select-Object -First 1 }
  }
  if ($cce) { Step-Done "CCE Autopilot 集群已存在：$($cce.metadata.id)" }
  else {
    Step-Info "尝试 CLI 创建 Autopilot 集群 $CceName ..."
    $arg = ConvertTo-HcArg @{
      kind = "Cluster"; apiVersion = "v3"
      "metadata.name" = $CceName
      "spec.type" = "virtualmachine"; "spec.flavor" = "autopilot"; "spec.version" = "v1.28"
      "spec.hostNetwork.vpc" = $vpc.id; "spec.hostNetwork.subnet" = $subnet.id
      "spec.containerNetwork.cidr" = "172.16.0.0/20"
    }
    $r = Invoke-Hc "CCE CreateAutopilotCluster $arg" -Quiet
    if ($r -or $LASTEXITCODE -eq 0) { Step-Done "CCE 创建任务已提交（Autopilot 约 10 分钟）" }
    else {
      Write-Host "    CLI 创建未成功（参数或版本差异）。请手动开通：" -ForegroundColor Yellow
      Write-Host "      CCE 控制台 → 购买集群 → 标准 Autopilot 集群 → 区域 $Region / VPC $VpcName / 子网 $SubnetName → 其余默认购买"
      Write-Host "      完成后重跑本脚本将自动识别并继续。"
    }
  }
  $clusters = Invoke-Hc "CCE ListAutopilotClusters" -Quiet
  $cceId = $null
  if ($clusters -and $clusters.items) { $c0 = $clusters.items | Where-Object { $_.metadata.name -eq $CceName } | Select-Object -First 1; if ($c0) { $cceId = $c0.metadata.id } }

  # ---- 10. 下载 kubeconfig（集群就绪后）----
  $kubeConfig = Join-Path $env:USERPROFILE ".kube\config"
  if ($cceId) {
    Step-Info "尝试获取集群 kubeconfig..."
    $r = Invoke-Hc "CCE CreateKubernetesClusterCert --cluster_id=$cceId --duration=365" -Quiet
    $kcOk = $false
    if ($r -is [string] -and $r -match "apiVersion:") {
      New-Item -ItemType Directory -Force -Path (Split-Path $kubeConfig) | Out-Null
      if (Test-Path $kubeConfig) { Copy-Item $kubeConfig "$kubeConfig.bak-$(Get-Date -Format yyyyMMddHHmmss)" }
      [IO.File]::WriteAllText($kubeConfig, $r, (New-Object Text.UTF8Encoding $false))
      $kcOk = $true
    }
    if ($kcOk) { Step-Done "kubeconfig 已写入 $kubeConfig" }
    else { Write-Host "    自动获取未成功。请手动：CCE 控制台 → 集群 → 概览 → 'kubectl'按钮 → 下载 kubeconfig 覆盖 $kubeConfig（或者粘贴到该路径）" -ForegroundColor Yellow }
  }

  # ---- 11. MaaS 订阅（纯控制台项）+ FunctionGraph 提示 ----
  Write-Host ""
  Write-Host "—— 以下两项需控制台人工操作（CLI 不开放），完成后按回车继续 ——" -ForegroundColor Magenta
  Read-Host "  [1]（可跳过）MaaS 订阅+API Key：当前 AI_PROVIDER=custom 走自备模型端点，不需要；仅当切回 maas 通道才做 → 回车继续"
  Read-Host "  [2] FunctionGraph + SMN 发信中继可暂缓（EMAIL_CHANNEL=resend 时不需要；要做华为发信时再看 deploy/functiongraph-cron.md）→ 回车继续"

  # ---- 12. 生成资源清单文件（不含任何密码/密钥）----
  $resPath = Join-Path $PSScriptRoot "hw-resources.ps1"
  $rdsHostPub = if ($rds.public_ips -and $rds.public_ips.Count -gt 0) { $rds.public_ips[0] } else { "" }
  $rdsHostPri = if ($rds.private_ips -and $rds.private_ips.Count -gt 0) { $rds.private_ips[0] } else { "" }
  $content = @"
# hw-resources.ps1 - Step2 生成的资源清单（仅 ID/地址，无凭据）
# 由 step2-open-cloud.ps1 自动生成；已加入 .gitignore，请勿提交
`$Region = "$Region"
`$ProjectId = "$projectId"
`$VpcId = "$($vpc.id)"
`$SubnetId = "$($subnet.id)"
`$SecurityGroupId = "$($sg.id)"
`$RdsInstanceId = "$($rds.id)"
`$RdsHostPublic = "$rdsHostPub"
`$RdsHostPrivate = "$rdsHostPri"
`$RdsPort = $RdsPort
`$DcsInstanceId = "$($dcs.instance_id)"
`$DcsHost = "$dcsHost"
`$DcsPort = $dcsPort
`$SwrOrg = "$SwrOrg"
`$CceClusterId = "$cceId"
`$CceClusterName = "$CceName"
"@
  [IO.File]::WriteAllText($resPath, $content, (New-Object Text.UTF8Encoding $true))
  Step-Done "资源清单已生成：$resPath（已 gitignore）"

  # ---- 13. 更新仓库 .gitignore ----
  $gitignore = Join-Path $RepoRoot ".gitignore"
  if ((Test-Path $gitignore) -and -not ((Get-Content $gitignore -Raw) -match "hw-resources\.ps1")) {
    Add-Content $gitignore "`ndeploy/hw/hw-resources.ps1"
    Step-Done "已将 hw-resources.ps1 加入 .gitignore"
  }

  Write-Host ""
  Write-Host "=== Step2 完成。下一步：step3-build-push.ps1（构建镜像并推送 SWR）===" -ForegroundColor Cyan
  Write-Host "日志已存：$LogFile"
} finally {
  Stop-Transcript | Out-Null
}