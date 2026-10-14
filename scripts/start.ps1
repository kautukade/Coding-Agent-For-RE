[CmdletBinding()]
param(
    [string]$ProjectPath
)

$ErrorActionPreference = 'Stop'
$StateRoot = Join-Path $env:LOCALAPPDATA 'RE-Coding-Agent'
$StateFile = Join-Path $StateRoot 'state.json'
$ConfigRoot = Join-Path $StateRoot 'config'
$SecretsFile = Join-Path $ConfigRoot 'provider-secrets.json'

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $extra = @(
        (Join-Path $env:APPDATA 'npm'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama'),
        'C:\Program Files\nodejs'
    ) -join ';'
    $env:Path = "$machine;$user;$extra"
}

function Normalize-OllamaClientHost([string]$HostValue) {
    if ($HostValue -match '^(0\.0\.0\.0|\[::\]|::):(\d+)$') {
        return "127.0.0.1:$($Matches[2])"
    }
    if ($HostValue -match '^localhost:(\d+)$') {
        return "127.0.0.1:$($Matches[1])"
    }
    return $HostValue
}

function Test-OllamaApi([string]$HostValue) {
    $clientHost = Normalize-OllamaClientHost $HostValue
    try {
        $null = Invoke-RestMethod -Uri "http://$clientHost/api/tags" -TimeoutSec 3
        return $true
    } catch {
        return $false
    }
}

function Import-ProviderSecrets {
    if (-not (Test-Path $SecretsFile)) { return }
    try {
        $secrets = Get-Content $SecretsFile -Raw | ConvertFrom-Json
        foreach ($property in $secrets.PSObject.Properties) {
            if (-not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
            }
        }
    } catch {
        Write-Warning "Could not load dashboard provider credentials: $($_.Exception.Message)"
    }
}

Refresh-Path

if (-not (Test-Path $StateFile)) {
    Write-Host 'RE Coding Agent is not installed yet. Run INSTALL.bat first.' -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

$state = Get-Content $StateFile -Raw | ConvertFrom-Json

$env:OLLAMA_HOST = [string]$state.ollamaHost
$env:GHIDRA_INSTALL_DIR = [string]$state.ghidraInstallDir
$env:JAVA_HOME = [string]$state.javaHome
$env:REA_ANALYSIS_PROVIDER = 'ghidra'
$env:REA_GHIDRA_STARTUP_TIMEOUT_MS = '180000'
$env:OPENCODE_CONFIG = [string]$state.openCodeConfig
Import-ProviderSecrets

if (-not (Test-Path $env:OPENCODE_CONFIG)) {
    Write-Host 'Managed OpenCode configuration is missing. Run INSTALL.bat to repair the installation.' -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host 'Ollama is missing. Run INSTALL.bat to repair the installation.' -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

if (-not (Test-OllamaApi $env:OLLAMA_HOST)) {
    Write-Host "Starting Ollama on $env:OLLAMA_HOST ..." -ForegroundColor Cyan
    $ollama = (Get-Command ollama).Source
    Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Test-OllamaApi $env:OLLAMA_HOST) {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        Write-Host 'Ollama API did not become ready. Run INSTALL.bat to repair the installation.' -ForegroundColor Red
        Read-Host 'Press Enter to close'
        exit 1
    }
}

if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
    Write-Host 'OpenCode is missing. Run INSTALL.bat to repair the installation.' -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $ProjectPath = [string]$state.workspace
}

if (-not (Test-Path $ProjectPath)) {
    New-Item -ItemType Directory -Path $ProjectPath -Force | Out-Null
}

$currentModel = [string]$state.ollamaModel
try {
    $managedConfig = Get-Content $env:OPENCODE_CONFIG -Raw | ConvertFrom-Json
    if ($managedConfig.model) { $currentModel = [string]$managedConfig.model }
} catch { }

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' RE Coding Agent' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "Project : $ProjectPath"
Write-Host "Model   : $currentModel"
Write-Host "Context : $($state.context) local profile"
Write-Host "Ollama  : $($state.ollamaHost)"
Write-Host "Ghidra  : $($state.ghidraInstallDir)"
Write-Host "Config  : $($state.openCodeConfig)"
Write-Host 'REA MCP  : configured for OpenCode'
Write-Host 'Cloud keys: loaded from Dashboard when configured'
Write-Host ''

Set-Location $ProjectPath
& opencode --standalone
