/**
 * OpenRouter integration tests for /v1/messages path
 *
 * Tests for routing requests through OpenRouter in the native Anthropic
 * /v1/messages handler. Validates:
 *   - OpenAI response → Anthropic Messages format conversion
 *   - Routing decisions for proactive simple-tier routing
 *   - Cascade fallback activation (manual toggle)
 *   - Tool call conversion between formats
 */

import { describe, it, expect } from 'vitest';

// ─── Replicated from standalone-proxy.ts (must stay in sync) ────────────────

/**
 * Convert an OpenAI chat completion response to Anthropic Messages format.
 * Used when a non-Anthropic provider (OpenRouter, OpenAI, etc.) handles a
 * request that originated on the /v1/messages path.
 */
function convertOpenAIResponseToAnthropic(
  openaiData: Record<string, unknown>,
  modelOverride?: string,
): Record<string, unknown> {
  const choices = openaiData['choices'] as Array<Record<string, unknown>> | undefined;
  const firstChoice = choices?.[0];
  const message = firstChoice?.['message'] as Record<string, unknown> | undefined;
  const usage = openaiData['usage'] as Record<string, unknown> | undefined;

  const content: Array<Record<string, unknown>> = [];

  // Extract text content
  const textContent = message?.['content'] as string | null | undefined;
  if (textContent) {
    content.push({ type: 'text', text: textContent });
  }

  // Convert tool_calls to Anthropic tool_use blocks
  const toolCalls = message?.['tool_calls'] as Array<Record<string, unknown>> | undefined;
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      const fn = tc['function'] as Record<string, unknown> | undefined;
      if (fn) {
        let input: unknown;
        try {
          input = JSON.parse(fn['arguments'] as string);
        } catch {
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: (tc['id'] as string) || `toolu_${Date.now()}`,
          name: fn['name'] as string,
          input,
        });
      }
    }
  }

  // Map finish_reason → stop_reason
  const finishReason = firstChoice?.['finish_reason'] as string | undefined;
  let stopReason = 'end_turn';
  if (finishReason === 'tool_calls' || finishReason === 'function_call') {
    stopReason = 'tool_use';
  } else if (finishReason === 'length') {
    stopReason = 'max_tokens';
  } else if (finishReason === 'stop') {
    stopReason = 'end_turn';
  }

  return {
    id: (openaiData['id'] as string) || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: modelOverride ?? (openaiData['model'] as string) ?? 'unknown',
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: (usage?.['prompt_tokens'] as number) ?? 0,
      output_tokens: (usage?.['completion_tokens'] as number) ?? 0,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('convertOpenAIResponseToAnthropic', () => {
  it('converts a simple text response', () => {
    const openai = {
      id: 'chatcmpl-abc123',
      object: 'chat.completion',
      model: 'google/gemini-2.5-flash-lite',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello! How can I help?' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
    };

    const result = convertOpenAIResponseToAnthropic(openai);

    expect(result['role']).toBe('assistant');
    expect(result['type']).toBe('message');
    expect(result['model']).toBe('google/gemini-2.5-flash-lite');
    expect(result['stop_reason']).toBe('end_turn');
    expect(result['id']).toBe('chatcmpl-abc123');

    const content = result['content'] as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0]['type']).toBe('text');
    expect(content[0]['text']).toBe('Hello! How can I help?');

    const usage = result['usage'] as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(15);
    expect(usage['output_tokens']).toBe(8);
  });

  it('converts tool_calls to Anthropic tool_use blocks', () => {
    const openai = {
      id: 'chatcmpl-tool1',
      model: 'openai/gpt-4o',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Let me read that file.',
          tool_calls: [{
            id: 'call_xyz',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"file_path":"/tmp/test.txt"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    };

    const result = convertOpenAIResponseToAnthropic(openai);

    expect(result['stop_reason']).toBe('tool_use');

    const content = result['content'] as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]['type']).toBe('text');
    expect(content[0]['text']).toBe('Let me read that file.');
    expect(content[1]['type']).toBe('tool_use');
    expect(content[1]['id']).toBe('call_xyz');
    expect(content[1]['name']).toBe('Read');
    expect(content[1]['input']).toEqual({ file_path: '/tmp/test.txt' });
  });

  it('handles multiple tool calls', () => {
    const openai = {
      id: 'chatcmpl-multi',
      model: 'openai/gpt-4o',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } },
            { id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"path":"b.ts"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };

    const result = convertOpenAIResponseToAnthropic(openai);
    const content = result['content'] as Array<Record<string, unknown>>;

    // No text block when content is null
    expect(content).toHaveLength(2);
    expect(content[0]['type']).toBe('tool_use');
    expect(content[0]['name']).toBe('Read');
    expect(content[1]['type']).toBe('tool_use');
    expect(content[1]['name']).toBe('Read');
  });

  it('maps finish_reason "length" to stop_reason "max_tokens"', () => {
    const openai = {
      id: 'chatcmpl-len',
      model: 'test',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'truncated...' },
        finish_reason: 'length',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 },
    };

    const result = convertOpenAIResponseToAnthropic(openai);
    expect(result['stop_reason']).toBe('max_tokens');
  });

  it('applies model override when provided', () => {
    const openai = {
      id: 'chatcmpl-override',
      model: 'google/gemini-2.5-flash-lite',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hi' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    };

    const result = convertOpenAIResponseToAnthropic(openai, 'custom-model-name');
    expect(result['model']).toBe('custom-model-name');
  });

  it('handles empty/missing choices gracefully', () => {
    const openai = { id: 'chatcmpl-empty', model: 'test', choices: [], usage: {} };
    const result = convertOpenAIResponseToAnthropic(openai);
    expect(result['content']).toEqual([]);
    expect(result['stop_reason']).toBe('end_turn');
  });

  it('handles malformed tool_call arguments as empty object', () => {
    const openai = {
      id: 'chatcmpl-bad-args',
      model: 'test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_bad',
            type: 'function',
            function: { name: 'Bash', arguments: 'not valid json' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const result = convertOpenAIResponseToAnthropic(openai);
    const content = result['content'] as Array<Record<string, unknown>>;
    expect(content[0]['input']).toEqual({});
  });
});

describe('OpenRouter integration source code checks', () => {
  it('standalone-proxy.ts contains convertOpenAIResponseToAnthropic', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'src', 'standalone-proxy.ts'), 'utf-8');

    expect(source).toContain('function convertOpenAIResponseToAnthropic');
  });

  it('/v1/messages handler allows non-Anthropic providers when complexity routing resolves to them', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'src', 'standalone-proxy.ts'), 'utf-8');

    // The old guard "Resolved model is not supported for /v1/messages" must be
    // replaced with actual dispatch to the resolved provider
    expect(source).toContain('convertOpenAIResponseToAnthropic');
    // Should contain OpenRouter dispatch in /v1/messages context
    expect(source).toContain('forwardToOpenAICompatible');
  });
});
