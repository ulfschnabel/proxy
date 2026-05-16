/**
 * Codex/ChatGPT OAuth provider for routing requests to OpenAI GPT models
 * via the Responses API using Codex CLI credentials.
 *
 * Uses the official OpenAI SDK with OAuth tokens from ~/.codex/auth.json.
 * The Codex backend requires streaming — non-streaming responses are
 * collected from the stream and returned as a complete Anthropic message.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import OpenAI from 'openai';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CodexAuthFile {
  tokens: {
    access_token: string;
    refresh_token: string;
    account_id: string;
    expires_at?: number;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

export interface AnthropicBody {
  model: string;
  messages: ChatMessage[];
  system?: string | Array<{ type: string; text: string }>;
  max_tokens?: number;
  temperature?: number;
  thinking?: { type: string; budget_tokens?: number };
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: string; name?: string };
  stream?: boolean;
  [key: string]: unknown;
}

export interface CodexRequestOptions {
  isStreaming?: boolean;
  sessionId?: string;
}

// ─── Token Management ────────────────────────────────────────────────────────

let cachedToken: {
  access_token: string;
  expires_at: number;
  account_id: string;
  refresh_token: string;
} | null = null;

let cachedClient: OpenAI | null = null;

function getCodexAuthPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

/**
 * Load and cache Codex credentials. Refreshes expired tokens automatically.
 */
export async function getCodexAccessToken(): Promise<{
  access_token: string;
  account_id: string;
  refresh_token: string;
}> {
  const authPath = getCodexAuthPath();

  if (cachedToken && cachedToken.expires_at > Date.now() + 5 * 60 * 1000) {
    return {
      access_token: cachedToken.access_token,
      account_id: cachedToken.account_id,
      refresh_token: cachedToken.refresh_token,
    };
  }

  if (!fs.existsSync(authPath)) {
    throw new Error(`Codex auth file not found: ${authPath}`);
  }

  const authFile: CodexAuthFile = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
  const { access_token, refresh_token, account_id, expires_at } = authFile.tokens;

  // Determine expiry: prefer stored expires_at, fall back to JWT exp claim
  const now = Date.now();
  let tokenExp = expires_at ?? 0;
  if (!tokenExp) {
    try {
      const parts = access_token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        if (payload.exp) tokenExp = payload.exp * 1000;
      }
    } catch { /* fall through to refresh */ }
  }

  if (tokenExp <= now + 5 * 60 * 1000) {
    const refreshed = await refreshCodexAccessToken(refresh_token);
    cachedToken = {
      access_token: refreshed.access_token,
      account_id,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
    };
    cachedClient = null; // Force new client with fresh token
    return { access_token: refreshed.access_token, account_id, refresh_token: refreshed.refresh_token };
  }

  cachedToken = { access_token, account_id, refresh_token, expires_at: tokenExp };
  return { access_token, account_id, refresh_token };
}

async function refreshCodexAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
}> {
  const authPath = getCodexAuthPath();
  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'pdlLIX2Y72MIl2rhLhRE9KlCd8J0nVlh',
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh Codex token: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  let expiresAt = Date.now() + result.expires_in * 1000;
  try {
    const parts = result.access_token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      if (payload.exp) expiresAt = payload.exp * 1000;
    }
  } catch { /* use expires_in fallback */ }

  // Persist to disk
  const authFile: CodexAuthFile = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
  authFile.tokens.access_token = result.access_token;
  authFile.tokens.refresh_token = result.refresh_token;
  authFile.tokens.expires_at = expiresAt;
  fs.writeFileSync(authPath, JSON.stringify(authFile, null, 2));

  return { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: expiresAt };
}

// ─── OpenAI Client ───────────────────────────────────────────────────────────

async function getCodexClient(): Promise<OpenAI> {
  if (cachedClient) return cachedClient;
  const { access_token, account_id } = await getCodexAccessToken();
  cachedClient = new OpenAI({
    apiKey: access_token,
    baseURL: 'https://chatgpt.com/backend-api/codex',
    defaultHeaders: { 'ChatGPT-Account-ID': account_id },
  });
  return cachedClient;
}

// ─── Format Conversion ───────────────────────────────────────────────────────

