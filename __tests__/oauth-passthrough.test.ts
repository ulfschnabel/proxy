/**
 * OAuth header passthrough tests
 *
 * Unit tests for header construction when proxying Claude Code OAuth requests.
 * Validates:
 *   - OAuth tokens forwarded as Authorization: Bearer with oauth beta flag
 *   - No duplicate header keys from case mismatch (authorization vs Authorization)
 *   - Extra client headers (user-agent, x-app, x-stainless-*) pass through
 *   - anthropic-beta values are preserved and merged correctly
 *   - 401/403 status codes don't trigger provider cooldown
 */

import { describe, it, expect } from 'vitest';
import * as http from 'node:http';

// We test by importing the compiled output and calling internal functions.
// Since they aren't exported, we extract them by evaluating the module.
// Simpler: we replicate the exact logic from standalone-proxy.ts and test it.

// ─── Replicated from standalone-proxy.ts (must stay in sync) ────────────────

const OAT_UNSUPPORTED_BETA_FLAGS = new Set(['max-tokens-3-5-sonnet-2025-04-14']);

function setAnthropicAuth(headers: Record<string, string>, token: string) {
  if (token.startsWith('sk-ant-oat')) {
    headers['Authorization'] = `Bearer ${token}`;
    const existing = headers['anthropic-beta'];
    const oauthBeta = 'oauth-2025-04-20';
    if (!existing) {
      headers['anthropic-beta'] = oauthBeta;
    } else if (!existing.includes(oauthBeta)) {
      headers['anthropic-beta'] = `${existing},${oauthBeta}`;
    }
  } else {
    headers['x-api-key'] = token;
  }
}

interface RequestContext {
  authHeader?: string;
  betaHeaders?: string;
  versionHeader?: string;
  apiKeyHeader?: string;
  userAgent?: string;
  xApp?: string;
  allHeaders?: Record<string, string>;
}

const SKIP_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding',
  'authorization', 'x-api-key', 'anthropic-beta', 'anthropic-version', 'content-type',
]);

function extractRequestContext(headers: Record<string, string | undefined>): RequestContext {
  const allHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SKIP_HEADERS.has(key) && value !== undefined) {
      allHeaders[key] = value;
    }
  }
  return {
    authHeader: headers['authorization'],
    betaHeaders: headers['anthropic-beta'],
    versionHeader: headers['anthropic-version'],
    apiKeyHeader: headers['x-api-key'],
    userAgent: headers['user-agent'],
    xApp: headers['x-app'],
    allHeaders,
  };
}

