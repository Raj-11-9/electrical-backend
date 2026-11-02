param([switch]$KeepRunning)
$ErrorActionPreference='Stop'
$backendRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$project='srv-verify-'+([Guid]::NewGuid().ToString('N').Substring(0,8))
$reportRoot=Join-Path $backendRoot ('work/'+$project)
New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$checks=[Collections.Generic.List[object]]::new()
$saved=@{}
foreach($key in @('DB_PORT','API_PORT','STORE_PORT','ADMIN_PORT')){$saved[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
$env:DB_PORT='15432';$env:API_PORT='14000';$env:STORE_PORT='13000';$env:ADMIN_PORT='13001'
function Compose { param([string[]]$Arguments)
  $result=& docker compose -p $project -f (Join-Path $backendRoot 'compose.yaml') @Arguments 2>&1
  if($LASTEXITCODE -ne 0){throw ($result -join "`n")}
  return $result
}
function Check {param([string]$Name,[scriptblock]$Action)
  & $Action
  $checks.Add(@{name=$Name;status='passed'})
  Write-Host "PASS $Name"
}
function Wait-Healthy {
  for($i=0;$i -lt 100;$i++){
    try{$response=Invoke-RestMethod 'http://127.0.0.1:14000/api/health' -TimeoutSec 3;if($response.database -eq 'connected'){return}}catch{}
    Start-Sleep -Milliseconds 1000
  }
  throw 'Backend did not become healthy. Check the isolated project logs.'
}
Push-Location $backendRoot
$started=$false
try{
  & docker info --format '{{.ServerVersion}}'
  if($LASTEXITCODE -ne 0){throw 'Docker engine is inaccessible. Run this script from a normal terminal with Docker Desktop running.'}
  Check 'Compose configuration is valid' {Compose -Arguments @('config','--quiet') | Out-Null}
  Write-Host "Building isolated test stack: $project (ports 13000, 13001, 14000, 15432)."
  $started=$true
  Compose -Arguments @('up','--build','-d') | Out-Host
  Wait-Healthy
  $expected=(Get-Content -LiteralPath (Join-Path $backendRoot 'catalogue/srv.json') -Raw | ConvertFrom-Json).products.Count
  Check 'PostgreSQL-backed catalogue is available through NestJS' {
    $catalogue=Invoke-RestMethod 'http://127.0.0.1:14000/api/catalogue'
    if($catalogue.storage -ne 'postgresql' -or $catalogue.products.Count -ne $expected){throw 'Persisted catalogue mismatch.'}
  }
  Check 'Frontend and admin containers connect to the shared backend' {
    $store=Invoke-WebRequest 'http://127.0.0.1:13000/shop' -TimeoutSec 30
    $admin=Invoke-WebRequest 'http://127.0.0.1:13001/' -TimeoutSec 30
    if($store.StatusCode -ne 200 -or $admin.StatusCode -ne 200 -or $admin.Content -notmatch 'POSTGRESQL CATALOGUE'){throw 'An interface is not connected to PostgreSQL-backed catalogue data.'}
  }
  Check 'PostgreSQL data directory uses a named volume' {
    $container=(Compose -Arguments @('ps','-q','db') | Select-Object -Last 1).ToString().Trim()
    $mounts=& docker inspect --format '{{json .Mounts}}' $container | ConvertFrom-Json
    if(!($mounts | Where-Object {$_.Type -eq 'volume' -and $_.Destination -eq '/var/lib/postgresql/data'})){throw 'Expected persistent volume not mounted.'}
  }
  Check 'A PostgreSQL backup is written without binary-shell redirection' {
    Compose -Arguments @('exec','-T','db','pg_dump','-U','electrical','-d','electrical','-Fc','-f','/tmp/srv-verification.dump') | Out-Null
    Compose -Arguments @('cp','db:/tmp/srv-verification.dump',(Join-Path $reportRoot 'postgres-backup.dump')) | Out-Null
    if((Get-Item -LiteralPath (Join-Path $reportRoot 'postgres-backup.dump')).Length -eq 0){throw 'Backup is empty.'}
  }
  Compose -Arguments @('exec','-T','db','psql','-U','electrical','-d','electrical','-v','ON_ERROR_STOP=1','-c',"CREATE TABLE qa_persistence_marker (value text PRIMARY KEY); INSERT INTO qa_persistence_marker VALUES ('container-recreation-check');") | Out-Null
  Check 'Data survives container replacement using the existing volume' {
    Compose -Arguments @('down') | Out-Null
    Compose -Arguments @('up','-d') | Out-Null
    Wait-Healthy
    $marker=(Compose -Arguments @('exec','-T','db','psql','-U','electrical','-d','electrical','-tAc','SELECT value FROM qa_persistence_marker;') -join "`n").Trim()
    if($marker -ne 'container-recreation-check'){throw 'Persistence marker was lost.'}
    if((Invoke-RestMethod 'http://127.0.0.1:14000/api/catalogue').products.Count -ne $expected){throw 'Catalogue count changed after recreation.'}
  }
  Check 'Backup restores into a separate PostgreSQL database' {
    Compose -Arguments @('cp',(Join-Path $reportRoot 'postgres-backup.dump'),'db:/tmp/srv-verification.dump') | Out-Null
    Compose -Arguments @('exec','-T','db','createdb','-U','electrical','electrical_restore_check') | Out-Null
    Compose -Arguments @('exec','-T','db','pg_restore','-U','electrical','-d','electrical_restore_check','/tmp/srv-verification.dump') | Out-Null
    $count=(Compose -Arguments @('exec','-T','db','psql','-U','electrical','-d','electrical_restore_check','-tAc','SELECT count(*) FROM "Product";') -join "`n").Trim()
    if([int]$count -ne $expected){throw 'Restored product count mismatch.'}
  }
  @{project=$project;checks=$checks;passed=$checks.Count;backup=(Join-Path $reportRoot 'postgres-backup.dump')} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $reportRoot 'docker-report.json') -Encoding utf8
  Write-Host "Verification passed. Report and backup: $reportRoot"
}catch{
  @{project=$project;checks=$checks;error=$_.Exception.Message} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $reportRoot 'docker-report.json') -Encoding utf8
  throw
}finally{
  if($started -and !$KeepRunning){try{Compose -Arguments @('down') | Out-Null}catch{Write-Warning 'Could not stop the isolated test stack. Its project name is printed above.'}}
  foreach($key in $saved.Keys){[Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')}
  Pop-Location
}
