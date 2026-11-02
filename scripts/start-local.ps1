param([switch]$UseDatabase, [switch]$Development)
$ErrorActionPreference = 'Stop'
$backendRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$desktopRoot = Split-Path $backendRoot -Parent
$frontendRoot = Join-Path $desktopRoot 'electrical-frontend'
$adminRoot = Join-Path $desktopRoot 'electrical-admin-panel'
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$logRoot = Join-Path $backendRoot 'work/local-services'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $backendRoot 'dist/main.js'))) {
  Push-Location $backendRoot
  try { & $nodeExe 'node_modules/typescript/bin/tsc' '-p' 'tsconfig.json'; if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' } }
  finally { Pop-Location }
}
$env:NODE_ENV = 'development'
$env:HOST = '127.0.0.1'
$env:ALLOW_CATALOGUE_SNAPSHOT = if ($UseDatabase) { 'false' } else { 'true' }
$env:API_URL = 'http://127.0.0.1:4000/api'
$env:CORS_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001'
$nextCommand = if ($Development) { 'dev' } else { 'start' }
$services = @(
  @{name='backend';root=$backendRoot;port=4000;args=@('dist/main.js');url='http://127.0.0.1:4000/api/status'},
  @{name='frontend';root=$frontendRoot;port=3000;args=@('node_modules/next/dist/bin/next',$nextCommand,'--hostname','127.0.0.1','-p','3000');url='http://127.0.0.1:3000'},
  @{name='admin';root=$adminRoot;port=3001;args=@('node_modules/next/dist/bin/next',$nextCommand,'--hostname','127.0.0.1','-p','3001');url='http://127.0.0.1:3001'}
)
$started = @()
foreach ($service in $services) {
  $socket = [Net.Sockets.TcpClient]::new()
  try { $socket.Connect('127.0.0.1', $service.port); $occupied=$true } catch { $occupied=$false } finally { $socket.Dispose() }
  if ($occupied) { Write-Output "$($service.name): port $($service.port) is already in use; existing service preserved."; continue }
  $env:NODE_ENV = if ($service.name -eq 'backend' -or $Development) { 'development' } else { 'production' }
  $process = Start-Process -FilePath $nodeExe -ArgumentList $service.args -WorkingDirectory $service.root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot ($service.name+'.out.log')) -RedirectStandardError (Join-Path $logRoot ($service.name+'.err.log'))
  $started += @{name=$service.name;pid=$process.Id;root=$service.root;url=$service.url}
  Write-Output "$($service.name): started with PID $($process.Id) at $($service.url)"
}
$started | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logRoot 'services.json') -Encoding utf8
Write-Output "Mode: $(if ($UseDatabase) {'PostgreSQL required'} else {'read-only source catalogue preview; PostgreSQL is not connected'})"
Write-Output "Logs: $logRoot"
