import { describe, it, expect } from 'vitest';
import {
  convertAnthropicToResponsesAPI,
  convertResponsesAPIResponseToAnthropic,
  convertResponsesAPIStreamToAnthropic,
  type AnthropicBody,
} from '../src/codex-provider';

describe('Codex Provider', () => {
  describe('convertAnthropicToResponsesAPI', () => {
    it('should convert basic Anthropic request', () => {
      const body: AnthropicBody = {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'What is 2+2?' }],
        max_tokens: 1024,
        temperature: 0.7,
      };

      const result = convertAnthropicToResponsesAPI(body, 'gpt-5.4');

      expect(result.model).toBe('gpt-5.4');
      expect(result.temperature).toBe(0.7);
      expect(result.store).toBe(false);
      expect(result.stream).toBe(true); // Codex requires streaming
      expect(result.instructions).toBe('');
      expect(Array.isArray(result.input)).toBe(true);
      expect((result.input as any[])[0]).toEqual({ role: 'user', content: 'What is 2+2?' });
    });

    it('should convert system prompt to instructions', () => {
      const body: AnthropicBody = {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are a helpful assistant.',
      };

      const result = convertAnthropicToResponsesAPI(body, 'gpt-5.4');
      expect(result.instructions).toBe('You are a helpful assistant.');
    });

    it('should convert array system format', () => {
      const body: AnthropicBody = {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        system: [
          { type: 'text', text: 'First instruction.' },
          { type: 'text', text: 'Second instruction.' },
        ] as any,
      };

      const result = convertAnthropicToResponsesAPI(body, 'gpt-5.4');
      expect(result.instructions).toContain('First instruction.');
      expect(result.instructions).toContain('Second instruction.');
    });

    it('should convert thinking effort to reasoning', () => {
      const body: AnthropicBody = {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Solve this hard problem' }],
        thinking: { type: 'enabled', budget_tokens: 15000 } as any,
      };

      const result = convertAnthropicToResponsesAPI(body, 'gpt-5.4');
      expect((result as any).reasoning?.effort).toBe('high');
    });

    it('should map tools correctly', () => {
      const body: AnthropicBody = {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Check the weather' }],
        tools: [{
          name: 'get_weather',
          description: 'Get weather for a location',
          input_schema: { type: 'object', properties: { location: { type: 'string' } } },
        }],
      };

      const result = convertAnthropicToResponsesAPI(body, 'gpt-5.4');
      expect(result.tools).toBeDefined();
      expect((result.tools as any[])[0]).toEqual({
        type: 'function',
        name: 'get_weather',
        description: 'Get weather for a location',
        parameters: { type: 'object', properties: { location: { type: 'string' } } },
      });
    });

    it('should convert multi-turn conversation as message list', () => {
      const body: AnthropicBody = {
        model: 'claude-opus-4-6',
        messages: [
          { role: 'user', content: 'What is AI?' },
          { role: 'assistant', content: 'AI is artificial intelligence.' },
          { role: 'user', content: 'Tell me more.' },
        ],
      };

      const result = convertAnthropicToResponsesAPI(body, 'gpt-5.4');
      const input = result.input as Array<{ role: string; content: string }>;
      expect(input).toHaveLength(3);
      expect(input[0]).toEqual({ role: 'user', content: 'What is AI?' });
      expect(input[1]).toEqual({ role: 'assistant', content: 'AI is artificial intelligence.' });
      expect(input[2]).toEqual({ role: 'user', content: 'Tell me more.' });
    });

    it('should not include max_output_tokens (unsupported by Codex backend)', () => {
      const body: AnthropicBody = {
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
      };

      const result = convertAnthropicToResponsesAPI(body, 'gpt-5.4');
      expect(result).not.toHaveProperty('max_output_tokens');
    });
  });

  describe('convertResponsesAPIResponseToAnthropic', () => {
    it('should convert basic Responses API response', () => {
      const responsesResponse = {
        output_text: 'The answer is 4.',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const result = convertResponsesAPIResponseToAnthropic(responsesResponse, 'msg_test123', 'gpt-5.4');

      expect(result.id).toBe('msg_test123');
      expect(result.role).toBe('assistant');
      expect(result.model).toBe('gpt-5.4');
      expect((result.content as any[])[0].text).toBe('The answer is 4.');
      expect((result.usage as any).input_tokens).toBe(10);
      expect((result.usage as any).output_tokens).toBe(5);
    });

    it('should handle incomplete status as max_tokens', () => {
      const result = convertResponsesAPIResponseToAnthropic(
        { output_text: 'Truncated', status: 'incomplete', usage: {} },
        'msg_test', 'gpt-5.4',
      );
      expect(result.stop_reason).toBe('max_tokens');
    });

    it('should default usage to zeros if missing', () => {
      const result = convertResponsesAPIResponseToAnthropic(
        { output_text: 'Hello', status: 'completed' },
        'msg_test', 'gpt-5.4',
      );
      expect((result.usage as any).input_tokens).toBe(0);
      expect((result.usage as any).output_tokens).toBe(0);
    });
  });

  describe('convertResponsesAPIStreamToAnthropic', () => {
    /** Helper: create a mock async iterable from SDK-style events */
    function mockSdkStream(events: Array<Record<string, unknown>>): AsyncIterable<any> {
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const e of events) yield e;
        },
      };
    }

    it('should convert text delta events', async () => {
      const events = [
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ' world' },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
      ];

      const { stream, getUsage } = convertResponsesAPIStreamToAnthropic(
        mockSdkStream(events), 'msg_test', 'gpt-5.4',
      );

      const chunks: string[] = [];
      for await (const chunk of stream) chunks.push(chunk);

      const usage = getUsage();
      expect(usage.inputTokens).toBe(5);
      expect(usage.outputTokens).toBe(2);
      expect(usage.stopReason).toBe('end_turn');

      const fullText = chunks.join('');
      expect(fullText).toContain('message_start');
      expect(fullText).toContain('content_block_start');
      expect(fullText).toContain('text_delta');
      expect(fullText).toContain('Hello');
      expect(fullText).toContain(' world');
      expect(fullText).toContain('message_stop');
    });

    it('should handle tool call deltas', async () => {
      const events = [
        { type: 'response.function_call_arguments.delta', delta: '{"lo', name: 'get_weather' },
        { type: 'response.function_call_arguments.delta', delta: 'cation":"NYC"}', name: 'get_weather' },
        { type: 'response.completed', response: { status: 'completed', usage: {} } },
      ];

      const { stream, getUsage } = convertResponsesAPIStreamToAnthropic(
        mockSdkStream(events), 'msg_test', 'gpt-5.4',
      );

      const chunks: string[] = [];
      for await (const chunk of stream) chunks.push(chunk);

      expect(getUsage().stopReason).toBe('tool_use');
      const fullText = chunks.join('');
      expect(fullText).toContain('tool_use');
      expect(fullText).toContain('get_weather');
      expect(fullText).toContain('input_json_delta');
    });

    it('should handle empty stream gracefully', async () => {
      const { stream } = convertResponsesAPIStreamToAnthropic(
        mockSdkStream([]), 'msg_test', 'gpt-5.4',
      );

      const chunks: string[] = [];
      for await (const chunk of stream) chunks.push(chunk);

      const fullText = chunks.join('');
      expect(fullText).toContain('message_start');
      expect(fullText).toContain('message_stop');
    });
  });
});
