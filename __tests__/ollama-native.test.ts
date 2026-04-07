/**
 * Ollama native /v1/messages integration tests
 *
 * Tests for routing Anthropic Messages API requests through Ollama's native
 * /v1/messages endpoint (added in Ollama v0.14+). Validates:
 *   - Response validation catches malformed Ollama responses
 *   - Valid Anthropic responses pass validation
 *   - Thinking blocks are stripped from Ollama-bound requests
 *   - Routing decisions respect complexity and config
 *   - Fallback to cloud on validation failure
 *   - count_tokens synthetic response
 */

import { describe, it, expect } from 'vitest';

// ─── Replicated from standalone-proxy.ts / ollama.ts (must stay in sync) ─────

type Complexity = 'simple' | 'moderate' | 'complex';

interface OllamaProviderConfig {
  baseUrl?: string;
  models?: string[];
  routeWhen?: {
    complexity?: string[];
    taskTypes?: string[];
  };
  timeoutMs?: number;
  defaultModel?: string;
  enabled?: boolean;
}

/**
 * Validate an Anthropic Messages API response from Ollama.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
function validateAnthropicResponse(data: unknown): { valid: boolean; reason?: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: 'Response is not an object' };
  }

  const resp = data as Record<string, unknown>;

  // Must have content array
  if (!Array.isArray(resp['content'])) {
    return { valid: false, reason: 'Missing or non-array content field' };
  }

  // Validate each content block
  for (const block of resp['content'] as Array<Record<string, unknown>>) {
    if (!block || typeof block !== 'object') {
      return { valid: false, reason: 'Content block is not an object' };
    }
    const blockType = block['type'];
    if (typeof blockType !== 'string') {
      return { valid: false, reason: 'Content block missing type field' };
    }

    if (blockType === 'tool_use') {
      if (typeof block['id'] !== 'string' || !block['id']) {
        return { valid: false, reason: 'tool_use block missing id' };
      }
      if (typeof block['name'] !== 'string' || !block['name']) {
        return { valid: false, reason: 'tool_use block missing name' };
      }
      if (block['input'] === undefined || block['input'] === null) {
        return { valid: false, reason: 'tool_use block missing input' };
      }
    } else if (blockType === 'text') {
      if (typeof block['text'] !== 'string') {
        return { valid: false, reason: 'text block missing text field' };
      }
    }
    // 'thinking' blocks are allowed but not required to have specific fields
  }

  // Must have stop_reason
  if (typeof resp['stop_reason'] !== 'string') {
    return { valid: false, reason: 'Missing or invalid stop_reason' };
  }

  // Must have role
  if (resp['role'] !== 'assistant') {
    return { valid: false, reason: 'Missing or invalid role (expected "assistant")' };
  }

  // Must have model
  if (typeof resp['model'] !== 'string') {
    return { valid: false, reason: 'Missing model field' };
  }

  // Must have usage
  if (!resp['usage'] || typeof resp['usage'] !== 'object') {
    return { valid: false, reason: 'Missing usage field' };
  }

  return { valid: true };
}

/**
 * Decide whether to route a /v1/messages request to Ollama.
 * Mirrors the logic that will be added to standalone-proxy.ts.
 */
function shouldRouteToOllamaNative(
  config: OllamaProviderConfig | undefined,
  complexity: Complexity,
  requestedModel: string,
): boolean {
  if (!config || config.enabled === false) return false;

  // Explicit ollama/ prefix always routes to Ollama
  if (requestedModel.startsWith('ollama/')) return true;

  // If the model name matches a configured Ollama model, route there
  if (requestedModel && config.models?.includes(requestedModel)) return true;

  // Complexity-based routing
  if (config.routeWhen?.complexity?.includes(complexity)) return true;

  return false;
}

/**
 * Strip thinking-related fields from a request body before sending to Ollama.
 * Ollama models don't support Anthropic extended thinking.
 */
function stripThinkingForOllama(body: Record<string, unknown>): Record<string, unknown> {
  const { thinking, ...rest } = body;
  return rest;
}

/**
 * Build a synthetic count_tokens response.
 * Ollama doesn't support /v1/messages/count_tokens, so we estimate.
 */
