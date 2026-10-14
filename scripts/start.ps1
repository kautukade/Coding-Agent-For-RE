[CmdletBinding()]
param(
    [string]$ProjectPath
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$StateRoot = Join-Path $env:LOCALAPPDATA 'RE-Coding-Agent'
$StateFile = Join-Path $StateRoot 'state.json'
$RouterScript = Join-Path $RepoRoot 'dashboard\router.mjs'
$RouterPort = 17322

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

function Test-Router {
    try {
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$RouterPort/health" -TimeoutSec 2
        return [bool]$status.ok
    } catch {
        return $false
    }
}

function Ensure-Router {
    if (Test-Router) { return }
    if (-not (Test-Path $RouterScript)) {
        throw "Hybrid router is missing: $RouterScript"
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw 'Node.js is required to start the hybrid router.'
    }

    Write-Host 'Starting hybrid local + API model router ...' -ForegroundColor Cyan
    Start-Process -FilePath $node.Source -ArgumentList "`"$RouterScript`"" -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null

    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 300
        if (Test-Router) { return }
    }
    throw 'Hybrid router did not become ready on 127.0.0.1:17322.'
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
$env:RE_ROUTER_PORT = [string]$RouterPort

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

try {
    Ensure-Router
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $ProjectPath = [string]$state.workspace
}

if (-not (Test-Path $ProjectPath)) {
    New-Item -ItemType Directory -Path $ProjectPath -Force | Out-Null
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' RE Coding Agent - Hybrid Runtime' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host "Project : $ProjectPath"
Write-Host "Local   : $($state.ollamaModel)"
Write-Host "Context : $($state.context)"
Write-Host "Ollama  : $($state.ollamaHost)"
Write-Host "Router  : http://127.0.0.1:$RouterPort"
Write-Host "Ghidra  : $($state.ghidraInstallDir)"
Write-Host "Config  : $($state.openCodeConfig)"
Write-Host 'REA MCP  : configured for OpenCode'
Write-Host ''

Set-Location $ProjectPath
& opencode --standalone
