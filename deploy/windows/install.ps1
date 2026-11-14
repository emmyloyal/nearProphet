# Makes the bot start automatically, hidden, whenever you log in to Windows.
# Uses a Scheduled Task; falls back to the Startup folder if Windows refuses the task.
$runner = "$PSScriptRoot\run-bot.ps1"
$psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$name = 'nearProphet bot'
try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
  "Installed scheduled task '$name' (runs at logon)."
} catch {
  $startup = [Environment]::GetFolderPath('Startup')
  $vbs = Join-Path $startup 'nearProphet bot.vbs'
  $cmd = 'powershell.exe ' + $psArgs.Replace('"', '""')
  Set-Content -Path $vbs -Encoding ASCII -Value "CreateObject(""WScript.Shell"").Run ""$cmd"", 0, False"
  "Scheduled task not allowed ($($_.Exception.Message)); added to the Startup folder instead: $vbs"
}