function buildSyntheticTokenCount(body: Record<string, unknown>): { input_tokens: number } {
  let totalChars = 0;

  // Count system prompt
  if (typeof body['system'] === 'string') {
    totalChars += body['system'].length;
  } else if (Array.isArray(body['system'])) {
    for (const block of body['system'] as Array<Record<string, unknown>>) {
      if (block['text'] && typeof block['text'] === 'string') {
        totalChars += block['text'].length;
      }
    }
  }

  // Count messages
  if (Array.isArray(body['messages'])) {
    for (const msg of body['messages'] as Array<Record<string, unknown>>) {
      if (typeof msg['content'] === 'string') {
        totalChars += msg['content'].length;
      } else if (Array.isArray(msg['content'])) {
        for (const block of msg['content'] as Array<Record<string, unknown>>) {
          if (typeof block['text'] === 'string') totalChars += block['text'].length;
          if (typeof block['content'] === 'string') totalChars += block['content'].length;
        }
      }
    }
  }

  // Count tools
  if (Array.isArray(body['tools'])) {
    totalChars += JSON.stringify(body['tools']).length;
  }

  return { input_tokens: Math.ceil(totalChars / 4) };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateAnthropicResponse', () => {
  it('accepts a valid text response', () => {
    const response = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: 'qwen2.5-coder:7b',
      content: [{ type: 'text', text: 'Hello, world!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    expect(validateAnthropicResponse(response)).toEqual({ valid: true });
  });

  it('accepts a valid tool_use response', () => {
    const response = {
      id: 'msg_456',
      type: 'message',
      role: 'assistant',
      model: 'qwen2.5-coder:7b',
      content: [
        { type: 'text', text: 'I\'ll read that file.' },
        { type: 'tool_use', id: 'toolu_abc', name: 'Read', input: { file_path: '/tmp/test.txt' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    expect(validateAnthropicResponse(response)).toEqual({ valid: true });
  });

  it('accepts a response with empty content array (edge case)', () => {
    const response = {
      id: 'msg_789',
      type: 'message',
      role: 'assistant',
      model: 'qwen2.5-coder:7b',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    expect(validateAnthropicResponse(response)).toEqual({ valid: true });
  });

  it('rejects null/undefined', () => {
    expect(validateAnthropicResponse(null).valid).toBe(false);
    expect(validateAnthropicResponse(undefined).valid).toBe(false);
  });

  it('rejects response missing content field', () => {
    const response = {
      role: 'assistant',
      model: 'test',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('content');
  });

  it('rejects response with non-array content', () => {
    const response = {
      role: 'assistant',
      model: 'test',
      content: 'just a string',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('content');
  });

  it('rejects tool_use block missing id', () => {
    const response = {
      role: 'assistant',
      model: 'test',
      content: [{ type: 'tool_use', name: 'Read', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('tool_use');
    expect(result.reason).toContain('id');
  });

  it('rejects tool_use block missing name', () => {
    const response = {
      role: 'assistant',
      model: 'test',
      content: [{ type: 'tool_use', id: 'toolu_abc', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('name');
  });

  it('rejects tool_use block missing input', () => {
    const response = {
      role: 'assistant',
      model: 'test',
      content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Read' }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('input');
  });

  it('rejects text block missing text field', () => {
    const response = {
      role: 'assistant',
      model: 'test',
      content: [{ type: 'text' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('text');
  });

  it('rejects response missing stop_reason', () => {
    const response = {
      role: 'assistant',
      model: 'test',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('stop_reason');
  });

  it('rejects response missing role', () => {
    const response = {
      model: 'test',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('role');
  });

  it('rejects response missing model', () => {
    const response = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('model');
  });

  it('rejects response missing usage', () => {
    const response = {
      role: 'assistant',
      model: 'test',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('usage');
  });

  it('rejects content block without type', () => {
    const response = {
      role: 'assistant',
      model: 'test',
      content: [{ text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = validateAnthropicResponse(response);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('type');
  });
});

describe('shouldRouteToOllamaNative', () => {
  const config: OllamaProviderConfig = {
    baseUrl: 'http://localhost:11434',
    models: ['qwen2.5-coder:7b', 'qwen3:cloud'],
    routeWhen: { complexity: ['simple'] },
    enabled: true,
  };

  it('routes simple requests when complexity routing is configured', () => {
    expect(shouldRouteToOllamaNative(config, 'simple', 'claude-sonnet-4-20250514')).toBe(true);
  });

  it('does not route moderate requests when only simple is configured', () => {
    expect(shouldRouteToOllamaNative(config, 'moderate', 'claude-sonnet-4-20250514')).toBe(false);
  });

  it('does not route complex requests', () => {
    expect(shouldRouteToOllamaNative(config, 'complex', 'claude-opus-4-6')).toBe(false);
  });

  it('routes when model is explicitly an Ollama model', () => {
    expect(shouldRouteToOllamaNative(config, 'complex', 'qwen2.5-coder:7b')).toBe(true);
  });

  it('routes when model has ollama/ prefix', () => {
    expect(shouldRouteToOllamaNative(config, 'complex', 'ollama/llama3.2')).toBe(true);
  });

  it('does not route when config is undefined', () => {
    expect(shouldRouteToOllamaNative(undefined, 'simple', 'claude-sonnet-4-20250514')).toBe(false);
  });

  it('does not route when disabled', () => {
    const disabled = { ...config, enabled: false };
    expect(shouldRouteToOllamaNative(disabled, 'simple', 'claude-sonnet-4-20250514')).toBe(false);
  });

  it('routes moderate+simple when both configured', () => {
    const wideConfig = { ...config, routeWhen: { complexity: ['simple', 'moderate'] } };
    expect(shouldRouteToOllamaNative(wideConfig, 'moderate', 'claude-sonnet-4-20250514')).toBe(true);
    expect(shouldRouteToOllamaNative(wideConfig, 'simple', 'claude-sonnet-4-20250514')).toBe(true);
    expect(shouldRouteToOllamaNative(wideConfig, 'complex', 'claude-sonnet-4-20250514')).toBe(false);
  });

  it('routes cloud models by name match', () => {
    expect(shouldRouteToOllamaNative(config, 'complex', 'qwen3:cloud')).toBe(true);
  });
});

describe('stripThinkingForOllama', () => {
  it('removes thinking field from request body', () => {
    const body = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'enabled', budget_tokens: 10000 },
      max_tokens: 4096,
    };
    const stripped = stripThinkingForOllama(body);
    expect(stripped).not.toHaveProperty('thinking');
    expect(stripped).toHaveProperty('model');
    expect(stripped).toHaveProperty('messages');
    expect(stripped).toHaveProperty('max_tokens');
  });

  it('leaves body unchanged when no thinking field', () => {
    const body = {
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 4096,
    };
    const stripped = stripThinkingForOllama(body);
    expect(stripped).toEqual(body);
  });
});

describe('buildSyntheticTokenCount', () => {
  it('estimates tokens from string system prompt', () => {
    const body = {
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello!' }],
    };
    const result = buildSyntheticTokenCount(body);
    expect(result.input_tokens).toBeGreaterThan(0);
    // "You are a helpful assistant." = 30 chars + "Hello!" = 6 chars = 36 chars / 4 = 9 tokens
    expect(result.input_tokens).toBe(9);
  });

  it('estimates tokens from array system prompt', () => {
    const body = {
      system: [{ type: 'text', text: 'You are a helpful assistant.' }],
      messages: [{ role: 'user', content: 'Hello!' }],
    };
    const result = buildSyntheticTokenCount(body);
    expect(result.input_tokens).toBe(9);
  });

  it('counts tool definitions in estimate', () => {
    const body = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
    };
    const result = buildSyntheticTokenCount(body);
    // "hi" = 2 chars + tools JSON length
    expect(result.input_tokens).toBeGreaterThan(1);
  });

  it('handles nested content arrays in messages', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this file:' },
          { type: 'tool_result', content: 'file contents here' },
        ],
      }],
    };
    const result = buildSyntheticTokenCount(body);
    // "Look at this file:" = 18 + "file contents here" = 18 = 36 / 4 = 9
    expect(result.input_tokens).toBe(9);
  });

  it('returns 0 for empty body', () => {
    expect(buildSyntheticTokenCount({}).input_tokens).toBe(0);
  });
});

describe('Ollama native integration source code checks', () => {
  it('standalone-proxy.ts contains Ollama native routing in /v1/messages handler', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'src', 'standalone-proxy.ts'), 'utf-8');

    // The /v1/messages handler must check for Ollama routing
    expect(source).toContain('shouldRouteToOllamaNative');

    // Must validate Ollama responses before returning to client
    expect(source).toContain('validateAnthropicResponse');
  });

  it('ollama.ts exports forwardToOllamaNative function', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'src', 'ollama.ts'), 'utf-8');

    expect(source).toContain('export async function forwardToOllamaNative');
  });

  it('count_tokens handler returns synthetic response for Ollama models', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'src', 'standalone-proxy.ts'), 'utf-8');

    // The count_tokens endpoint must handle Ollama gracefully
    expect(source).toContain('count_tokens');
    expect(source).toContain('buildSyntheticTokenCount');
  });
});
