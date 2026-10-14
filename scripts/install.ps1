[CmdletBinding()]
param(
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRoot = Split-Path -Parent $PSScriptRoot
$StateRoot = Join-Path $env:LOCALAPPDATA 'RE-Coding-Agent'
$ToolsRoot = Join-Path $StateRoot 'tools'
$LogRoot = Join-Path $StateRoot 'logs'
$StateFile = Join-Path $StateRoot 'state.json'
$ConfigRoot = Join-Path $StateRoot 'config'
$OpenCodeConfig = Join-Path $ConfigRoot 'opencode.json'

foreach ($dir in @($StateRoot, $ToolsRoot, $LogRoot, $ConfigRoot)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile = Join-Path $LogRoot "install-$timestamp.log"
Start-Transcript -Path $LogFile -Force | Out-Null

function Write-Step([string]$Text) {
    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host " $Text" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
}

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

function Test-Command([string]$Name) {
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Ensure-Winget {
    if (-not (Test-Command 'winget')) {
        throw 'Windows Package Manager (winget) is required. Update/install Microsoft App Installer, then rerun INSTALL.bat.'
    }
}

function Install-WingetPackage([string]$Id, [switch]$Force) {
    Ensure-Winget
    $args = @('install', '--id', $Id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements')
    if ($Force) { $args += '--force' }
    Write-Host "Installing/updating $Id ..."
    & winget @args
    $code = $LASTEXITCODE
    Refresh-Path
    if ($code -ne 0 -and $code -ne 3010) {
        Write-Warning "winget returned exit code $code for $Id. Verification will decide whether setup can continue."
    }
}

function Get-NodeVersion {
    if (-not (Test-Command 'node')) { return $null }
    try {
        $text = (& node -v 2>$null).Trim().TrimStart('v')
        return [version]$text
    } catch { return $null }
}

function Test-ReaNodeVersion([version]$Version) {
    if ($null -eq $Version) { return $false }
    if ($Version.Major -ge 26) { return $true }
    if ($Version.Major -eq 24) {
        if ($Version.Minor -gt 11) { return $true }
        if ($Version.Minor -eq 11 -and $Version.Build -ge 0) { return $true }
    }
    if ($Version.Major -eq 22) {
        if ($Version.Minor -gt 19) { return $true }
        if ($Version.Minor -eq 19 -and $Version.Build -ge 0) { return $true }
    }
    return $false
}

function Get-JavaHome {
    $candidates = New-Object System.Collections.Generic.List[string]

    foreach ($scope in @('Process', 'User', 'Machine')) {
        $value = [Environment]::GetEnvironmentVariable('JAVA_HOME', $scope)
        if ($value) { $candidates.Add($value) }
    }

    $javac = Get-Command javac -ErrorAction SilentlyContinue
    if ($javac) {
        $candidates.Add((Split-Path -Parent (Split-Path -Parent $javac.Source)))
    }

    foreach ($base in @('C:\Program Files\Java', 'C:\Program Files\Microsoft')) {
        if (Test-Path $base) {
            Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^jdk-' -or $_.Name -match '^jdk\d' } |
                Sort-Object LastWriteTime -Descending |
                ForEach-Object { $candidates.Add($_.FullName) }
        }
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        $javacExe = Join-Path $candidate 'bin\javac.exe'
        if (Test-Path $javacExe) {
            try {
                $verText = (& $javacExe -version 2>&1 | Out-String).Trim()
                if ($verText -match '(\d+)(?:\.\d+)?') {
                    $major = [int]$Matches[1]
                    if ($major -ge 21) { return $candidate }
                }
            } catch { }
        }
    }
    return $null
}

function Get-OllamaHost {
    foreach ($scope in @('Process', 'User', 'Machine')) {
        $value = [Environment]::GetEnvironmentVariable('OLLAMA_HOST', $scope)
        if ($value) {
            $value = $value.Trim().TrimEnd('/')
            $value = $value -replace '^https?://', ''
            if ($value -notmatch ':\d+$') { $value = "$value`:11434" }
            return $value
        }
    }
    return '127.0.0.1:11434'
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
    } catch { return $false }
}

function Test-LocalPortFree([int]$Port) {
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) {
            try { $listener.Stop() } catch { }
        }
    }
}

function Start-OllamaAndWait([string]$HostValue) {
    $env:OLLAMA_HOST = $HostValue
    $ollamaCommand = Get-Command ollama -ErrorAction Stop
    Start-Process -FilePath $ollamaCommand.Source -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Test-OllamaApi $HostValue) { return $true }
    }
    return $false
}

