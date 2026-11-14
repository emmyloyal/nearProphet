# Stops the bot and its keeper loop on this PC (it starts again at next logon, or with start-bot.ps1).
$app = (Resolve-Path "$PSScriptRoot\..\..").Path
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*run-bot.ps1*') -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*index.ts*' -and $_.CommandLine -like "*$app*")
} | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; "stopped $($_.Name) $($_.ProcessId)" } catch {}
}
