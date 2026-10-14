# Hybrid Local + API Model Router

The RE Coding Agent can run fully locally, fully through API models, or in a hybrid mode that decides per request.

## Architecture

```text
OpenCode
   |
   v
RE Hybrid Router (127.0.0.1:17322)
   |-------------------- Local Ollama / rea-qwen-coder
   |-------------------- NVIDIA NIM
   |-------------------- OpenRouter
   |-------------------- Hugging Face
   `-------------------- Custom OpenAI-compatible API

OpenCode <-> REA MCP -> Ghidra -> evidence / analysis
```

The router is an OpenAI-compatible localhost service. OpenCode is configured with three logical models:

- `hybrid-router/re-auto` — use the dashboard routing policy
- `hybrid-router/re-local` — force local Ollama
- `hybrid-router/re-cloud` — force configured API providers

REA is independent of the selected reasoning model. A local or cloud model can drive the OpenCode agent while REA remains connected as the MCP reverse-engineering tool server.

## Routing modes

- **Hybrid Auto** — simple work can stay local; tool-heavy, reverse-engineering, long, or complex work can prefer cloud when configured.
- **Local Only** — never sends model requests to a cloud API.
- **Cloud Only** — only configured API providers are used.
- **Local First** — local model is attempted before API providers.
- **Cloud First** — API providers are attempted before the local model.

## Strategies

- **Balanced** — heuristics consider prompt size, tool availability, REA/reverse-engineering terms, and task complexity.
- **Quality first** — prefer configured cloud providers when possible.
- **Speed first** — prefer configured cloud providers first, with fallback.
- **Privacy first** — prefer the local model first.

## Automatic fallback

When enabled, the router tries the next configured provider after common transient failures such as rate limits, authentication failure, service unavailability, or server errors. After repeated provider failures, a short in-memory circuit breaker prevents immediately retrying the same failing provider.

If all cloud providers fail in a hybrid mode, local Ollama remains the safety net. In `cloud-only` mode, the router does not silently use local inference.

## Dashboard provider setup

Open `DASHBOARD.bat` and go to **Providers**. For supported cloud providers:

1. Enable the provider.
2. Paste the API key/token.
3. Optionally edit the model ID and base URL.
4. Use **Test Key**.
5. Use **Load Models** when the provider exposes an OpenAI-compatible `/models` endpoint.
6. Click **Save & Apply**.

No manual edit of `opencode.json` is required.

A **Custom OpenAI-compatible** provider is also available for additional services that expose compatible `/v1/models` and `/v1/chat/completions` endpoints.

## Security and privacy

The dashboard and router bind only to `127.0.0.1`.

Cloud API keys are stored in the RE Coding Agent local configuration area and the secrets file receives a current-Windows-user ACL on a best-effort basis. The full saved key is never sent back to the dashboard browser after saving.

OpenCode talks to the localhost router instead of receiving cloud provider credentials directly. Router activity logs contain routing metadata (provider, model, latency, result, routing signals) and do not store prompt text.

Choose **Local Only** whenever model input must not be sent to external API providers.

## Activity and diagnostics

The **Activity** page shows recent routing results without storing prompt text. The **REA** page shows the OpenCode -> REA MCP -> Ghidra integration and can run `rea doctor` directly.

The router log is stored under:

```text
%LOCALAPPDATA%\RE-Coding-Agent\logs\router.jsonl
```

The router automatically trims the log when it becomes large.

## Runtime behavior

`START-RE-AGENT.bat` starts Ollama if required, starts the hybrid router if required, verifies that the router is reachable, then launches OpenCode with the managed configuration. The router preserves the existing REA MCP registration while making `hybrid-router/re-auto` the default model.
