# Uso local apenas — credenciais via argumentos ou env EP_EMAIL / EP_PASSWORD
param(
  [string]$BaseUrl = 'http://168.231.99.126:3000',
  [string]$Email = $env:EP_EMAIL,
  [string]$Password = $env:EP_PASSWORD,
  [string]$Project = 'banco',
  [string]$Service = 'agente_sumare'
)

if (-not $Email -or -not $Password) {
  Write-Error 'Defina EP_EMAIL e EP_PASSWORD (ou passe -Email / -Password).'
  exit 1
}

function Set-EnvKey([string]$text, [string]$key, [string]$value) {
  if ($text -match "(?m)^\s*$([regex]::Escape($key))\s*=.*$") {
    return [regex]::Replace($text, "(?m)^\s*$([regex]::Escape($key))\s*=.*$", "$key=$value")
  }
  return ($text.TrimEnd() + "`r`n$key=$value`r`n")
}

$loginBody = @{ json = @{ email = $Email; password = $Password } } | ConvertTo-Json -Compress
$login = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/auth.login" -Method POST -ContentType 'application/json' -Body $loginBody -TimeoutSec 20
$token = $login.result.data.json.token
$headers = @{ Authorization = "Bearer $token" }

$list = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/projects.listProjectsAndServices" -Headers $headers -TimeoutSec 40
$svc = $null
foreach ($item in $list.result.data.json) {
  if (-not $item.services) { continue }
  foreach ($s in $item.services) {
    if ($s.name -eq $Service) { $svc = $s; break }
  }
  if ($svc) { break }
}
if (-not $svc) {
  Write-Error "Servico $Service nao encontrado."
  exit 1
}

$envText = $svc.env
$captacaoToken = $env:SUMARE_CAPTACAO_TOKEN
$envPairs = @(
  @('INATIVIDADE_ENABLED', 'false'),
  @('INSCRICAO_POST_FORM_SCHEDULER_ENABLED', 'false'),
  @('AGENT_FLUSH_CLAIM_ENABLED', 'true'),
  @('AGENT_FLUSH_CLAIM_SEC', '90'),
  @('WHATSAPP_OUTBOUND_DEDUPE_SEC', '180'),
  @('AGENT_OUTBOUND_COOLDOWN_SEC', '45'),
  @('AGENT_REPLY_COOLDOWN_SEC', '60'),
  @('KOMMO_SCHEDULER_DEBOUNCE_SEC', '8'),
  @('POST_FORM_SEND_REQUIRE_REDIS', 'true'),
  @('POST_FORM_SEND_GUARD_SEC', '300'),
  @('SUMARE_CAPTACAO_ENABLED', 'true'),
  @('SUMARE_CAPTACAO_BASE_URL', 'https://api-captacao.sumare.edu.br'),
  @('SUMARE_CONTRATO_PORTAL_URL', 'https://sumare.edu.br/vem-pra-sumare/vestibular/contrato'),
  @('SUMARE_CAPTACAO_TEST_ALLOW', 'true')
)
if ($env:SUMARE_CAPTACAO_CURSO_MAP) {
  $envPairs += ,@('SUMARE_CAPTACAO_CURSO_MAP', $env:SUMARE_CAPTACAO_CURSO_MAP)
}
if ($captacaoToken) {
  $envPairs += ,@('SUMARE_CAPTACAO_TOKEN', $captacaoToken)
  Write-Host 'env SUMARE_CAPTACAO_TOKEN=*** (definido via env)'
} else {
  Write-Warning 'SUMARE_CAPTACAO_TOKEN nao definido — defina `$env:SUMARE_CAPTACAO_TOKEN` antes do deploy para matricula API.'
}
foreach ($pair in $envPairs) {
  $envText = Set-EnvKey $envText $pair[0] $pair[1]
  $logVal = if ($pair[0] -match 'TOKEN|KEY|PASSWORD|SECRET') { '***' } else { $pair[1] }
  Write-Host "env $($pair[0])=$logVal"
}

$updateBody = @{ json = @{ projectName = $Project; serviceName = $Service; env = $envText } } | ConvertTo-Json -Depth 5 -Compress
try {
  $upd = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/services.app.updateEnv" -Method POST -Headers $headers -ContentType 'application/json' -Body $updateBody -TimeoutSec 90
  Write-Host 'updateEnv: OK'
} catch {
  $updateBody2 = @{ json = @{ projectName = $Project; serviceName = $Service; env = @{ content = $envText } } } | ConvertTo-Json -Depth 5 -Compress
  $upd = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/services.app.updateEnv" -Method POST -Headers $headers -ContentType 'application/json' -Body $updateBody2 -TimeoutSec 90
  Write-Host 'updateEnv (content): OK'
}

$deployBody = @{ json = @{ projectName = $Project; serviceName = $Service } } | ConvertTo-Json -Compress
$dep = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/services.app.deployService" -Method POST -Headers $headers -ContentType 'application/json' -Body $deployBody -TimeoutSec 120
Write-Host 'deployService: OK'

Start-Sleep -Seconds 8
$list2 = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/projects.listProjectsAndServices" -Headers $headers -TimeoutSec 40
$svc2 = $null
foreach ($item in $list2.result.data.json) {
  if (-not $item.services) { continue }
  foreach ($s in $item.services) {
    if ($s.name -eq $Service) { $svc2 = $s; break }
  }
  if ($svc2) { break }
}
$sha = $svc2.commit.sha
Write-Host "commit implantado: $($sha.Substring(0, 12))"
$checks = @(
  'INATIVIDADE_ENABLED',
  'AGENT_FLUSH_CLAIM_ENABLED',
  'WHATSAPP_OUTBOUND_DEDUPE_SEC',
  'SUMARE_CAPTACAO_ENABLED',
  'SUMARE_CAPTACAO_TOKEN'
)
foreach ($k in $checks) {
  if ($svc2.env -match "(?m)^$k=(.*)$") {
    $val = $Matches[1].Trim()
    if ($k -match 'TOKEN|KEY|PASSWORD|SECRET') { $val = if ($val) { '***' } else { '(vazio)' } }
    Write-Host "verificado $k=$val"
  } else {
    Write-Host "AVISO: $k ausente no env do servico"
  }
}
