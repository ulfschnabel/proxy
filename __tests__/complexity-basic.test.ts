/**
 * Tests for the "basic" complexity tier
 *
 * Validates that the complexity classifier correctly distinguishes between
 * simple (score 0), basic (score 1), moderate (score 2-3), and complex (4+).
 */

import { describe, it, expect } from 'vitest';

// ─── Replicated from standalone-proxy.ts (must stay in sync) ────────────────

type Complexity = 'simple' | 'basic' | 'moderate' | 'complex';

function extractMessageText(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return (m.content as Array<{ type?: string; text?: string }>)
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
      }
      return '';
    })
    .join('\n');
}

function classifyComplexity(messages: Array<{ role?: string; content?: unknown }>): Complexity {
  const userMessages = messages.filter((m) => m.role === 'user');
  const lastUserMessage = userMessages.length > 0 ? [userMessages[userMessages.length - 1]] : messages;
  const text = extractMessageText(lastUserMessage).toLowerCase();
  const tokens = Math.ceil(text.length / 4);

  let score = 0;

  if (/```/.test(text) || /function |class |const |let |import /.test(text)) score += 2;
  if (/analyze|compare|evaluate|assess|review|audit/.test(text)) score += 2;
  if (/calculate|compute|solve|equation|prove|derive/.test(text)) score += 2;
  if (/first.*then|step \d|1\).*2\)|phase \d/.test(text)) score += 2;
  if (/architect|infrastructure|distributed|microservice|system design|scalab/i.test(text)) score += 3;
  if (/write a (story|essay|article|report)|create a|design a|build a/.test(text)) score += 2;
  if (/implement|refactor|debug|optimize|migrate/.test(text)) score += 2;
  if (/strategy|roadmap|plan for|how (would|should|can) (we|i|you)/.test(text)) score += 1;
  if (tokens > 500) score += 1;
  if (tokens > 2000) score += 2;
  if (tokens > 5000) score += 2;
  const andCount = (text.match(/\band\b/g) || []).length;
  if (andCount >= 3) score += 1;
  if (andCount >= 5) score += 1;

  const allText = extractMessageText(messages);
  const totalTokens = Math.ceil(allText.length / 4);
  if (totalTokens > 80000) score += 5;
  else if (totalTokens > 50000) score += 3;
  else if (totalTokens > 20000) score += 2;
  if (messages.length > 50) score += 2;
  else if (messages.length > 20) score += 1;

  if (score >= 4) return 'complex';
  if (score >= 2) return 'moderate';
  if (score >= 1) return 'basic';
  return 'simple';
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('classifyComplexity with basic tier', () => {
  it('classifies trivial messages as simple', () => {
    expect(classifyComplexity([{ role: 'user', content: 'hi' }])).toBe('simple');
    expect(classifyComplexity([{ role: 'user', content: 'thanks' }])).toBe('simple');
    expect(classifyComplexity([{ role: 'user', content: 'yes' }])).toBe('simple');
    expect(classifyComplexity([{ role: 'user', content: 'ok' }])).toBe('simple');
  });

  it('classifies planning/strategy questions as basic (score 1)', () => {
    // "how would we ..." triggers strategy pattern → score 1
    expect(classifyComplexity([{ role: 'user', content: 'how would we do this?' }])).toBe('basic');
    expect(classifyComplexity([{ role: 'user', content: 'how should I approach this?' }])).toBe('basic');
  });

  it('classifies medium-length messages (500+ tokens) as basic', () => {
    // 500 tokens ≈ 2000 chars
    const longish = 'a'.repeat(2100);
    expect(classifyComplexity([{ role: 'user', content: longish }])).toBe('basic');
  });

  it('classifies code-containing messages as moderate', () => {
    expect(classifyComplexity([{ role: 'user', content: 'function foo() {}' }])).toBe('moderate');
    expect(classifyComplexity([{ role: 'user', content: 'const x = 1' }])).toBe('moderate');
  });

  it('classifies analysis requests as moderate', () => {
    expect(classifyComplexity([{ role: 'user', content: 'analyze this data' }])).toBe('moderate');
    expect(classifyComplexity([{ role: 'user', content: 'review this code' }])).toBe('moderate');
  });

  it('classifies architecture requests as complex', () => {
    expect(classifyComplexity([{ role: 'user', content: 'design a distributed microservice architecture' }])).toBe('complex');
  });

  it('classifies large context (80K+ tokens) as complex regardless of message', () => {
    const hugeSystem = 'x'.repeat(320001); // 80K+ tokens
    expect(classifyComplexity([
      { role: 'system', content: hugeSystem },
      { role: 'user', content: 'hi' },
    ])).toBe('complex');
  });

  it('keeps simple truly simple — no false positives', () => {
    // These should NOT be basic or higher
    expect(classifyComplexity([{ role: 'user', content: 'what time is it' }])).toBe('simple');
    expect(classifyComplexity([{ role: 'user', content: 'hello world' }])).toBe('simple');
    expect(classifyComplexity([{ role: 'user', content: 'list files' }])).toBe('simple');
  });
});

describe('Complexity type and config source code checks', () => {
  it('Complexity type includes basic', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'src', 'standalone-proxy.ts'), 'utf-8');

    expect(source).toContain("type Complexity = 'simple' | 'basic' | 'moderate' | 'complex'");
  });

  it('ComplexityConfig interface includes basic field', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'src', 'standalone-proxy.ts'), 'utf-8');

    expect(source).toContain('basic?:');
  });

  it('classifyComplexity returns basic for score 1', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'src', 'standalone-proxy.ts'), 'utf-8');

    expect(source).toContain("return 'basic'");
  });
});
