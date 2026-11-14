# Keeps nearProphet running on this PC: backs up the database, starts the bot, and restarts it
# if it ever stops. Started hidden at Windows logon by install.ps1. Logs go to logs\bot-YYYYMMDD.log
$app = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $app
New-Item -ItemType Directory -Force -Path logs, backups | Out-Null

# Only one copy may run: two copies fight over Telegram messages.
$mutex = New-Object System.Threading.Mutex($false, 'Local\nearProphetBot')
if (-not $mutex.WaitOne(0)) { exit 0 }

$lastBackup = [datetime]::MinValue
while ($true) {
  $log = Join-Path $app ("logs\bot-" + (Get-Date -Format 'yyyyMMdd') + '.log')
  Get-ChildItem logs -Filter 'bot-*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -ErrorAction SilentlyContinue
  if (((Get-Date) - $lastBackup).TotalHours -ge 20) {
    cmd /c "node_modules\.bin\tsx.cmd scripts\backup.ts >> `"$log`" 2>&1"
    $lastBackup = Get-Date
  }
  cmd /c "echo ==== %date% %time% starting bot>> `"$log`""
  cmd /c "node_modules\.bin\tsx.cmd src\index.ts >> `"$log`" 2>&1"
  cmd /c "echo ==== %date% %time% bot stopped (exit $LASTEXITCODE), restarting in 15s>> `"$log`""
  Start-Sleep -Seconds 15
}
