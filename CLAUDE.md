# RelayPlane Proxy

Local AI proxy for Claude Code. Routes requests by complexity to save cost.

## Current Routing
- simple/basic → Haiku (cheap, session's own OAT auth passes through)
- moderate → Sonnet
- complex → Opus

## Key Architecture
- `src/model-sanitizer.ts` — centralized param/beta stripping per model. ALL Anthropic requests go through `forwardNativeAnthropicRequest` which calls this.
- `src/openai-to-anthropic-stream.ts` — OpenAI SSE → Anthropic SSE converter for non-Anthropic providers
- `src/token-pool.ts` — multi-account token pool (rate limit tracking, not used for auth override)
- Config: `~/.relayplane/config.json`, live-reloaded via fs.watch, patchable via `POST /control/config`
- Deploy: `npm run deploy` (Node-based release flow: validate → pack → backup → stop → install → start → health check) from an admin terminal on Windows.
- Windows runtime: `start-service.cmd` / `restart-service.cmd` launch `dist/cli.js ensure-running --port 4010 --host 127.0.0.1`, which spawns `supervise` under `ProcessManager` so the proxy restarts on crash.
- Windows service: `node dist/cli.js service install` registers two Task Scheduler tasks — "RelayPlane Proxy (Logon)" (starts at login) and "RelayPlane Proxy (Watchdog)" (runs every 5 min as a watchdog to revive a dead supervisor). Uses `~/.relayplane/watchdog.cmd` as the task action.
- Agent-managed launch: use `node dist/cli.js ensure-running --port 4010 --host 127.0.0.1` for idempotent startup; `supervise` is the crash-restarting runtime entrypoint.
- After changing runtime code, always run `npm run build` before restarting so the scripts pick up the new `dist/` output.
- The supervised proxy must remain up; if it exits, restart via the supervised path rather than a raw shell launch.
- The active Windows service/task should point at the supervised entrypoint, not a plain `node dist/cli.js` shell launch.

## Planned: Codex/ChatGPT OAuth Provider
Route CC requests to GPT-5.4 via Codex CLI's OAuth tokens (`~/.codex/auth.json`). Uses the Responses API at `chatgpt.com/backend-api/codex/responses`, not the standard OpenAI developer API. Requires: token refresh logic, Anthropic ↔ Responses API format conversion, new SSE converter. Full plan at `~/.claude/plans/quirky-finding-castle.md`.