function extractSystem(system: AnthropicBody['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/**
 * Convert Anthropic messages (with tool_use, tool_result, thinking blocks)
 * to Responses API input items.
 *
 * Anthropic uses content arrays with typed blocks inside role-based messages.
 * Responses API uses flat input items where function_call and function_call_output
 * are top-level items (not nested inside a role message).
 */
function convertMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      input.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Content is an array of blocks — may contain text, tool_use, tool_result, thinking
    const textParts: string[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push((block as any).text);
          break;

        case 'tool_use':
          // Flush accumulated text before the tool call
          if (textParts.length > 0) {
            input.push({ role: msg.role, content: textParts.join('\n') });
            textParts.length = 0;
          }
          // Anthropic tool_use → Responses API function_call input item
          input.push({
            type: 'function_call',
            name: (block as any).name,
            call_id: (block as any).id || `call_${Date.now().toString(36)}`,
            arguments: JSON.stringify((block as any).input ?? {}),
          });
          break;

        case 'tool_result':
          // Flush accumulated text
          if (textParts.length > 0) {
            input.push({ role: msg.role, content: textParts.join('\n') });
            textParts.length = 0;
          }
          // Anthropic tool_result → Responses API function_call_output input item
          {
            let output: string;
            const resultContent = (block as any).content;
            if (typeof resultContent === 'string') {
              output = resultContent;
            } else if (Array.isArray(resultContent)) {
              output = resultContent
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n');
            } else {
              output = JSON.stringify(resultContent ?? '');
            }
            input.push({
              type: 'function_call_output',
              call_id: (block as any).tool_use_id,
              output,
            });
          }
          break;

        case 'thinking':
          // Drop thinking blocks — Responses API uses reasoning.effort instead
          break;

        default:
          // Unknown block type — include as text if it has text content
          if ((block as any).text) textParts.push((block as any).text);
          break;
      }
    }

    // Flush remaining text
    if (textParts.length > 0) {
      input.push({ role: msg.role, content: textParts.join('\n') });
    }
  }

  return input;
}

export function convertAnthropicToResponsesAPI(
  body: AnthropicBody,
  targetModel: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: targetModel,
    instructions: extractSystem(body.system),
    input: convertMessages(body.messages),
    store: false,
    stream: true, // Codex backend requires streaming
  };

  if (body.temperature !== undefined) params.temperature = body.temperature;

  // Map thinking effort → reasoning effort
  if (body.thinking) {
    const budget = (body.thinking as any).budget_tokens ?? 5000;
    let effort: string;
    if (budget <= 2000) effort = 'low';
    else if (budget >= 10000) effort = 'high';
    else effort = 'medium';
    params.reasoning = { effort };
  }

  // Map Anthropic tools → Responses API function tools
  // Codex backend expects { type, name, description, parameters } at top level
  if (body.tools && body.tools.length > 0) {
    params.tools = body.tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  }

  return params;
}

// ─── Anthropic SSE helpers ───────────────────────────────────────────────────

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─── Streaming: Responses API → Anthropic SSE ────────────────────────────────

export interface ResponsesAPIToAnthropicStreamResult {
  stream: AsyncGenerator<string>;
  getUsage: () => { inputTokens: number; outputTokens: number; stopReason: string };
}

/**
 * Stream a request to the Codex Responses API via the OpenAI SDK and
 * yield Anthropic-format SSE events that Claude Code can consume.
 */
