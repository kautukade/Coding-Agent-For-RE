[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$StateRoot = Join-Path $env:LOCALAPPDATA 'RE-Coding-Agent'
$StateFile = Join-Path $StateRoot 'state.json'
$ConfigRoot = Join-Path $StateRoot 'config'
$DashboardLauncher = Join-Path $RepoRoot 'DASHBOARD.bat'

New-Item -ItemType Directory -Path $ConfigRoot -Force | Out-Null

if (Test-Path $StateFile) {
    try {
        $state = Get-Content $StateFile -Raw | ConvertFrom-Json
        if ($state.PSObject.Properties['dashboardPort']) {
            $state.dashboardPort = 17321
        } else {
            $state | Add-Member -NotePropertyName dashboardPort -NotePropertyValue 17321
        }
        if ($state.PSObject.Properties['dashboardLauncher']) {
            $state.dashboardLauncher = $DashboardLauncher
        } else {
            $state | Add-Member -NotePropertyName dashboardLauncher -NotePropertyValue $DashboardLauncher
        }
        $state | ConvertTo-Json -Depth 20 | Set-Content $StateFile -Encoding UTF8
    } catch {
        Write-Warning "Could not update dashboard state: $($_.Exception.Message)"
    }
}

$settingsFile = Join-Path $ConfigRoot 'dashboard-settings.json'
if (-not (Test-Path $settingsFile)) {
@'
{
  "defaultProvider": "local",
  "providers": {
    "nvidia": {
      "enabled": false,
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "baseURL": "https://integrate.api.nvidia.com/v1"
    },
    "openrouter": {
      "enabled": false,
      "model": "openrouter/free",
      "baseURL": "https://openrouter.ai/api/v1"
    },
    "huggingface": {
      "enabled": false,
      "model": "openai/gpt-oss-120b:fastest",
      "baseURL": "https://router.huggingface.co/v1"
    }
  }
}
'@ | Set-Content $settingsFile -Encoding UTF8
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'RE Coding Agent Dashboard.lnk'
try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $DashboardLauncher
    $shortcut.WorkingDirectory = $RepoRoot
    $shortcut.Description = 'RE Coding Agent local dashboard and API configuration'
    $shortcut.Save()
    Write-Host "Dashboard shortcut created: $shortcutPath" -ForegroundColor Green
} catch {
    Write-Warning "Could not create dashboard shortcut: $($_.Exception.Message)"
}

Write-Host 'Dashboard configuration is ready.' -ForegroundColor Green
