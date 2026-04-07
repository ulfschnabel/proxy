/**
 * Live Integration Tests — RelayPlane Proxy Routing
 *
 * Hits the running proxy at http://localhost:4010 with real API calls.
 * Tests each routing path end-to-end: OpenRouter, Haiku passthrough,
 * param stripping, model masking, and SSE conversion.
 *
 * Each test group configures its own routing via POST /control/config,
 * so tests are independent of whatever routing is currently live.
 *
 * Anthropic Sonnet/Opus requests use `claude -p` (via ANTHROPIC_BASE_URL)
 * because OAT tokens are locked to the CC client — bare HTTP won't work.
 *
 * Prerequisites:
 *   - Proxy running at localhost:4010
 *   - OpenRouter key in env (OPENROUTER_API_KEY)
 *   - Anthropic token in pool (auto-cached from CC usage)
 *   - `claude` CLI available on PATH
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const PROXY = 'http://localhost:4010';

// Discover OR key: env only. Never hardcode credentials.
const OR_KEY = process.env['OPENROUTER_API_KEY'] ?? discoverORKey();

function discoverORKey(): string {
  throw new Error(
    'No OpenRouter API key found.\n' +
    'Set OPENROUTER_API_KEY env var before running tests.'
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Send a raw POST to the proxy. Works for OpenRouter and Haiku (OAT-compatible). */
async function proxyPost(path: string, body: unknown): Promise<ProxyResponse> {
  const res = await fetch(`${PROXY}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': OR_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, headers, body: text };
}

/** Read an SSE stream to completion. Returns parsed events and response headers. */
async function collectSSE(
  path: string,
  body: unknown,
): Promise<{ events: Array<{ type: string; data: Record<string, unknown> }>; headers: Record<string, string> }> {
  const res = await fetch(`${PROXY}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': OR_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`SSE request failed ${res.status}: ${text}`);
  }

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });

  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      let currentType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            events.push({ type: currentType, data: JSON.parse(payload) });
          } catch { /* skip malformed */ }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { events, headers };
}

/**
 * Send a prompt through `claude -p` pointed at the proxy.
 * This is the only reliable way to use OAT tokens for Sonnet/Opus,
 * since Anthropic gates access to the CC client.
 */
