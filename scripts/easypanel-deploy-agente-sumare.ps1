# Deploy EasyPanel — Agente Sumaré (staging ou produção)
#
# Uso (credenciais no .env da raiz — gitignored, não sobe pro GitHub):
#   EP_EMAIL=...
#   EP_PASSWORD=...
#   .\scripts\easypanel-deploy-agente-sumare.ps1 -Target prod
#   .\scripts\easypanel-deploy-agente-sumare.ps1 -Target staging
#
# Alternativa: $env:EP_EMAIL / $env:EP_PASSWORD na sessão atual.
#
# Pré-requisito staging: criar no EasyPanel o serviço `agente_sumare_staging`
# (clone do agente_sumare, mesmo repositório Git, rede interna igual).
# Ver docs/AMBIENTE-STAGING.md

param(
  [ValidateSet('staging', 'prod')]
  [string]$Target = 'staging',
  [string]$BaseUrl = 'http://168.231.99.126:3000',
  [string]$Email = $env:EP_EMAIL,
  [string]$Password = $env:EP_PASSWORD,
  [string]$Project = 'banco',
  [string]$Service = '',
  [string[]]$TestLeadIds = @(),
  [switch]$CanaryTest,
  [switch]$SkipDeploy
)

function Import-ProjectDotEnv {
  param([string]$RootDir)
  $envPath = Join-Path $RootDir '.env'
  if (-not (Test-Path $envPath)) { return }
  Get-Content $envPath -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { return }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim()
    if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    if (-not [Environment]::GetEnvironmentVariable($key)) {
      Set-Item -Path "Env:$key" -Value $val
    }
  }
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
Import-ProjectDotEnv -RootDir $projectRoot

if (-not $Email) { $Email = $env:EP_EMAIL }
if (-not $Password) { $Password = $env:EP_PASSWORD }
if ($env:EP_BASE_URL -and $BaseUrl -eq 'http://168.231.99.126:3000') {
  $BaseUrl = $env:EP_BASE_URL
}

if (-not $Email -or -not $Password) {
  Write-Error 'Defina EP_EMAIL e EP_PASSWORD no .env (raiz do projeto, gitignored) ou passe -Email / -Password.'
  exit 1
}

