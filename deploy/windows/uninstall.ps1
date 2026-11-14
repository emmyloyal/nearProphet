# Stops the bot starting at logon (does not stop a running bot; use stop-bot.ps1 for that).
try { Unregister-ScheduledTask -TaskName 'nearProphet bot' -Confirm:$false -ErrorAction Stop; 'Removed scheduled task.' } catch {}
$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'nearProphet bot.vbs'
if (Test-Path $vbs) { Remove-Item $vbs -Force; 'Removed Startup entry.' }