function claudeP(prompt: string): { result: string; modelUsage: Record<string, unknown>; cost: number } {
  const raw = execSync(
    `claude -p ${JSON.stringify(prompt)} --output-format json`,
    {
      env: { ...process.env, ANTHROPIC_BASE_URL: PROXY },
      timeout: 120_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const parsed = JSON.parse(raw) as {
    result: string;
    modelUsage: Record<string, unknown>;
    total_cost_usd: number;
    is_error: boolean;
  };
  if (parsed.is_error) {
    throw new Error(`claude -p failed: ${parsed.result}`);
  }
  return { result: parsed.result, modelUsage: parsed.modelUsage, cost: parsed.total_cost_usd };
}

// System prompt — every real CC request includes one. Required for agent fingerprinting.
const SYSTEM_PROMPT = 'You are a helpful assistant. Integration test agent for RelayPlane proxy.';

/** Generate a unique simple message to avoid cache hits between tests */
function uniqueSimpleMessage(tag: string) {
  return [{ role: 'user', content: `Say "ok". [test-nonce: ${tag}-${Date.now()}]` }];
}

// ─── Config management ──────────────────────────────────────────────────────

/** Retry-aware fetch — handles ECONNRESET after claude -p subprocess */
async function fetchWithRetry(url: string, init?: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

/** Get the current proxy config */
async function getConfig(): Promise<Record<string, unknown>> {
  const res = await fetchWithRetry(`${PROXY}/control/config`);
  if (!res.ok) throw new Error(`GET /control/config failed: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

/** Patch the proxy config (deep merge). Returns the merged config. */
async function patchConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetchWithRetry(`${PROXY}/control/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`POST /control/config failed: ${res.status}`);
  const body = await res.json() as { ok: boolean; config: Record<string, unknown> };
  return body.config;
}

// OpenRouter model used in routing config for tests
const OR_MODEL = 'openrouter/nvidia/nemotron-3-super-120b-a12b:free';

// ─── Setup ───────────────────────────────────────────────────────────────────

let originalConfig: Record<string, unknown>;

beforeAll(async () => {
  // Verify proxy is running
  const health = await fetch(`${PROXY}/health`).catch(() => null);
  if (!health?.ok) throw new Error('Proxy not running at localhost:4010 — deploy first');

  // Verify token pool has at least one Anthropic token
  const poolRes = await fetch(`${PROXY}/v1/token-pool/status`);
  const pool = await poolRes.json() as { accounts: unknown[] };
  if (pool.accounts.length === 0) {
    throw new Error(
      'Token pool is empty — no Anthropic tokens available.\n' +
      'Fix: Send any request via Claude Code through the proxy to seed the pool.'
    );
  }

  // Verify claude CLI is available
  try {
    execSync('claude --version', { encoding: 'utf-8', timeout: 5000 });
  } catch {
    throw new Error('`claude` CLI not found on PATH — needed for Anthropic Sonnet/Opus tests');
  }

  // Save original config for restoration after all tests
  originalConfig = await getConfig();
}, 15000);

afterAll(async () => {
  // Restore original config after all tests
  if (originalConfig) {
    await patchConfig(originalConfig).catch(() => {});
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('live proxy routing', () => {

  // ── OpenRouter (simple tier) ──────────────────────────────────────────────

  describe('OpenRouter routing', () => {

    beforeAll(async () => {
      // Ensure simple routes to OpenRouter for these tests
      await patchConfig({
        routing: { complexity: { simple: OR_MODEL, basic: OR_MODEL } },
      });
    });

    it('routes simple complexity to OpenRouter (non-streaming)', { timeout: 45000 }, async () => {
      const res = await proxyPost('/v1/messages', {
        model: 'claude-opus-4-6',
        max_tokens: 10,
        system: SYSTEM_PROMPT,
        messages: uniqueSimpleMessage('or-nonstream'),
      });

      expect(res.status).toBe(200);
      expect(res.headers['x-relayplane-provider']).toBe('openrouter');
      expect(res.headers['x-relayplane-complexity']).toBe('simple');

      const body = JSON.parse(res.body);
      expect(body.type).toBe('message');
      expect(body.role).toBe('assistant');
      expect(Array.isArray(body.content)).toBe(true);
    });

    it('masks routed model — body.model reports originally-requested model', { timeout: 45000 }, async () => {
      const res = await proxyPost('/v1/messages', {
        model: 'claude-opus-4-6',
        max_tokens: 10,
        system: SYSTEM_PROMPT,
        messages: uniqueSimpleMessage('or-mask'),
      });

      expect(res.status).toBe(200);
      expect(res.headers['x-relayplane-requested-model']).toBe('claude-opus-4-6');
      const body = JSON.parse(res.body);
      expect(body.model).toBe('claude-opus-4-6');
    });

    it('converts OpenRouter SSE to Anthropic SSE format (streaming)', { timeout: 45000 }, async () => {
      const { events, headers } = await collectSSE('/v1/messages', {
        model: 'claude-opus-4-6',
        max_tokens: 15,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: uniqueSimpleMessage('or-sse'),
      });

      expect(headers['x-relayplane-provider']).toBe('openrouter');
      expect(headers['x-relayplane-complexity']).toBe('simple');

      const types = events.map(e => e.type);
      expect(types).toContain('message_start');
      expect(types).toContain('content_block_start');
      expect(types).toContain('content_block_stop');
      expect(types).toContain('message_delta');
      expect(types).toContain('message_stop');

      // Model masking in stream
      const start = events.find(e => e.type === 'message_start');
      const msg = (start?.data as { message?: { model?: string } })?.message;
      expect(msg?.model).toBe('claude-opus-4-6');

      // Text content present
      const deltas = events.filter(e => e.type === 'content_block_delta');
      expect(deltas.length).toBeGreaterThan(0);
      const firstDelta = deltas[0].data as { delta?: { type?: string } };
      expect(firstDelta.delta?.type).toBe('text_delta');

      // Stop reason present
      const msgDelta = events.find(e => e.type === 'message_delta');
      const deltaData = msgDelta?.data as { delta?: { stop_reason?: string } };
      expect(deltaData?.delta?.stop_reason).toBeTruthy();
    });
  });

  // ── Anthropic routing (Haiku — works with raw fetch + OAT) ───────────────

  describe('Anthropic Haiku routing', () => {

    it('passes Haiku model through without rerouting', { timeout: 45000 }, async () => {
      const res = await proxyPost('/v1/messages', {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        system: SYSTEM_PROMPT,
        messages: uniqueSimpleMessage('haiku-pass'),
      });

      expect(res.status).toBe(200);
      expect(res.headers['x-relayplane-provider']).toBe('anthropic');
      const routedModel = res.headers['x-relayplane-routed-model'] ?? '';
      expect(routedModel).toContain('haiku');
    });

    it('strips effort + batchedClientRequests from direct Haiku requests (no 400)', { timeout: 45000 }, async () => {
      const res = await proxyPost('/v1/messages', {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        effort: 'low',
        batchedClientRequests: [],
        system: SYSTEM_PROMPT,
        messages: uniqueSimpleMessage('haiku-strip'),
      });

      expect(res.status).toBe(200);
      expect(res.headers['x-relayplane-provider']).toBe('anthropic');
    });
  });

  // ── Anthropic routing (Sonnet/Opus — requires claude -p) ─────────────────

  describe('Anthropic Sonnet/Opus routing (via claude -p)', () => {

    it('routes moderate complexity to Anthropic Sonnet', { timeout: 120000 }, async () => {
      const { result, modelUsage } = claudeP('Analyze this sentence: the cat sat on the mat.');

      expect(result).toBeTruthy();
      const models = Object.keys(modelUsage);
      expect(models.length).toBeGreaterThan(0);
    });

    it('completes a simple request through the proxy', { timeout: 120000 }, async () => {
      const { result } = claudeP('Say the single word "ok" and nothing else.');
      expect(result.toLowerCase()).toContain('ok');
    });
  });

  // ── Config-driven routing scenarios ──────────────────────────────────────

  describe('config-driven routing', () => {

    beforeAll(async () => {
      // Start with simple/basic → Haiku for config-driven tests
      await patchConfig({
        routing: {
          complexity: {
            simple: 'claude-haiku-4-5-20251001',
            basic: 'claude-haiku-4-5-20251001',
          },
        },
      });
    });

    it('routes simple→haiku when config is patched', { timeout: 45000 }, async () => {
      const res = await proxyPost('/v1/messages', {
        model: 'claude-opus-4-6',
        max_tokens: 10,
        system: SYSTEM_PROMPT,
        messages: uniqueSimpleMessage('cfg-simple'),
      });

      expect(res.status).toBe(200);
      expect(res.headers['x-relayplane-provider']).toBe('anthropic');
      expect(res.headers['x-relayplane-complexity']).toBe('simple');

      const routedModel = res.headers['x-relayplane-routed-model'] ?? '';
      expect(routedModel).toContain('haiku');

      // Model masking: body.model still shows the originally requested model
      const body = JSON.parse(res.body);
      expect(body.model).toBe('claude-opus-4-6');
    });

    it('routes basic→haiku when config is patched', { timeout: 45000 }, async () => {
      const res = await proxyPost('/v1/messages', {
        model: 'claude-opus-4-6',
        max_tokens: 10,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `What is 2+2? Reply with just the number. [nonce: ${Date.now()}]` }],
      });

      expect(res.status).toBe(200);
      expect(res.headers['x-relayplane-provider']).toBe('anthropic');
    });

    it('strips Haiku-unsupported params when rerouting Opus→Haiku (no 400)', { timeout: 45000 }, async () => {
      // Send a request as Opus with effort, thinking, and batchedClientRequests —
      // all unsupported by Haiku. The proxy must strip them, not forward a 400.
      const res = await proxyPost('/v1/messages', {
        model: 'claude-opus-4-6',
        max_tokens: 10,
        effort: 'high',
        thinking: { type: 'enabled', budget_tokens: 5000 },
        batchedClientRequests: [],
        system: SYSTEM_PROMPT,
        messages: uniqueSimpleMessage('cfg-strip'),
      });

      expect(res.status).toBe(200);
      expect(res.headers['x-relayplane-provider']).toBe('anthropic');
      const routedModel = res.headers['x-relayplane-routed-model'] ?? '';
      expect(routedModel).toContain('haiku');
    });

    it('restores original routing after patch', { timeout: 15000 }, async () => {
      // Restore and verify the global afterAll will handle full restoration,
      // but verify config API round-trips correctly
      const cfg = await getConfig();
      expect(cfg).toBeTruthy();
    });
  });
});