$profiles = @{
  staging = @{
    Service = 'agente_sumare_staging'
    DefaultTestLeadIds = '23841399'
    EnvOverrides = [ordered]@{
      APP_ENV = 'staging'
      KOMMO_SCHEDULER_WEBHOOK_ORPHAN_FLUSH = 'false'
      KOMMO_SCHEDULER_VERBOSE = 'true'
      KOMMO_AGENT_TEST_LEAD_IDS = ''  # preenchido abaixo
      EVOLUTION_INGEST_PHONE_ALLOWLIST = ''  # opcional: $env:STAGING_PHONE_ALLOWLIST
      INATIVIDADE_ENABLED = 'false'
      INSCRICAO_POST_FORM_SCHEDULER_ENABLED = 'false'
      AGENT_FLUSH_CLAIM_ENABLED = 'true'
      AGENT_FLUSH_CLAIM_SEC = '90'
      WHATSAPP_OUTBOUND_DEDUPE_SEC = '180'
      AGENT_OUTBOUND_COOLDOWN_SEC = '45'
      AGENT_REPLY_COOLDOWN_SEC = '60'
      KOMMO_SCHEDULER_DEBOUNCE_SEC = '8'
      REDIS_URL = 'redis://evolution-api-redis:6379'
      POST_FORM_SEND_REQUIRE_REDIS = 'true'
      POST_FORM_SEND_GUARD_SEC = '300'
      AGENT_QUEUE_SESSION_ENABLED = 'true'
      AGENT_QUEUE_SESSION_CLEAR_MEMORY = 'true'
      AGENT_QUEUE_SESSION_REENTRY_GRACE_SEC = '120'
      AGENT_DB_OVERRIDES_ENABLED = 'true'
      KOMMO_INBOUND_POLL_ENABLED = 'true'
      KOMMO_INBOUND_POLL_MODE = 'notes'
      SCOPE_BLOCK_REQUIRE_NO_CONTEXT = 'true'
      SUMARE_CAPTACAO_ENABLED = 'true'
      SUMARE_CAPTACAO_BASE_URL = 'https://api-captacao.sumare.edu.br'
      SUMARE_CONTRATO_PORTAL_URL = 'https://sumare.edu.br/vem-pra-sumare/vestibular/contrato'
      SUMARE_CAPTACAO_TEST_ALLOW = 'true'
      FEEDBACK_JOB_ENABLED = 'false'
      EVOLUTION_INSTANCE = 'SUMARE_IA'
    }
  }
  prod = @{
    Service = 'agente_sumare'
    DefaultTestLeadIds = ''
    EnvOverrides = [ordered]@{
      APP_ENV = 'production'
      NODE_ENV = 'production'
      HOST = '0.0.0.0'
      PORT = '8000'
      KOMMO_SCHEDULER_ENABLED = 'true'
      KOMMO_SCHEDULER_WEBHOOK_ORPHAN_FLUSH = 'false'
      INATIVIDADE_ENABLED = 'false'
      INSCRICAO_POST_FORM_SCHEDULER_ENABLED = 'false'
      AGENT_FLUSH_CLAIM_ENABLED = 'true'
      AGENT_FLUSH_CLAIM_SEC = '90'
      WHATSAPP_OUTBOUND_DEDUPE_SEC = '180'
      AGENT_OUTBOUND_COOLDOWN_SEC = '45'
      AGENT_REPLY_COOLDOWN_SEC = '60'
      KOMMO_SCHEDULER_DEBOUNCE_SEC = '8'
      KOMMO_AGENT_TEST_LEAD_IDS = ''
      REDIS_URL = 'redis://evolution-api-redis:6379'
      POST_FORM_SEND_REQUIRE_REDIS = 'true'
      POST_FORM_SEND_GUARD_SEC = '300'
      AGENT_QUEUE_SESSION_ENABLED = 'true'
      AGENT_QUEUE_SESSION_CLEAR_MEMORY = 'true'
      AGENT_QUEUE_SESSION_REENTRY_GRACE_SEC = '120'
      AGENT_DB_OVERRIDES_ENABLED = 'true'
      KOMMO_INBOUND_POLL_ENABLED = 'true'
      KOMMO_INBOUND_POLL_MODE = 'notes'
      SCOPE_BLOCK_REQUIRE_NO_CONTEXT = 'true'
      SUMARE_CAPTACAO_ENABLED = 'true'
      SUMARE_CAPTACAO_BASE_URL = 'https://api-captacao.sumare.edu.br'
      SUMARE_CONTRATO_PORTAL_URL = 'https://sumare.edu.br/vem-pra-sumare/vestibular/contrato'
      SUMARE_CAPTACAO_TEST_ALLOW = 'false'
      EVOLUTION_INSTANCE = 'SUMARE_IA'
    }
  }
}

$profile = $profiles[$Target]
if (-not $Service) { $Service = $profile.Service }

$testIds = if ($TestLeadIds.Length -gt 0) {
  ($TestLeadIds -join ',')
} elseif ($CanaryTest) {
  if ($env:KOMMO_AGENT_TEST_LEAD_IDS) { $env:KOMMO_AGENT_TEST_LEAD_IDS } else { '23841399' }
} elseif ($env:KOMMO_AGENT_TEST_LEAD_IDS) {
  $env:KOMMO_AGENT_TEST_LEAD_IDS
} else {
  $profile.DefaultTestLeadIds
}
$profile.EnvOverrides['KOMMO_AGENT_TEST_LEAD_IDS'] = $testIds

function Get-EasyPanelService {
  param($ListData, [string]$ProjectName, [string]$ServiceName)
  if ($ListData.services) {
    return $ListData.services | Where-Object {
      $_.projectName -eq $ProjectName -and $_.name -eq $ServiceName
    } | Select-Object -First 1
  }
  foreach ($item in @($ListData)) {
    if (-not $item.services) { continue }
    foreach ($s in $item.services) {
      if ($s.name -eq $ServiceName) { return $s }
    }
  }
  return $null
}

if ($env:STAGING_PHONE_ALLOWLIST -and $Target -eq 'staging') {
  $profile.EnvOverrides['EVOLUTION_INGEST_PHONE_ALLOWLIST'] = $env:STAGING_PHONE_ALLOWLIST
}

function Set-EnvKey([string]$text, [string]$key, [string]$value) {
  if ($text -match "(?m)^\s*$([regex]::Escape($key))\s*=.*$") {
    return [regex]::Replace($text, "(?m)^\s*$([regex]::Escape($key))\s*=.*$", "$key=$value")
  }
  return ($text.TrimEnd() + "`r`n$key=$value`r`n")
}

