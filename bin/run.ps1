# Copied to the nightshift home (%USERPROFILE%\.nightshift\run.ps1) by nightshift.ps1. Runs a script
# from the installed nightshift plugin, wherever its current version is installed, so the pre-push
# hooks and Windows scheduled tasks that call it survive plugin updates.
#
#   run.ps1 <script.ps1> [arguments...]
$installed = Join-Path $env:USERPROFILE '.claude\plugins\installed_plugins.json'
$entry = (Get-Content $installed -Raw | ConvertFrom-Json).plugins.'nightshift@nightshift' | Select-Object -First 1
if (-not $entry) { Write-Error 'The nightshift plugin is not installed.'; exit 1 }
$script = $args[0]
# Always an array: one leftover argument would otherwise be a string, and @ splats a string one
# character at a time.
$rest = @($args | Select-Object -Skip 1)
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $entry.installPath "bin\$script") @rest
exit $LASTEXITCODE
