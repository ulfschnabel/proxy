# RelayPlane Proxy (Fork)

Private fork of [@relayplane/proxy](https://www.npmjs.com/package/@relayplane/proxy) with hardened Windows support, crash resilience, and model version awareness.

## What This Is

A local AI proxy that sits between Claude Code and the Anthropic API. It intercepts every request, classifies it by complexity, and routes simple tasks to cheaper models — saving significant cost without changing your workflow.

```
Claude Code → localhost:4010 → [classify complexity] → Haiku / Sonnet / Opus
```

## Key Differences From Upstream

| Feature | Upstream | This Fork |
|---------|----------|-----------|
| Windows service | Not supported | Task Scheduler watchdog (auto-restart every 5 min) |
| Process management | Basic supervisor | PID-guarded supervisor, `windowsHide`, fd leak fix |
| Crash resilience | Process exits on uncaught exception | Graceful mesh fallback, event listeners, supervisor exit on max restarts |
| Model version routing | Hardcoded to opus-4-6 | Preserves caller's Opus version (4-7 stays 4-7) |
| Port | 4100 (default) | 4010 (all scripts, Task Scheduler, settings) |
| Deploy | npm publish | `npm run deploy` (Node-based: validate, pack, backup, stop, install, start, health check) |

## Current Routing

Complexity-based routing via OpenRouter:

| Complexity | Model | When |
|-----------|-------|------|
| Simple/Basic | `claude-haiku-4-5-20251001` | Short prompts, basic Q&A |
| Moderate | `claude-sonnet-4-6` | Multi-step reasoning, code review |
| Complex | Caller's Opus version (4-6 or 4-7) | Architecture, large context, many tools |

The proxy classifies requests by message count, token length, tool usage, and content patterns. No prompt content leaves your machine for classification.

## Setup

### Prerequisites

- Node.js 18+
- Windows 10/11 (Linux/macOS use upstream's systemd/launchd)
- An OpenRouter API key (set in `~/.relayplane/config.json`)

### Install

```bash
git clone https://git.vennicx.homes/ulf/relayplane.git
cd relayplane
npm install
npm run build
```

### Configure Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4010"
  }
}
```

### Start

```bash
node dist/cli.js ensure-running --port 4010 --host 127.0.0.1
```

Or install as a Windows service (auto-starts at login, watchdog every 5 min):

```bash
node dist/cli.js service install
node dist/cli.js service status
```

### Deploy Updates

From an admin terminal:

```bash
npm run deploy
```

This validates, packs, backs up, stops the old version, installs, starts, and health-checks in one step.

## Architecture

```
Claude Code
    │
    │  POST /v1/messages (Anthropic native)
    ▼
┌─────────────────────────────────────────┐
│ RelayPlane Proxy (localhost:4010)        │
│─────────────────────────────────────────│
│ 1. Classify complexity (local heuristic)│
│ 2. Route: simple→Haiku, mod→Sonnet,    │
│    complex→Opus (preserving version)    │
│ 3. Forward to OpenRouter / Anthropic    │
│ 4. Track cost, cache, budget            │
└─────────────────────────────────────────┘
    │
    ▼
OpenRouter / Anthropic API
```

### Key Files

- `src/standalone-proxy.ts` — main proxy server, routing logic, request handlers
- `src/model-sanitizer.ts` — strips unsupported params per model before forwarding
- `src/process-manager.ts` — supervised child process with exponential backoff restarts
- `src/cli.ts` — CLI commands including `ensure-running`, `supervise`, `service install`
- `src/openai-to-anthropic-stream.ts` — SSE converter for non-Anthropic providers

### Process Hierarchy (Windows)

```
Task Scheduler ("RelayPlane Proxy (Watchdog)" — every 5 min)
    └─ powershell -WindowStyle Hidden → node ensure-running
        └─ (no-op if port 4010 already listening)
        └─ OR spawns: node cli.js supervise --port 4010
            └─ ProcessManager spawns: node launcher.js
                └─ standalone-proxy (the actual HTTP server)
```

If the proxy crashes, ProcessManager restarts it (5s backoff, exponential to 60s max).
If the supervisor crashes, the Task Scheduler watchdog revives it within 5 minutes.

## Configuration

Lives at `~/.relayplane/config.json` (live-reloaded via fs.watch):

```json
{
  "enabled": true,
  "routing": {
    "mode": "complexity",
    "complexity": {
      "enabled": true,
      "simple": "claude-haiku-4-5-20251001",
      "moderate": "claude-sonnet-4-6",
      "complex": "claude-opus-4-6"
    }
  }
}
```

Runtime config changes via API: `POST http://localhost:4010/control/config`

## Upstream

Based on [@relayplane/proxy](https://www.npmjs.com/package/@relayplane/proxy) — an open-source Node.js LLM proxy with cost tracking, complexity routing, budget enforcement, anomaly detection, and response caching. See the [upstream README](https://github.com/RelayPlane/proxy) for full feature documentation.

## License

[MIT](https://github.com/RelayPlane/proxy/blob/main/LICENSE)
