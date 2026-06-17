# Reinicia agente_sumare no EasyPanel (carrega .env local para EP_*).
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
$base = if ($env:EP_BASE_URL) { $env:EP_BASE_URL } else { 'http://168.231.99.126:3000' }
$loginBody = @{ json = @{ email = $env:EP_EMAIL; password = $env:EP_PASSWORD } } | ConvertTo-Json -Compress
$login = Invoke-RestMethod -Uri "$base/api/trpc/auth.login" -Method POST -ContentType 'application/json' -Body $loginBody -TimeoutSec 20
$headers = @{ Authorization = "Bearer $($login.result.data.json.token)" }
$list = Invoke-RestMethod -Uri "$base/api/trpc/projects.listProjectsAndServices" -Headers $headers -TimeoutSec 40
$svc = $null
foreach ($item in @($list.result.data.json)) {
  if ($item.services) {
    $svc = $item.services | Where-Object { $_.name -eq 'agente_sumare' } | Select-Object -First 1
    if ($svc) { break }
  }
}
if ($svc.env -match '(?m)^WHATSAPP_ACCESS_TOKEN=(.{8})') {
  Write-Host "EP WHATSAPP_ACCESS_TOKEN prefix: $($Matches[1])..."
}
$deployBody = @{ json = @{ projectName = 'banco'; serviceName = 'agente_sumare' } } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "$base/api/trpc/services.app.deployService" -Method POST -Headers $headers -ContentType 'application/json' -Body $deployBody -TimeoutSec 120 | Out-Null
Write-Host 'deployService: OK'
