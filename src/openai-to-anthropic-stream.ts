/**
 * Converts an OpenAI-format SSE stream to Anthropic SSE event strings.
 *
 * Handles text content and tool calls. Emits the full Anthropic event sequence:
 *   message_start → ping → content_block_start → content_block_delta(s) →
 *   content_block_stop → message_delta → message_stop
 *
 * Compatible with OpenRouter, OpenAI, and any provider using the OpenAI
 * chat/completions streaming format (including SSE comment lines like
 * `: OPENROUTER PROCESSING` which are silently skipped).
 */

export interface OpenAIToAnthropicStreamResult {
  /** Async generator yielding Anthropic SSE event strings */
  stream: AsyncGenerator<string>;
  /** Call after iterating stream to completion to get final token counts */
  getUsage: () => { inputTokens: number; outputTokens: number; stopReason: string };
}

/**
 * Convert an OpenAI SSE stream to Anthropic SSE event strings.
 *
 * @param body     ReadableStream from the OpenAI-compatible provider response
 * @param messageId  ID to use in message_start (e.g. "msg_1a2b3c")
 * @param model    Model name to report in message_start (e.g. "claude-opus-4-6")
 */
export function convertOpenAIStreamToAnthropic(
  body: ReadableStream<Uint8Array>,
  messageId: string,
  model: string,
): OpenAIToAnthropicStreamResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';

  const stream = _generateAnthropicEvents(body, messageId, model, {
    setInputTokens: (n: number) => { inputTokens = n; },
    setOutputTokens: (n: number) => { outputTokens = n; },
    setStopReason: (r: string) => { stopReason = r; },
  });

  return {
    stream,
    getUsage: () => ({ inputTokens, outputTokens, stopReason }),
  };
}

// ─── Internal ────────────────────────────────────────────────────────────────

interface UsageCallbacks {
  setInputTokens: (n: number) => void;
  setOutputTokens: (n: number) => void;
  setStopReason: (r: string) => void;
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* _generateAnthropicEvents(
  body: ReadableStream<Uint8Array>,
  messageId: string,
  model: string,
  usage: UsageCallbacks,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  // Tracking state
  let emittedMessageStart = false;
  let nextBlockIndex = 0;
  let textBlockIndex = -1;       // -1 = no text block open
  // Map: OpenAI tool_call index → Anthropic block index
  const toolBlockMap = new Map<number, number>();

  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';

  function buildMessageStart(): string {
    return sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        // Input tokens often only known after stream ends (OpenRouter sends them
        // in the final chunk). We emit 0 here and correct via message_delta.
        usage: {
          input_tokens: inputTokens,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const line of lines) {
        // Skip SSE comments (": OPENROUTER PROCESSING") and blank lines
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // malformed — skip
        }

        const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0];
        const delta = choice?.['delta'] as Record<string, unknown> | undefined;
        const finishReason = choice?.['finish_reason'] as string | null;
        const chunkUsage = chunk['usage'] as Record<string, unknown> | undefined;

        // Capture usage whenever available (OpenRouter sends in final chunk)
        if (chunkUsage) {
          inputTokens = (chunkUsage['prompt_tokens'] as number) ?? inputTokens;
          outputTokens = (chunkUsage['completion_tokens'] as number) ?? outputTokens;
        }

        // Map finish_reason → Anthropic stop_reason
        if (finishReason === 'tool_calls' || finishReason === 'function_call') {
          stopReason = 'tool_use';
        } else if (finishReason === 'length') {
          stopReason = 'max_tokens';
        }
        // 'stop' → 'end_turn' (already the default)

        // Emit message_start + ping on the first parseable chunk
        if (!emittedMessageStart) {
          yield buildMessageStart();
          yield sseEvent('ping', { type: 'ping' });
          emittedMessageStart = true;
        }

        // ── Text content ──────────────────────────────────────────────────
        const text = delta?.['content'] as string | null | undefined;
        if (text) {
          if (textBlockIndex === -1) {
            textBlockIndex = nextBlockIndex++;
            yield sseEvent('content_block_start', {
              type: 'content_block_start',
              index: textBlockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          yield sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text },
          });
        }

        // ── Tool calls ────────────────────────────────────────────────────
        const toolCalls = delta?.['tool_calls'] as Array<Record<string, unknown>> | undefined;
        if (toolCalls && toolCalls.length > 0) {
          // Close text block before the first tool call block
          if (textBlockIndex !== -1) {
            yield sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
            textBlockIndex = -1;
          }

          for (const tc of toolCalls) {
            const tcIdx = (tc['index'] as number) ?? 0;
            const fn = tc['function'] as Record<string, unknown> | undefined;

            if (!toolBlockMap.has(tcIdx)) {
              // New tool call — open a new Anthropic block
              const blockIdx = nextBlockIndex++;
              toolBlockMap.set(tcIdx, blockIdx);
              yield sseEvent('content_block_start', {
                type: 'content_block_start',
                index: blockIdx,
                content_block: {
                  type: 'tool_use',
                  id: (tc['id'] as string) || `toolu_${Date.now()}`,
                  name: (fn?.['name'] as string) || '',
                  input: {},
                },
              });
            }

            const blockIdx = toolBlockMap.get(tcIdx)!;
            const args = fn?.['arguments'] as string | undefined;
            if (args) {
              yield sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIdx,
                delta: { type: 'input_json_delta', partial_json: args },
              });
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // ── Closing sequence ──────────────────────────────────────────────────────

  // Emit message_start if the stream was empty (edge case)
  if (!emittedMessageStart) {
    yield buildMessageStart();
    yield sseEvent('ping', { type: 'ping' });
  }

  // Close text block if still open
  if (textBlockIndex !== -1) {
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
  }

  // Close tool blocks in index order
  const sortedToolBlocks = [...toolBlockMap.values()].sort((a, b) => a - b);
  for (const blockIdx of sortedToolBlocks) {
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIdx });
  }

  // Report final usage (now that we've seen the full stream)
  usage.setInputTokens(inputTokens);
  usage.setOutputTokens(outputTokens);
  usage.setStopReason(stopReason);

  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });

  yield sseEvent('message_stop', { type: 'message_stop' });
}