function Ensure-OllamaServer {
    $hostValue = Get-OllamaHost
    if (Test-OllamaApi $hostValue) { return $hostValue }

    Write-Host "Starting Ollama on $hostValue ..."
    if (Start-OllamaAndWait $hostValue) { return $hostValue }

    Write-Warning "Ollama did not start on $hostValue. Looking for another local port."
    foreach ($port in @(11434, 11500, 11435, 11501, 11600)) {
        $candidate = "127.0.0.1:$port"
        if (Test-OllamaApi $candidate) { return $candidate }
        if (Test-LocalPortFree $port) {
            if (Start-OllamaAndWait $candidate) { return $candidate }
        }
    }
    throw 'Unable to start or reach the local Ollama API.'
}

function Get-ContextSize {
    $ramBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    $ramGB = [math]::Round($ramBytes / 1GB, 1)
    if ($ramGB -lt 12) { return 8192 }
    if ($ramGB -lt 24) { return 16384 }
    return 32768
}

function Get-GhidraInstall {
    $existing = Get-ChildItem $ToolsRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^ghidra_12\.1\.\d+_PUBLIC' } |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if ($existing -and (Test-Path (Join-Path $existing.FullName 'support\analyzeHeadless.bat'))) {
        return $existing.FullName
    }

    $fallbackUrl = 'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip'
    $fallbackName = 'ghidra_12.1.4_PUBLIC_20260921.zip'
    $fallbackDigest = 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db'

    $downloadUrl = $fallbackUrl
    $assetName = $fallbackName
    $expectedDigest = $fallbackDigest

    try {
        $headers = @{ 'User-Agent' = 'Coding-Agent-For-RE-Installer' }
        $releases = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/NationalSecurityAgency/ghidra/releases?per_page=30' -TimeoutSec 20
        $release = $releases | Where-Object { $_.tag_name -match '^Ghidra_12\.1\.\d+_build$' -and -not $_.prerelease } | Select-Object -First 1
        if ($release) {
            $asset = $release.assets | Where-Object { $_.name -match '^ghidra_12\.1\.\d+_PUBLIC_\d+\.zip$' } | Select-Object -First 1
            if ($asset) {
                $downloadUrl = $asset.browser_download_url
                $assetName = $asset.name
                if ($asset.digest -and $asset.digest -match '^sha256:(.+)$') {
                    $expectedDigest = $Matches[1].ToLowerInvariant()
                } elseif ($release.body -match 'SHA-256:\s*`?([0-9a-fA-F]{64})') {
                    $expectedDigest = $Matches[1].ToLowerInvariant()
                }
            }
        }
    } catch {
        Write-Warning "Could not query the Ghidra releases API. Using pinned official Ghidra 12.1.4. $($_.Exception.Message)"
    }

    $zipPath = Join-Path $ToolsRoot $assetName
    if (-not (Test-Path $zipPath)) {
        Write-Host "Downloading official Ghidra release: $assetName"
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $zipPath
    }

    if ($expectedDigest) {
        $actualDigest = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualDigest -ne $expectedDigest) {
            Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
            throw "Ghidra SHA-256 verification failed. Expected $expectedDigest but got $actualDigest."
        }
        Write-Host 'Ghidra SHA-256 verified.' -ForegroundColor Green
    }

    Write-Host 'Extracting Ghidra ...'
    Expand-Archive -Path $zipPath -DestinationPath $ToolsRoot -Force
    $folderName = [IO.Path]::GetFileNameWithoutExtension($assetName)
    $installPath = Join-Path $ToolsRoot $folderName
    if (-not (Test-Path (Join-Path $installPath 'support\analyzeHeadless.bat'))) {
        $found = Get-ChildItem $ToolsRoot -Directory |
            Where-Object { $_.Name -match '^ghidra_12\.1\.\d+_PUBLIC' } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($found) { $installPath = $found.FullName }
    }
    if (-not (Test-Path (Join-Path $installPath 'support\analyzeHeadless.bat'))) {
        throw 'Ghidra extraction completed but analyzeHeadless.bat was not found.'
    }
    return $installPath
}

