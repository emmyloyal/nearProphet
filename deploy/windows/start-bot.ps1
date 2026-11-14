# Starts the bot now, hidden in the background (same as what happens at logon).
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSScriptRoot\run-bot.ps1`"")
"Bot starting in the background. Logs: $((Resolve-Path "$PSScriptRoot\..\..").Path)\logs"