export function convertResponsesAPIStreamToAnthropic(
  sdkStream: AsyncIterable<any>,
  messageId: string,
  model: string,
): ResponsesAPIToAnthropicStreamResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';

  const stream = (async function* () {
    let nextBlockIndex = 0;
    let textBlockIndex = -1;
    // Track tool call blocks by call_id (from output_item.added events)
    const toolBlockById = new Map<string, { blockIdx: number; name: string }>();
    // Pending tool call metadata from output_item.added (arrives before argument deltas)
    let pendingToolCall: { call_id: string; name: string } | null = null;

    // message_start
    yield sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant', content: [], model,
        stop_reason: null, stop_sequence: null, stop_details: null,
        usage: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    yield sseEvent('ping', { type: 'ping' });

    for await (const event of sdkStream) {
      const eventType = event.type as string;

      // ── Text delta ──
      if (eventType === 'response.output_text.delta') {
        const delta = event.delta as string;
        if (delta) {
          if (textBlockIndex === -1) {
            textBlockIndex = nextBlockIndex++;
            yield sseEvent('content_block_start', {
              type: 'content_block_start', index: textBlockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          yield sseEvent('content_block_delta', {
            type: 'content_block_delta', index: textBlockIndex,
            delta: { type: 'text_delta', text: delta },
          });
        }
      }

      // ── Tool call: output_item.added carries name + call_id ──
      if (eventType === 'response.output_item.added') {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call') {
          pendingToolCall = {
            call_id: (item.call_id as string) || `call_${Date.now().toString(36)}`,
            name: (item.name as string) || 'unknown',
          };
        }
      }

      // ── Tool call argument delta ──
      if (eventType === 'response.function_call_arguments.delta') {
        const delta = event.delta as string;
        if (delta) {
          // Use pending metadata or fall back to event fields
          const callId = pendingToolCall?.call_id ?? (event.item_id as string) ?? `call_${Date.now().toString(36)}`;
          const fnName = pendingToolCall?.name ?? (event.name as string) ?? 'unknown';

          if (!toolBlockById.has(callId)) {
            // Close text block before first tool call
            if (textBlockIndex !== -1) {
              yield sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
              textBlockIndex = -1;
            }
            const blockIdx = nextBlockIndex++;
            toolBlockById.set(callId, { blockIdx, name: fnName });
            // Emit Anthropic tool_use block with the Responses API call_id as the tool_use id
            yield sseEvent('content_block_start', {
              type: 'content_block_start', index: blockIdx,
              content_block: { type: 'tool_use', id: callId, name: fnName, input: {} },
            });
          }
          const { blockIdx } = toolBlockById.get(callId)!;
          yield sseEvent('content_block_delta', {
            type: 'content_block_delta', index: blockIdx,
            delta: { type: 'input_json_delta', partial_json: delta },
          });
        }
      }

      // ── Function call done — clear pending ──
      if (eventType === 'response.function_call_arguments.done') {
        pendingToolCall = null;
      }

      // ── Completed ──
      if (eventType === 'response.completed') {
        const resp = event.response as Record<string, unknown> | undefined;
        const usage = resp?.usage as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = (usage.input_tokens as number) ?? 0;
          outputTokens = (usage.output_tokens as number) ?? 0;
        }
        const status = resp?.status as string | undefined;
        if (status === 'incomplete') stopReason = 'max_tokens';
      }
    }

    // ── Close blocks ──
    if (textBlockIndex !== -1) {
      yield sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
    }
    for (const { blockIdx } of [...toolBlockById.values()].sort((a, b) => a.blockIdx - b.blockIdx)) {
      yield sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIdx });
    }

    // If tool calls were emitted, stop reason should be tool_use
    if (toolBlockById.size > 0 && stopReason === 'end_turn') {
      stopReason = 'tool_use';
    }

    yield sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    yield sseEvent('message_stop', { type: 'message_stop' });
  })();

  return { stream, getUsage: () => ({ inputTokens, outputTokens, stopReason }) };
}

// ─── Non-Streaming Response Conversion ───────────────────────────────────────

/**
 * Convert a completed Responses API response to Anthropic message format.
 */
export function convertResponsesAPIResponseToAnthropic(
  data: Record<string, unknown>,
  messageId: string,
  model: string,
): Record<string, unknown> {
  const text = (data.output_text as string) ?? '';
  const usage = (data.usage as Record<string, unknown>) ?? {};

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model,
    stop_reason: (data.status as string) === 'incomplete' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: (usage.input_tokens as number) ?? 0,
      output_tokens: (usage.output_tokens as number) ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// ─── Request Forwarding ──────────────────────────────────────────────────────

/**
 * Forward an Anthropic-format request to the Codex Responses API.
 * Always streams (Codex backend requirement).
 *
 * For streaming callers: use the returned SDK stream with convertResponsesAPIStreamToAnthropic.
 * For non-streaming callers: collect output_text from the completed response event.
 */
export async function forwardToResponsesAPI(
  body: AnthropicBody,
  targetModel: string,
  options: CodexRequestOptions = {},
): Promise<{ sdkStream: AsyncIterable<any>; ok: boolean; error?: string }> {
  try {
    const client = await getCodexClient();
    const params = convertAnthropicToResponsesAPI(body, targetModel);

    if (options.sessionId) {
      params.prompt_cache_key = options.sessionId;
    }

    // The SDK returns an async iterable when stream: true
    const stream = await (client.responses as any).create(params);
    return { sdkStream: stream as AsyncIterable<any>, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { sdkStream: (async function* () {})(), ok: false, error: msg };
  }
}
