# Coding Agent for Reverse Engineering

A Windows one-click setup for a **local coding agent + REA + Ghidra + Ollama** workflow.

This repository is a wrapper/installer around the official upstream tools. It does **not** redistribute REA, Ghidra, Ollama, Node.js, Java, or OpenCode; the installer downloads/installs them from their official package/release channels.

## What you get

After one run of `INSTALL.bat`, the machine is configured with:

- Node.js supported by REA
- OpenCode CLI
- Ollama
- `qwen2.5-coder:7b` plus an adaptive higher-context local profile named `rea-qwen-coder`
- REA (`rea-agents`) registered as an OpenCode MCP server
- Ghidra 12.1.x from the official NSA GitHub release, with SHA-256 verification when the release API provides a digest
- Java/JDK 21+ for Ghidra
- OpenCode configured to use the local Ollama model by default
- REA configured to use Ghidra for supported native Windows analysis
- A desktop shortcut named **RE Coding Agent**
- A local workspace at `%USERPROFILE%\RE-Workspace`

The installer is designed to be **idempotent**: run `INSTALL.bat` again to repair/update the setup.

## One-click install

1. Download/clone this repository.
2. Double-click **`INSTALL.bat`**.
3. Accept the Windows UAC elevation prompt if Windows shows it.

The installer does the rest and launches the agent when setup finishes.

> Internet access is required during the first install. Downloads are large because the local model and Ghidra are several GB combined.

### Windows requirement

The current installer targets **64-bit Windows 10/11** and uses the Windows Package Manager (`winget`) for Node.js, Ollama, and Java when they are missing. Modern Windows 10/11 systems with Microsoft App Installer normally already have `winget`.

## Start later

Double-click:

```text
START-RE-AGENT.bat
```

or use the **RE Coding Agent** desktop shortcut.

If no project folder is supplied, the launcher opens `%USERPROFILE%\RE-Workspace`.

You can also drag a project folder onto `START-RE-AGENT.bat`; the agent opens directly in that project.

## Update / repair

Double-click:

```text
UPDATE.bat
```

It reruns the same safe/idempotent installer and refreshes OpenCode, REA, the local model profile, and configuration.

## Isolated OpenCode configuration

The project uses its own managed OpenCode configuration instead of overwriting your normal OpenCode setup:

```text
%LOCALAPPDATA%\RE-Coding-Agent\config\opencode.json
```

`START-RE-AGENT.bat` automatically points OpenCode at this config. That means an existing personal OpenCode configuration remains separate.

## Local model profile

The installer pulls:

```text
qwen2.5-coder:7b
```

and creates:

```text
rea-qwen-coder
```

Context is selected from available system RAM:

- under 12 GB RAM: 8K context
- 12–23 GB RAM: 16K context
- 24 GB+ RAM: 32K context

This keeps the setup practical on CPU-only laptops while giving REA/OpenCode more room than the common 4K default.

## Ollama ports

The installer preserves an existing `OLLAMA_HOST` when one is already configured. This matters on machines that already run Ollama on a custom port such as `11500`.

If no custom host exists, the standard local endpoint is used:

```text
127.0.0.1:11434
```

OpenCode is then pointed at the detected Ollama OpenAI-compatible `/v1` endpoint.

If the configured port is unavailable and is not a working Ollama API, the installer automatically searches a small set of local fallback ports and persists the working one.

## Ghidra

REA currently requires a compatible **Ghidra 12.1.x** installation for the Windows native-analysis provider. The installer discovers the newest official 12.1.x release from `NationalSecurityAgency/ghidra`, downloads it, verifies the published SHA-256 digest when available, extracts it under:

```text
%LOCALAPPDATA%\RE-Coding-Agent\tools
```

and configures:

```text
GHIDRA_INSTALL_DIR
REA_ANALYSIS_PROVIDER=ghidra
JAVA_HOME
REA_GHIDRA_STARTUP_TIMEOUT_MS=180000
```

These values are also written into the managed OpenCode REA MCP environment so the launcher works without reopening a shell or manually setting variables.

## Files

```text
INSTALL.bat                     One-click installer / repair entry point
START-RE-AGENT.bat              Start local OpenCode + Ollama + REA
UPDATE.bat                      Re-run installer to update/repair
scripts/install.ps1             Main automated setup
scripts/start.ps1               Runtime launcher
.github/workflows/validate.yml  PowerShell syntax validation
```

## Verification

During install the script checks that:

- Ollama HTTP API responds
- the local model profile exists
- OpenCode can see the configured Ollama model
- REA has registered its OpenCode MCP entry
- Ghidra and Java paths are valid

A state file and timestamped logs are written under:

```text
%LOCALAPPDATA%\RE-Coding-Agent
```

The repository also has a Windows GitHub Actions workflow that parses every PowerShell script and checks the required entry points on each push.

## Upstream

REA upstream: `morluto/rea`

REA is installed from the official `rea-agents` npm package. The upstream project documents Windows/OpenCode support and supports non-interactive setup with `setup --client opencode --yes`.

Ghidra is downloaded only from the official `NationalSecurityAgency/ghidra` GitHub releases. A pinned official Ghidra 12.1.4 URL and published SHA-256 are retained as a fallback if the GitHub releases API is temporarily unavailable.

## Responsible use

Use reverse-engineering features only on software, devices, files, systems, or challenge targets that you own or are authorized to analyze. This project is intended for development, interoperability, debugging, education, malware research in controlled environments, CTFs, and authorized security/reverse-engineering work.

## License

The automation code in this repository is MIT licensed. Third-party tools retain their own licenses and terms.
