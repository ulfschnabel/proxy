import { describe, it, expect } from 'vitest';
import { sanitizeForModel } from '../src/model-sanitizer.js';

describe('sanitizeForModel', () => {
  it('strips effort/thinking/batchedClientRequests for Haiku', () => {
    const result = sanitizeForModel(
      { model: 'claude-haiku-4-5-20251001', effort: 'low', thinking: { type: 'enabled' }, batchedClientRequests: [], max_tokens: 10 },
      'claude-haiku-4-5-20251001',
      undefined,
    );
    expect(result.body).toEqual({ model: 'claude-haiku-4-5-20251001', max_tokens: 10 });
    expect(result.strippedParams).toEqual(['thinking', 'effort', 'batchedClientRequests']);
  });

  it('keeps effort/thinking for Opus', () => {
    const result = sanitizeForModel(
      { model: 'claude-opus-4-6', effort: 'high', thinking: { type: 'enabled' }, max_tokens: 10 },
      'claude-opus-4-6',
      undefined,
    );
    expect(result.body).toEqual({ model: 'claude-opus-4-6', effort: 'high', thinking: { type: 'enabled' }, max_tokens: 10 });
    expect(result.strippedParams).toEqual([]);
  });

  it('strips context-1m beta from Haiku', () => {
    const result = sanitizeForModel(
      { model: 'claude-haiku-4-5-20251001' },
      'claude-haiku-4-5-20251001',
      'interleaved-thinking-2025-05-14,context-1m-2025-09-01',
    );
    expect(result.betaHeaders).toBe('interleaved-thinking-2025-05-14');
    expect(result.strippedBetas).toEqual(['context-1m-2025-09-01']);
  });

  it('strips context-1m beta from Sonnet', () => {
    const result = sanitizeForModel(
      { model: 'claude-sonnet-4-6' },
      'claude-sonnet-4-6',
      'interleaved-thinking-2025-05-14,context-1m-2025-09-01',
    );
    expect(result.betaHeaders).toBe('interleaved-thinking-2025-05-14');
    expect(result.strippedBetas).toEqual(['context-1m-2025-09-01']);
  });

  it('keeps context-1m beta for Opus', () => {
    const result = sanitizeForModel(
      { model: 'claude-opus-4-6' },
      'claude-opus-4-6',
      'interleaved-thinking-2025-05-14,context-1m-2025-09-01',
    );
    expect(result.betaHeaders).toBe('interleaved-thinking-2025-05-14,context-1m-2025-09-01');
    expect(result.strippedBetas).toEqual([]);
  });

  it('strips OAT-unsupported betas for OAT tokens', () => {
    const result = sanitizeForModel(
      { model: 'claude-sonnet-4-6' },
      'claude-sonnet-4-6',
      'max-tokens-3-5-sonnet-2025-04-14,interleaved-thinking-2025-05-14',
      'oat',
    );
    expect(result.betaHeaders).toBe('interleaved-thinking-2025-05-14');
    expect(result.strippedBetas).toContain('max-tokens-3-5-sonnet-2025-04-14');
  });

  it('returns undefined betaHeaders when all betas stripped', () => {
    const result = sanitizeForModel(
      { model: 'claude-haiku-4-5-20251001' },
      'claude-haiku-4-5-20251001',
      'context-1m-2025-09-01',
    );
    expect(result.betaHeaders).toBeUndefined();
  });

  it('does not mutate input body', () => {
    const input = { model: 'claude-haiku-4-5-20251001', effort: 'low', max_tokens: 5 };
    sanitizeForModel(input, 'claude-haiku-4-5-20251001', undefined);
    expect(input.effort).toBe('low');
  });
});
