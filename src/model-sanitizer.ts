/**
 * Centralized request sanitization for model compatibility.
 *
 * Every request to Anthropic goes through sanitizeForModel() which strips
 * unsupported body params and beta headers based on the target model.
 * No other code should do model-specific param stripping.
 */

export interface SanitizeResult {
  body: Record<string, unknown>;
  betaHeaders: string | undefined;
  strippedParams: string[];
  strippedBetas: string[];
}

/** Params that Haiku doesn't support */
const HAIKU_UNSUPPORTED_PARAMS = ['thinking', 'effort', 'batchedClientRequests'];

/** Beta headers only Opus supports (1M context requires Max plan Opus) */
const OPUS_ONLY_BETA_PREFIXES = ['context-1m'];

/**
 * Beta headers Haiku doesn't support.
 * Per Anthropic docs (2026-04):
 *   - effort: only Opus 4.5/4.6, Sonnet 4.6, Mythos
 *   - interleaved-thinking: not supported on Haiku 4.5
 *   - context-1m: only Opus on Max plan
 * Haiku DOES support: context-management, prompt-caching (GA), standard thinking
 */
const HAIKU_UNSUPPORTED_BETA_PREFIXES = ['effort', 'interleaved-thinking', 'context-1m'];

/** Beta headers unsupported by OAT tokens */
const OAT_UNSUPPORTED_BETAS = new Set(['max-tokens-3-5-sonnet-2025-04-14']);

function isHaiku(model: string): boolean {
  return model.includes('haiku');
}

function isOpus(model: string): boolean {
  return model.includes('opus');
}

/**
 * Sanitize a request body and beta headers for the target model.
 * Call this once before sending to Anthropic. Returns a new body (never mutates input).
 */
export function sanitizeForModel(
  body: Record<string, unknown>,
  targetModel: string,
  betaHeaders: string | undefined,
  tokenType?: 'oat' | 'api-key',
): SanitizeResult {
  let sanitized = { ...body };
  const strippedParams: string[] = [];
  const strippedBetas: string[] = [];

  // ── Body param stripping ──
  if (isHaiku(targetModel)) {
    for (const param of HAIKU_UNSUPPORTED_PARAMS) {
      if (param in sanitized) {
        const { [param]: _, ...rest } = sanitized;
        sanitized = rest;
        strippedParams.push(param);
      }
    }
    // Strip output_config.effort (Haiku doesn't support effort in any form)
    if (sanitized['output_config'] && typeof sanitized['output_config'] === 'object') {
      const oc = sanitized['output_config'] as Record<string, unknown>;
      if ('effort' in oc) {
        const { effort: _, ...restOc } = oc;
        sanitized = { ...sanitized, output_config: Object.keys(restOc).length > 0 ? restOc : undefined };
        strippedParams.push('output_config.effort');
      }
    }
  }

  // ── Beta header stripping ──
  let cleanedBeta = betaHeaders;
  if (cleanedBeta) {
    const betas = cleanedBeta.split(',').map(b => b.trim()).filter(Boolean);
    const filtered = betas.filter(b => {
      // Strip Haiku-unsupported betas (effort, interleaved-thinking, context-1m)
      if (isHaiku(targetModel)) {
        for (const prefix of HAIKU_UNSUPPORTED_BETA_PREFIXES) {
          if (b.startsWith(prefix)) {
            strippedBetas.push(b);
            return false;
          }
        }
      }
      // Strip Opus-only betas from non-Opus, non-Haiku models (context-1m on Sonnet)
      if (!isOpus(targetModel) && !isHaiku(targetModel)) {
        for (const prefix of OPUS_ONLY_BETA_PREFIXES) {
          if (b.startsWith(prefix)) {
            strippedBetas.push(b);
            return false;
          }
        }
      }
      // Strip OAT-unsupported betas
      if (tokenType === 'oat' && OAT_UNSUPPORTED_BETAS.has(b)) {
        strippedBetas.push(b);
        return false;
      }
      return true;
    });
    cleanedBeta = filtered.length > 0 ? filtered.join(',') : undefined;
  }

  return {
    body: sanitized,
    betaHeaders: cleanedBeta,
    strippedParams,
    strippedBetas,
  };
}
