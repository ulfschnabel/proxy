# RelayPlane Proxy

Private fork of @relayplane/proxy. Local AI proxy for Claude Code — routes requests by complexity to save cost.

## Current Routing
- simple/basic → Haiku (cheap, session's own OAT auth passes through)
- moderate → Sonnet
- complex → Opus (preserves caller's version: if CC sends opus-4-7, routes to opus-4-7)

## Key Architecture
- `src/standalone-proxy.ts` — main proxy server. TWO request handlers: `/v1/messages` (native Anthropic, Claude Code uses this) and `/v1/chat/completions` (OpenAI-compatible). Both have independent complexity routing paths.
- `src/model-sanitizer.ts` — centralized param/beta stripping per model. ALL Anthropic requests go through `forwardNativeAnthropicRequest` which calls this.
- `src/openai-to-anthropic-stream.ts` — OpenAI SSE → Anthropic SSE converter for non-Anthropic providers
- `src/process-manager.ts` — supervised child spawning with exponential backoff, `windowsHide: true`
- `src/cli.ts` — CLI entrypoints: `ensure-running` (idempotent start), `supervise` (crash-restarting wrapper), `service install/uninstall/status` (Windows Task Scheduler)
- `src/token-pool.ts` — multi-account token pool (rate limit tracking, not used for auth override)
- `preserveOpusVersion()` in standalone-proxy.ts — ensures caller's Opus version is forwarded, not the hardcoded config version

## Critical: Port is 4010
- ALL scripts, Task Scheduler tasks, and `ANTHROPIC_BASE_URL` use port **4010**
- Code defaults to 4100 but this install overrides to 4010 everywhere
- NEVER change the port without explicit instruction

## Config & Deploy
- Config: `~/.relayplane/config.json`, live-reloaded via fs.watch, patchable via `POST /control/config`
- Deploy: `npm run deploy` (Node-based release flow: validate → pack → backup → stop → install → start → health check) from an admin terminal on Windows.
- After changing runtime code, always run `npm run build` before restarting so the scripts pick up the new `dist/` output.

## Windows Service
- `node dist/cli.js service install` registers two Task Scheduler tasks:
  - "RelayPlane Proxy (Logon)" — starts proxy at login
  - "RelayPlane Proxy (Watchdog)" — runs every 5 min, revives dead supervisor
- Both use `powershell.exe -WindowStyle Hidden` + `Start-Process -NoNewWindow` to suppress console windows
- `node dist/cli.js ensure-running --port 4010 --host 127.0.0.1` — idempotent startup; checks PID file to prevent duplicate supervisors
- `supervise` is the crash-restarting runtime entrypoint under ProcessManager

## Process Resilience
- `ensure-running` guards against duplicate supervisors via PID file check
- ProcessManager listens for `crash`, `error`, `maxRestartsExceeded` events
- `windowsHide: true` on all spawn calls prevents console window flash
- Mesh layer init wrapped in try-catch (non-fatal failure)
- File descriptor leak fixed (closeSync after supervisor spawn)

## Testing
- `npx vitest run` — runs all tests
- Pre-commit hook runs a subset automatically
- `preserveOpusVersion` has dedicated tests in `__tests__/routing-aliases.test.ts`

## Planned: Codex/ChatGPT OAuth Provider
Route CC requests to GPT-5.4 via Codex CLI's OAuth tokens (`~/.codex/auth.json`). Uses the Responses API at `chatgpt.com/backend-api/codex/responses`, not the standard OpenAI developer API. Requires: token refresh logic, Anthropic ↔ Responses API format conversion, new SSE converter.
