import { describe, it, expect } from 'vitest';
import { convertOpenAIStreamToAnthropic } from '../src/openai-to-anthropic-stream.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

async function collectEvents(gen: AsyncGenerator<string>): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const result: Array<{ type: string; data: Record<string, unknown> }> = [];
  for await (const chunk of gen) {
    // Parse "event: <type>\ndata: <json>\n\n" blocks
    const lines = chunk.split('\n').filter(l => l.trim());
    let type = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) type = line.slice(7);
      else if (line.startsWith('data: ')) result.push({ type, data: JSON.parse(line.slice(6)) });
    }
  }
  return result;
}

function dataLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('convertOpenAIStreamToAnthropic', () => {
  it('emits full Anthropic sequence for a simple text response', async () => {
    const lines = [
      ': OPENROUTER PROCESSING\n\n',
      dataLine({ choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: { content: ' world' }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ];

    const { stream } = convertOpenAIStreamToAnthropic(makeStream(lines), 'msg_test1', 'claude-opus-4-6');
    const events = await collectEvents(stream);

    const types = events.map(e => e.type);
    expect(types).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    // message_start has correct model
    expect(events[0].data).toMatchObject({ type: 'message_start', message: { model: 'claude-opus-4-6', role: 'assistant' } });

    // content deltas have correct text
    expect(events[3].data).toMatchObject({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
    expect(events[4].data).toMatchObject({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } });

    // message_delta has correct stop_reason and token counts
    expect(events[6].data).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    });
  });

  it('skips SSE comment lines (OPENROUTER PROCESSING)', async () => {
    const lines = [
      ': OPENROUTER PROCESSING\n\n',
      ': OPENROUTER PROCESSING\n\n',
      dataLine({ choices: [{ delta: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }] }),
    ];

    const { stream } = convertOpenAIStreamToAnthropic(makeStream(lines), 'msg_test2', 'claude-sonnet-4-6');
    const events = await collectEvents(stream);
    // Should still get the full sequence — comments don't cause extra events
    expect(events.map(e => e.type)).toContain('message_start');
    expect(events.map(e => e.type)).toContain('content_block_delta');
    expect(events.map(e => e.type)).toContain('message_stop');
  });

  it('uses the provided model name in message_start', async () => {
    const lines = [
      dataLine({ choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
    ];
    const { stream } = convertOpenAIStreamToAnthropic(makeStream(lines), 'msg_abc', 'claude-opus-4-6');
    const events = await collectEvents(stream);
    const start = events.find(e => e.type === 'message_start');
    expect((start!.data as { message: { model: string } }).message.model).toBe('claude-opus-4-6');
  });

  it('maps finish_reason tool_calls → stop_reason tool_use', async () => {
    const lines = [
      dataLine({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }] }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }),
    ];

    const { stream, getUsage } = convertOpenAIStreamToAnthropic(makeStream(lines), 'msg_tool', 'claude-opus-4-6');
    const events = await collectEvents(stream);

    const msgDelta = events.find(e => e.type === 'message_delta');
    expect(msgDelta!.data).toMatchObject({ delta: { stop_reason: 'tool_use' } });
    expect(getUsage().stopReason).toBe('tool_use');
  });

  it('emits tool_use content blocks correctly', async () => {
    const lines = [
      dataLine({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '' } }] }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/foo"}' } }] }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ];

    const { stream } = convertOpenAIStreamToAnthropic(makeStream(lines), 'msg_tool2', 'claude-opus-4-6');
    const events = await collectEvents(stream);
    const types = events.map(e => e.type);

    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_delta');
    expect(types).toContain('content_block_stop');

    const blockStart = events.find(e => e.type === 'content_block_start');
    expect(blockStart!.data).toMatchObject({
      index: 0,
      content_block: { type: 'tool_use', id: 'call_abc', name: 'read_file', input: {} },
    });

    const deltas = events.filter(e => e.type === 'content_block_delta');
    expect(deltas[0].data).toMatchObject({ delta: { type: 'input_json_delta', partial_json: '{"path":' } });
    expect(deltas[1].data).toMatchObject({ delta: { type: 'input_json_delta', partial_json: '"/foo"}' } });
  });

  it('closes text block before tool call block', async () => {
    const lines = [
      dataLine({ choices: [{ delta: { role: 'assistant', content: 'Thinking...' }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'bash', arguments: '{}' } }] }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ];

    const { stream } = convertOpenAIStreamToAnthropic(makeStream(lines), 'msg_mixed', 'claude-opus-4-6');
    const events = await collectEvents(stream);
    const types = events.map(e => e.type);

    // text block (index 0) must be stopped before tool block (index 1) starts
    const textStop = types.indexOf('content_block_stop');
    const toolStart = types.lastIndexOf('content_block_start');
    expect(textStop).toBeLessThan(toolStart);

    // tool block has index 1 (after text block at 0)
    const toolBlock = events.find(e => e.type === 'content_block_start' && (e.data as { content_block: { type: string } }).content_block.type === 'tool_use');
    expect((toolBlock!.data as { index: number }).index).toBe(1);
  });

  it('handles empty stream gracefully', async () => {
    const { stream } = convertOpenAIStreamToAnthropic(makeStream([]), 'msg_empty', 'claude-opus-4-6');
    const events = await collectEvents(stream);
    const types = events.map(e => e.type);
    // Still emits the full sequence even with no content
    expect(types).toContain('message_start');
    expect(types).toContain('message_delta');
    expect(types).toContain('message_stop');
  });

  it('captures token counts from usage chunk', async () => {
    const lines = [
      dataLine({ choices: [{ delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 7 } }),
    ];

    const { stream, getUsage } = convertOpenAIStreamToAnthropic(makeStream(lines), 'msg_usage', 'claude-opus-4-6');
    for await (const _ of stream) { /* consume */ }

    const usage = getUsage();
    expect(usage.inputTokens).toBe(42);
    expect(usage.outputTokens).toBe(7);
  });

  it('ignores [DONE] line without producing events', async () => {
    const lines = [
      dataLine({ choices: [{ delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ];

    const { stream } = convertOpenAIStreamToAnthropic(makeStream(lines), 'msg_done', 'claude-opus-4-6');
    const events = await collectEvents(stream);
    // [DONE] should produce no extra events beyond the normal closing sequence
    const types = events.map(e => e.type);
    expect(types.filter(t => t === 'message_stop').length).toBe(1);
  });
});