function Remove-EnvKey([string]$text, [string]$key) {
  return [regex]::Replace($text, "(?m)^\s*$([regex]::Escape($key))\s*=.*\r?\n?", '')
}

Write-Host "=== Deploy EasyPanel | target=$Target | service=$Service | project=$Project ==="

# Pré-deploy: testes E2E do fluxo de inscrição (tools de ação + reply guard).
# Aborta se algum cenário falhar — evita subir regressão para staging/prod.
if (-not $SkipDeploy) {
  Write-Host "[pre-deploy] rodando test:inscricao-flow..."
  Push-Location $projectRoot
  try {
    & node scripts/test-inscricao-flow.mjs
    if ($LASTEXITCODE -ne 0) {
      Write-Error "test:inscricao-flow FALHOU (exit=$LASTEXITCODE). Corrija antes do deploy."
      exit 1
    }
    Write-Host "[pre-deploy] test:inscricao-flow OK"

    Write-Host "[pre-deploy] rodando test:outbound-dedupe-race..."
    & node scripts/test-outbound-dedupe-race.mjs
    if ($LASTEXITCODE -ne 0) {
      Write-Error "test:outbound-dedupe-race FALHOU (exit=$LASTEXITCODE). Corrija antes do deploy."
      exit 1
    }
    Write-Host "[pre-deploy] test:outbound-dedupe-race OK"

    Write-Host "[pre-deploy] rodando test:kommo-rate-limiter..."
    & node scripts/test-kommo-rate-limiter.mjs
    if ($LASTEXITCODE -ne 0) {
      Write-Error "test:kommo-rate-limiter FALHOU (exit=$LASTEXITCODE). O limite de 7 req/s do Kommo PRECISA ser respeitado."
      exit 1
    }
    Write-Host "[pre-deploy] test:kommo-rate-limiter OK"
  } finally {
    Pop-Location
  }
}

$loginBody = @{ json = @{ email = $Email; password = $Password } } | ConvertTo-Json -Compress
$login = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/auth.login" -Method POST -ContentType 'application/json' -Body $loginBody -TimeoutSec 20
$token = $login.result.data.json.token
$headers = @{ Authorization = "Bearer $token" }

$list = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/projects.listProjectsAndServices" -Headers $headers -TimeoutSec 40
$svc = Get-EasyPanelService -ListData $list.result.data.json -ProjectName $Project -ServiceName $Service
if (-not $svc) {
  Write-Error "Servico '$Service' nao encontrado no projeto '$Project'. Confira no painel: $BaseUrl/projects/$Project/app/$Service"
  exit 1
}
Write-Host "servico EP: projeto=$($svc.projectName) app=$($svc.name) repo=$($svc.source.owner)/$($svc.source.repo) ref=$($svc.source.ref)"

$envText = $svc.env
foreach ($kv in $profile.EnvOverrides.GetEnumerator()) {
  $envText = Set-EnvKey $envText $kv.Key $kv.Value
  $logVal = if ($kv.Key -match 'TOKEN|KEY|PASSWORD|SECRET') { '***' } else { $kv.Value }
  Write-Host "env $($kv.Key)=$logVal"
}

# Funil fixo no código — CSV conflitante (106377088 = inatividade) gera warn e confusão.
if ($Target -eq 'prod' -and $envText -match '(?m)^\s*KOMMO_AGENT_STATUS_IDS\s*=') {
  $envText = Remove-EnvKey $envText 'KOMMO_AGENT_STATUS_IDS'
  Write-Host 'env KOMMO_AGENT_STATUS_IDS=(removido — funil fixo no código)'
}

if ($env:SUMARE_CAPTACAO_TOKEN) {
  $envText = Set-EnvKey $envText 'SUMARE_CAPTACAO_TOKEN' $env:SUMARE_CAPTACAO_TOKEN
  Write-Host 'env SUMARE_CAPTACAO_TOKEN=***'
} elseif ($Target -eq 'prod') {
  Write-Warning 'SUMARE_CAPTACAO_TOKEN nao definido — matricula API pode falhar em prod.'
}
# NUNCA sobrescrever WHATSAPP_ACCESS_TOKEN em prod a partir do .env local — token Meta
# é por ambiente; sobrescrever quebrou envio (OAuth 190) em 16/06/2026.
# Para atualizar token em prod: cole manualmente no EasyPanel ou defina
# EP_WHATSAPP_ACCESS_TOKEN_OVERRIDE na sessão antes do deploy.
if ($Target -eq 'prod' -and $env:EP_WHATSAPP_ACCESS_TOKEN_OVERRIDE) {
  $envText = Set-EnvKey $envText 'WHATSAPP_ACCESS_TOKEN' $env:EP_WHATSAPP_ACCESS_TOKEN_OVERRIDE
  Write-Host 'env WHATSAPP_ACCESS_TOKEN=*** (override explícito EP_WHATSAPP_ACCESS_TOKEN_OVERRIDE)'
} elseif ($Target -ne 'prod' -and $env:WHATSAPP_ACCESS_TOKEN) {
  $envText = Set-EnvKey $envText 'WHATSAPP_ACCESS_TOKEN' $env:WHATSAPP_ACCESS_TOKEN
  Write-Host 'env WHATSAPP_ACCESS_TOKEN=*** (staging/local)'
}