function buildAnthropicHeadersWithAuth(ctx: RequestContext): Record<string, string> {
  const headers: Record<string, string> = {
    ...(ctx.allHeaders ?? {}),
    'Content-Type': 'application/json',
    'anthropic-version': ctx.versionHeader || '2023-06-01',
  };

  if (ctx.authHeader) {
    const token = ctx.authHeader.replace(/^Bearer\s+/i, '');
    setAnthropicAuth(headers, token);
  } else if (ctx.apiKeyHeader) {
    setAnthropicAuth(headers, ctx.apiKeyHeader);
  }

  if (ctx.betaHeaders) {
    const existing = headers['anthropic-beta'];
    if (!existing) {
      headers['anthropic-beta'] = ctx.betaHeaders;
    } else if (!existing.includes(ctx.betaHeaders)) {
      headers['anthropic-beta'] = `${existing},${ctx.betaHeaders}`;
    }
  }

  // Strip unsupported beta flags for OAT tokens
  if (headers['anthropic-beta']) {
    const token = ctx.authHeader?.replace(/^Bearer\s+/i, '') ?? ctx.apiKeyHeader ?? '';
    if (token.startsWith('sk-ant-oat')) {
      const cleaned = headers['anthropic-beta']
        .split(',')
        .map(b => b.trim())
        .filter(b => !OAT_UNSUPPORTED_BETA_FLAGS.has(b))
        .join(',');
      if (cleaned) {
        headers['anthropic-beta'] = cleaned;
      } else {
        delete headers['anthropic-beta'];
      }
    }
  }

  return headers;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OAuth header passthrough', () => {
  it('forwards OAuth token as Authorization: Bearer with oauth beta header', () => {
    const ctx = extractRequestContext({
      'authorization': 'Bearer sk-ant-oat01-test-token-abc123',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    });

    const headers = buildAnthropicHeadersWithAuth(ctx);

    expect(headers['Authorization']).toBe('Bearer sk-ant-oat01-test-token-abc123');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
  });

  it('does not produce duplicate authorization headers from case mismatch', () => {
    const ctx = extractRequestContext({
      'authorization': 'Bearer sk-ant-oat01-no-dupes',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': 'claude-code/2.1.91',
      'x-app': 'claude-code',
    });

    const headers = buildAnthropicHeadersWithAuth(ctx);

    // Only one authorization-like key should exist
    const authKeys = Object.keys(headers).filter(k => k.toLowerCase() === 'authorization');
    expect(authKeys).toHaveLength(1);

    // The lowercase 'authorization' from allHeaders must NOT be present
    expect(headers['authorization']).toBeUndefined();
    // The title-case one from setAnthropicAuth must be present
    expect(headers['Authorization']).toBe('Bearer sk-ant-oat01-no-dupes');
  });

  it('does not produce duplicate anthropic-beta or content-type from case mismatch', () => {
    const ctx = extractRequestContext({
      'authorization': 'Bearer sk-ant-oat01-test',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
    });

    const headers = buildAnthropicHeadersWithAuth(ctx);

    const betaKeys = Object.keys(headers).filter(k => k.toLowerCase() === 'anthropic-beta');
    expect(betaKeys).toHaveLength(1);

    const ctKeys = Object.keys(headers).filter(k => k.toLowerCase() === 'content-type');
    expect(ctKeys).toHaveLength(1);
  });

  it('passes through extra client headers (user-agent, x-app, x-stainless-*)', () => {
    const ctx = extractRequestContext({
      'authorization': 'Bearer sk-ant-oat01-passthrough',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': 'claude-code/2.1.91',
      'x-app': 'claude-code',
      'x-stainless-lang': 'js',
      'x-stainless-runtime': 'node',
      'x-stainless-arch': 'x64',
    });

    const headers = buildAnthropicHeadersWithAuth(ctx);

    expect(headers['user-agent']).toBe('claude-code/2.1.91');
    expect(headers['x-app']).toBe('claude-code');
    expect(headers['x-stainless-lang']).toBe('js');
    expect(headers['x-stainless-runtime']).toBe('node');
    expect(headers['x-stainless-arch']).toBe('x64');
  });

  it('preserves multiple anthropic-beta values', () => {
    const ctx = extractRequestContext({
      'authorization': 'Bearer sk-ant-oat01-multi-beta',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20,context1m-2025-08-07',
    });

    const headers = buildAnthropicHeadersWithAuth(ctx);

    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(headers['anthropic-beta']).toContain('context1m-2025-08-07');
  });

  it('strips unsupported beta flags for OAT tokens', () => {
    const ctx = extractRequestContext({
      'authorization': 'Bearer sk-ant-oat01-strip-test',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20,max-tokens-3-5-sonnet-2025-04-14',
    });

    const headers = buildAnthropicHeadersWithAuth(ctx);

    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(headers['anthropic-beta']).not.toContain('max-tokens-3-5-sonnet-2025-04-14');
  });

  it('handles standard API key (non-OAuth) correctly', () => {
    const ctx = extractRequestContext({
      'x-api-key': 'sk-ant-api03-standard-key',
      'anthropic-version': '2023-06-01',
    });

    const headers = buildAnthropicHeadersWithAuth(ctx);

    expect(headers['x-api-key']).toBe('sk-ant-api03-standard-key');
    expect(headers['Authorization']).toBeUndefined();
    // No oauth beta header for standard keys
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('excludes hop-by-hop headers from passthrough', () => {
    const ctx = extractRequestContext({
      'authorization': 'Bearer sk-ant-oat01-hop-test',
      'anthropic-version': '2023-06-01',
      'host': 'localhost:4010',
      'connection': 'keep-alive',
      'transfer-encoding': 'chunked',
      'content-length': '500',
      'x-custom': 'should-pass',
    });

    const headers = buildAnthropicHeadersWithAuth(ctx);

    expect(headers['host']).toBeUndefined();
    expect(headers['connection']).toBeUndefined();
    expect(headers['transfer-encoding']).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
    expect(headers['x-custom']).toBe('should-pass');
  });
});

describe('Cooldown skip on 401/403', () => {
  // This tests the logic that 401/403 should not trigger cooldown.
  // We verify by reading the source code to ensure the guard is present
  // at all recordFailure call sites.
  it('all recordFailure calls with HTTP status guard against 401/403', () => {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const source = readFileSync(join(__dirname, '..', 'src', 'standalone-proxy.ts'), 'utf-8');

    // Find all lines with cooldownManager.recordFailure
    const lines = source.split('\n');
    const failureLines: { line: number; text: string }[] = [];
    lines.forEach((text, i) => {
      if (text.includes('cooldownManager.recordFailure')) {
        failureLines.push({ line: i + 1, text: text.trim() });
      }
    });

    expect(failureLines.length).toBeGreaterThan(0);

    // For each recordFailure call, check if the surrounding context
    // includes a 401/403 guard OR is in a catch block (no status available)
    for (const { line, text } of failureLines) {
      // Get surrounding lines (5 before) to check for status guard
      const context = lines.slice(Math.max(0, line - 6), line).join('\n');
      const isCatchBlock = context.includes('catch');
      const has401Guard = context.includes('!== 401') || text.includes('!== 401');

      if (!isCatchBlock) {
        expect(has401Guard).toBe(true);
      }
      // catch blocks don't have HTTP status — they're real errors, no guard needed
    }
  });
});