function Ensure-OpenCode {
    Write-Host 'Installing/updating OpenCode CLI ...'
    & npm install -g '@opencode/cli@latest'
    Refresh-Path

    $working = $false
    if (Test-Command 'opencode') {
        try {
            & opencode --version
            if ($LASTEXITCODE -eq 0) { $working = $true }
        } catch { }
    }

    if (-not $working) {
        $npmRoot = (& npm root -g).Trim()
        $postInstall = Join-Path $npmRoot '@opencode\cli\postinstall.mjs'
        if (Test-Path $postInstall) {
            Write-Host 'Running OpenCode postinstall ...'
            & node $postInstall
            Refresh-Path
        }
    }

    if (-not (Test-Command 'opencode')) { throw 'OpenCode installation verification failed.' }
    & opencode --version
    if ($LASTEXITCODE -ne 0) { throw 'OpenCode is installed but did not start correctly.' }
}

function Ensure-Rea {
    Write-Host 'Installing/updating REA ...'
    & npm install -g 'rea-agents@latest'
    Refresh-Path
    if (-not (Test-Command 'rea')) { throw 'REA installation verification failed.' }
    try { & rea --version } catch { }
}

function Configure-OpenCode([string]$OllamaHost, [int]$ContextSize, [string]$GhidraDir, [string]$JavaHome) {
    $configPath = $OpenCodeConfig
    if (-not (Test-Path $configPath)) {
        '{}' | Set-Content -Path $configPath -Encoding UTF8
    }

    Copy-Item $configPath "$configPath.backup-$timestamp" -Force

    $raw = Get-Content $configPath -Raw
    try {
        $config = $raw | ConvertFrom-Json
    } catch {
        throw "Managed OpenCode config is invalid JSON: $configPath"
    }

    if ($null -eq $config) { $config = [pscustomobject]@{} }
    if (-not $config.PSObject.Properties['$schema']) {
        $config | Add-Member -NotePropertyName '$schema' -NotePropertyValue 'https://opencode.ai/config.json'
    }

    $models = [pscustomobject]@{}
    $models | Add-Member -NotePropertyName 'rea-qwen-coder' -NotePropertyValue ([pscustomobject]@{
        name = "REA Qwen Coder Local ($([int]($ContextSize / 1024))K)"
        limit = [pscustomobject]@{
            context = $ContextSize
            output = 4096
        }
    })

    $clientHost = Normalize-OllamaClientHost $OllamaHost
    $ollamaProvider = [pscustomobject]@{
        npm = '@ai-sdk/openai-compatible'
        name = 'Ollama Local'
        options = [pscustomobject]@{
            baseURL = "http://$clientHost/v1"
        }
        models = $models
    }

    if (-not $config.PSObject.Properties['provider']) {
        $config | Add-Member -NotePropertyName 'provider' -NotePropertyValue ([pscustomobject]@{})
    }
    if ($null -eq $config.provider) { $config.provider = [pscustomobject]@{} }
    $config.provider | Add-Member -NotePropertyName 'ollama' -NotePropertyValue $ollamaProvider -Force

    if ($config.PSObject.Properties['model']) {
        $config.model = 'ollama/rea-qwen-coder'
    } else {
        $config | Add-Member -NotePropertyName 'model' -NotePropertyValue 'ollama/rea-qwen-coder'
    }

    $reaEntry = $null
    if ($config.PSObject.Properties['mcp'] -and $config.mcp) {
        if ($config.mcp.PSObject.Properties['rea']) {
            $reaEntry = $config.mcp.rea
        } elseif ($config.mcp.PSObject.Properties['servers'] -and $config.mcp.servers.PSObject.Properties['rea']) {
            $reaEntry = $config.mcp.servers.rea
        }
    }

    if (-not $reaEntry) {
        throw 'REA setup completed, but the managed OpenCode config does not contain an REA MCP registration.'
    }

    $environment = [pscustomobject]@{
        GHIDRA_INSTALL_DIR = $GhidraDir
        JAVA_HOME = $JavaHome
        REA_ANALYSIS_PROVIDER = 'ghidra'
        REA_GHIDRA_STARTUP_TIMEOUT_MS = '180000'
    }

    if ($reaEntry.PSObject.Properties['environment']) {
        if ($null -eq $reaEntry.environment) {
            $reaEntry.environment = [pscustomobject]@{}
        }
        foreach ($p in $environment.PSObject.Properties) {
            $reaEntry.environment | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value -Force
        }
    } else {
        $reaEntry | Add-Member -NotePropertyName 'environment' -NotePropertyValue $environment
    }

    $config | ConvertTo-Json -Depth 50 | Set-Content -Path $configPath -Encoding UTF8
    return $configPath
}