if ($env:SUMARE_CAPTACAO_CURSO_MAP) {
  $envText = Set-EnvKey $envText 'SUMARE_CAPTACAO_CURSO_MAP' $env:SUMARE_CAPTACAO_CURSO_MAP
  Write-Host 'env SUMARE_CAPTACAO_CURSO_MAP=(definido)'
}

# Sincroniza do .env local chaves que existem no PC (gitignored) — nao sobrescreve EP_* de login
$syncFromLocal = @(
  'SUMARE_CAPTACAO_TOKEN', 'KOMMO_AGENT_PIPELINE_ID', 'KOMMO_AGENT_STATUS_ID',
  'KOMMO_SALESBOT_FORMULARIO_SUM_ID', 'KOMMO_SALESBOT_MATRICULA_POS_FORM_ID', 'KOMMO_SALESBOT_DISTRIBUIR_ID'
)
foreach ($syncKey in $syncFromLocal) {
  $localVal = [Environment]::GetEnvironmentVariable($syncKey)
  if ($localVal) {
    $envText = Set-EnvKey $envText $syncKey $localVal
    $logVal = if ($syncKey -match 'TOKEN|KEY|PASSWORD|SECRET') { '***' } else { $localVal }
    Write-Host "sync .env -> EP $syncKey=$logVal"
  }
}

$updateBody = @{ json = @{ projectName = $Project; serviceName = $Service; env = $envText } } | ConvertTo-Json -Depth 5 -Compress
try {
  $null = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/services.app.updateEnv" -Method POST -Headers $headers -ContentType 'application/json' -Body $updateBody -TimeoutSec 90
  Write-Host 'updateEnv: OK'
} catch {
  $updateBody2 = @{ json = @{ projectName = $Project; serviceName = $Service; env = @{ content = $envText } } } | ConvertTo-Json -Depth 5 -Compress
  $null = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/services.app.updateEnv" -Method POST -Headers $headers -ContentType 'application/json' -Body $updateBody2 -TimeoutSec 90
  Write-Host 'updateEnv (content): OK'
}

if (-not $SkipDeploy) {
  $deployBody = @{ json = @{ projectName = $Project; serviceName = $Service } } | ConvertTo-Json -Compress
  $null = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/services.app.deployService" -Method POST -Headers $headers -ContentType 'application/json' -Body $deployBody -TimeoutSec 120
  Write-Host 'deployService: OK'
  Start-Sleep -Seconds 8
} else {
  Write-Host 'deployService: SKIP (-SkipDeploy)'
}

$list2 = Invoke-RestMethod -Uri "$BaseUrl/api/trpc/projects.listProjectsAndServices" -Headers $headers -TimeoutSec 40
$svc2 = Get-EasyPanelService -ListData $list2.result.data.json -ProjectName $Project -ServiceName $Service

if ($svc2.commit.sha) {
  Write-Host "commit implantado: $($svc2.commit.sha.Substring(0, 12))"
}

$checks = @(
  'APP_ENV',
  'AGENT_DB_OVERRIDES_ENABLED',
  'KOMMO_AGENT_TEST_LEAD_IDS',
  'KOMMO_SCHEDULER_WEBHOOK_ORPHAN_FLUSH',
  'SUMARE_CAPTACAO_TEST_ALLOW',
  'AGENT_QUEUE_SESSION_ENABLED'
)
foreach ($k in $checks) {
  if ($svc2.env -match "(?m)^$k=(.*)$") {
    $val = $Matches[1].Trim()
    Write-Host "verificado $k=$val"
  } else {
    Write-Host "AVISO: $k ausente no env do servico"
  }
}

Write-Host "=== Concluido ($Target) ==="
