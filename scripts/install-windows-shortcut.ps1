# Creates "claude-village" shortcuts on the Desktop and in the Start menu that run claude-village.cmd
# minimised, so the village opens from Start / search / the taskbar. Re-run after moving the repo.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install-windows-shortcut.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'claude-village.cmd'
if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }
$electron = Join-Path $root 'desktop\node_modules\electron\dist\electron.exe'

# The shortcuts used to be called "RTS Agents" — replace them, not keep both.
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  Remove-Item -LiteralPath (Join-Path $dir 'RTS Agents.lnk') -ErrorAction SilentlyContinue
}
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'claude-village.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'claude-village.lnk')
)
foreach ($lnk in $targets) {
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $launcher
  $s.WorkingDirectory = $root
  $s.WindowStyle = 7 # minimised: the cmd window stays out of the way
  $s.Description = 'claude-village - Claude Code village'
  if (Test-Path $electron) { $s.IconLocation = "$electron,0" }
  $s.Save()
  Write-Host "Created $lnk"
}
Write-Host 'Pin it from the Start menu (right-click > Pin to taskbar) for one-click launch.'