function Create-DesktopShortcut {
    $launcher = Join-Path $RepoRoot 'START-RE-AGENT.bat'
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop 'RE Coding Agent.lnk'
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $launcher
        $shortcut.WorkingDirectory = $RepoRoot
        $shortcut.Description = 'Local OpenCode + Ollama + REA + Ghidra'
        $shortcut.Save()
        Write-Host "Desktop shortcut created: $shortcutPath"
    } catch {
        Write-Warning "Could not create desktop shortcut: $($_.Exception.Message)"
    }
}

try {
    Write-Step '1/8  Checking Windows and package manager'
    if (-not [Environment]::Is64BitOperatingSystem) { throw '64-bit Windows is required.' }
    Ensure-Winget
    Refresh-Path

    Write-Step '2/8  Node.js'
    $nodeVersion = Get-NodeVersion
    if (-not (Test-ReaNodeVersion $nodeVersion)) {
        Install-WingetPackage 'OpenJS.NodeJS.LTS' -Force
        Refresh-Path
        $nodeVersion = Get-NodeVersion
    }
    if (-not (Test-ReaNodeVersion $nodeVersion)) {
        throw "REA-compatible Node.js was not found after installation. Current: $nodeVersion"
    }
    Write-Host "Node.js $nodeVersion" -ForegroundColor Green

    Write-Step '3/8  Java/JDK 21+'
    $javaHome = Get-JavaHome
    if (-not $javaHome) {
        Install-WingetPackage 'Microsoft.OpenJDK.21'
        Refresh-Path
        $javaHome = Get-JavaHome
    }
    if (-not $javaHome) { throw 'A full JDK 21+ could not be located.' }
    $env:JAVA_HOME = $javaHome
    [Environment]::SetEnvironmentVariable('JAVA_HOME', $javaHome, 'User')
    Write-Host "JAVA_HOME=$javaHome" -ForegroundColor Green

    Write-Step '4/8  Ollama and local model'
    if (-not (Test-Command 'ollama')) {
        Install-WingetPackage 'Ollama.Ollama'
        Refresh-Path
    }
    if (-not (Test-Command 'ollama')) { throw 'Ollama installation verification failed.' }

    $ollamaHost = Ensure-OllamaServer
    $env:OLLAMA_HOST = $ollamaHost
    [Environment]::SetEnvironmentVariable('OLLAMA_HOST', $ollamaHost, 'User')
    [Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', '10m', 'User')
    Write-Host "OLLAMA_HOST=$ollamaHost" -ForegroundColor Green

    Write-Host 'Pulling qwen2.5-coder:7b ...'
    & ollama pull 'qwen2.5-coder:7b'
    if ($LASTEXITCODE -ne 0) { throw 'ollama pull qwen2.5-coder:7b failed.' }

    $contextSize = Get-ContextSize
    $modelFile = Join-Path $ConfigRoot 'REA-Qwen.Modelfile'
    @"
FROM qwen2.5-coder:7b
PARAMETER num_ctx $contextSize
PARAMETER temperature 0.2
"@ | Set-Content -Path $modelFile -Encoding ASCII

    Write-Host "Creating rea-qwen-coder with $contextSize context ..."
    & ollama create 'rea-qwen-coder' -f $modelFile
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the rea-qwen-coder Ollama profile.' }

    Write-Step '5/8  Ghidra 12.1.x'
    $ghidraDir = Get-GhidraInstall
    $env:GHIDRA_INSTALL_DIR = $ghidraDir
    $env:REA_ANALYSIS_PROVIDER = 'ghidra'
    $env:REA_GHIDRA_STARTUP_TIMEOUT_MS = '180000'
    [Environment]::SetEnvironmentVariable('GHIDRA_INSTALL_DIR', $ghidraDir, 'User')
    [Environment]::SetEnvironmentVariable('REA_ANALYSIS_PROVIDER', 'ghidra', 'User')
    [Environment]::SetEnvironmentVariable('REA_GHIDRA_STARTUP_TIMEOUT_MS', '180000', 'User')
    Write-Host "GHIDRA_INSTALL_DIR=$ghidraDir" -ForegroundColor Green

    Write-Step '6/8  OpenCode + REA'
    Ensure-OpenCode
    Ensure-Rea

    # Use a dedicated OpenCode config owned by this project. This keeps the
    # one-click RE agent isolated from the user's normal OpenCode configuration.
    $env:OPENCODE_CONFIG = $OpenCodeConfig
    if (-not (Test-Path $OpenCodeConfig)) {
        '{}' | Set-Content -Path $OpenCodeConfig -Encoding UTF8
    }

    Write-Host 'Registering REA with the managed OpenCode config (non-interactive) ...'
    & rea setup --yes --client opencode
    if ($LASTEXITCODE -ne 0) { throw 'REA OpenCode setup failed.' }

    Write-Step '7/8  Configuring local model + provider environment'
    $openCodeConfigPath = Configure-OpenCode -OllamaHost $ollamaHost -ContextSize $contextSize -GhidraDir $ghidraDir -JavaHome $javaHome
    Write-Host "OpenCode config: $openCodeConfigPath" -ForegroundColor Green

    Write-Step '8/8  Verification and launcher'
    $env:OPENCODE_CONFIG = $openCodeConfigPath
    $modelList = (& opencode models --standalone 2>&1 | Out-String)
    if ($modelList -notmatch 'ollama/rea-qwen-coder') {
        throw 'OpenCode does not list ollama/rea-qwen-coder after configuration.'
    }
    Write-Host 'OpenCode sees ollama/rea-qwen-coder.' -ForegroundColor Green

    try {
        & rea doctor --client opencode --skill
    } catch {
        Write-Warning "REA doctor reported an issue: $($_.Exception.Message)"
    }

    $workspace = Join-Path $HOME 'RE-Workspace'
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null

    $state = [pscustomobject]@{
        installedAt = (Get-Date).ToString('o')
        repoRoot = $RepoRoot
        workspace = $workspace
        ollamaHost = $ollamaHost
        ollamaModel = 'rea-qwen-coder'
        context = $contextSize
        javaHome = $javaHome
        ghidraInstallDir = $ghidraDir
        openCodeConfig = $openCodeConfigPath
        installLog = $LogFile
    }
    $state | ConvertTo-Json -Depth 10 | Set-Content -Path $StateFile -Encoding UTF8

    Create-DesktopShortcut

    Write-Host "`nSUCCESS: RE Coding Agent is ready." -ForegroundColor Green
    Write-Host "Model: rea-qwen-coder ($contextSize context)"
    Write-Host 'REA: registered with OpenCode'
    Write-Host "Ghidra: $ghidraDir"
    Write-Host "Workspace: $workspace"
    Write-Host "Managed OpenCode config: $openCodeConfigPath"
    Write-Host "Log: $LogFile"

    Stop-Transcript | Out-Null

    if (-not $NoLaunch) {
        $launcher = Join-Path $RepoRoot 'START-RE-AGENT.bat'
        if (Test-Path $launcher) {
            Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$launcher`"" | Out-Null
        }
    }
    exit 0
} catch {
    Write-Host "`nINSTALL FAILED" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "Log: $LogFile" -ForegroundColor Yellow
    try { Stop-Transcript | Out-Null } catch { }
    exit 1
}
