import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tests for model masking: when the proxy reroutes a request to a different model,
 * the response should contain the originally-requested model name so that clients
 * (Claude Code) use the correct context window / compaction thresholds.
 */

// Read the source to verify the implementation exists
const srcPath = path.join(__dirname, '..', 'src', 'standalone-proxy.ts');
const src = fs.readFileSync(srcPath, 'utf-8');

describe('model masking - streaming SSE rewrite', () => {
  it('should detect when model masking is needed (originalModel differs from targetModel)', () => {
    expect(src).toContain('const _maskModel = originalModel && originalModel !== (targetModel || requestedModel) ? originalModel : null');
  });

  it('should rewrite model in message_start SSE events when masking', () => {
    expect(src).toContain('"message_start"');
    expect(src).toContain('chunk = chunk.replace(');
    expect(src).toContain('"model":"${_maskModel}"');
  });

  it('should only rewrite chunks that contain message_start', () => {
    // The replace should be guarded by a check for message_start
    expect(src).toContain('_maskModel && chunk.includes');
    expect(src).toContain('message_start');
  });

  it('should not mask when originalModel matches targetModel', () => {
    // _maskModel is null when models match, so no rewriting happens
    expect(src).toContain('originalModel !== (targetModel || requestedModel) ? originalModel : null');
  });
});

describe('model masking - non-streaming response rewrite', () => {
  it('should overwrite model field in non-streaming response JSON', () => {
    expect(src).toContain("nativeResponseData['model'] = _maskModel");
  });

  it('should only overwrite when _maskModel is set', () => {
    expect(src).toContain("if (_maskModel)");
    expect(src).toContain("nativeResponseData['model'] = _maskModel");
  });
});

describe('model masking - SSE rewrite correctness', () => {
  // Simulate the regex replacement that happens in the streaming path
  const maskModel = 'claude-opus-4-6';
  const regex = /"model"\s*:\s*"[^"]+"/;

  it('should replace model in a typical message_start SSE event', () => {
    const sseChunk = 'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":1000,"output_tokens":0}}}\n\n';
    const result = sseChunk.replace(regex, `"model":"${maskModel}"`);
    expect(result).toContain('"model":"claude-opus-4-6"');
    expect(result).not.toContain('claude-sonnet-4-6');
  });

  it('should handle model names with extra whitespace in JSON', () => {
    const sseChunk = 'data: {"type":"message_start","message":{"model" : "claude-sonnet-4-6"}}\n\n';
    const result = sseChunk.replace(regex, `"model":"${maskModel}"`);
    expect(result).toContain('"model":"claude-opus-4-6"');
  });

  it('should not affect chunks without model field', () => {
    const sseChunk = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n';
    const result = sseChunk.replace(regex, `"model":"${maskModel}"`);
    // No model field to replace, chunk unchanged
    expect(result).toBe(sseChunk);
  });

  it('should handle OpenRouter model names', () => {
    const sseChunk = 'data: {"type":"message_start","message":{"model":"openrouter/nvidia/nemotron-3-super-120b-a12b:free"}}\n\n';
    const result = sseChunk.replace(regex, `"model":"${maskModel}"`);
    expect(result).toContain('"model":"claude-opus-4-6"');
    expect(result).not.toContain('openrouter');
  });
});
