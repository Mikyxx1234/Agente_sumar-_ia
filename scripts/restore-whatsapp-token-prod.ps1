# Restaura WHATSAPP_ACCESS_TOKEN em prod (token válido Meta) e reinicia o serviço.
# Uso: defina EP_WHATSAPP_ACCESS_TOKEN_OVERRIDE no ambiente OU passe -Token "EAA..."
param([string]$Token = $env:EP_WHATSAPP_ACCESS_TOKEN_OVERRIDE)

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$envPath = Join-Path $projectRoot '.env'
if (Test-Path $envPath) {
  Get-Content $envPath -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { return }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 1).Trim()
    if (-not [Environment]::GetEnvironmentVariable($k)) { Set-Item -Path "Env:$k" -Value $v }
  }
}

if (-not $Token) {
  Write-Error 'Token ausente. Passe -Token ou defina EP_WHATSAPP_ACCESS_TOKEN_OVERRIDE.'
  exit 1
}
$env:EP_WHATSAPP_ACCESS_TOKEN_OVERRIDE = $Token

& (Join-Path $scriptRoot 'easypanel-deploy-agente-sumare.ps1') -Target prod -SkipDeploy

$base = if ($env:EP_BASE_URL) { $env:EP_BASE_URL } else { 'http://168.231.99.126:3000' }
$loginBody = @{ json = @{ email = $env:EP_EMAIL; password = $env:EP_PASSWORD } } | ConvertTo-Json -Compress
$login = Invoke-RestMethod -Uri "$base/api/trpc/auth.login" -Method POST -ContentType 'application/json' -Body $loginBody -TimeoutSec 20
$headers = @{ Authorization = "Bearer $($login.result.data.json.token)" }
$deployBody = @{ json = @{ projectName = 'banco'; serviceName = 'agente_sumare' } } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "$base/api/trpc/services.app.deployService" -Method POST -Headers $headers -ContentType 'application/json' -Body $deployBody -TimeoutSec 120 | Out-Null
Write-Host 'deployService: OK — aguardando boot...'
Start-Sleep -Seconds 15
$wa = Invoke-RestMethod -Uri 'https://banco-agente-sumare.6tqx2r.easypanel.host/api/whatsapp/health' -TimeoutSec 20
Write-Host "whatsapp reachable=$($wa.reachable) phone=$($wa.displayPhoneNumber) error=$($wa.error)"
