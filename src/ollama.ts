/**
 * Ollama Local Model Provider
 *
 * Routes requests to a local Ollama instance for cost-free inference.
 * Handles API format translation between OpenAI-compatible and Ollama's
 * native /api/chat endpoint.
 *
 * Features:
 * - Configurable base URL (default: http://localhost:11434)
 * - Model availability detection with graceful fallback
 * - Complexity-based routing (route "simple" tasks to local models)
 * - OpenAI-compatible response format translation
 * - Streaming support (SSE)
 * - Health checking for availability
 *
 * Ollama API reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * @packageDocumentation
 */

/**
 * Ollama provider configuration.
 *
 * Example in ~/.relayplane/config.json:
 * ```json
 * {
 *   "providers": {
 *     "ollama": {
 *       "baseUrl": "http://localhost:11434",
 *       "models": ["llama3.2", "codestral"],
 *       "routeWhen": {
 *         "complexity": ["simple"]
 *       }
 *     }
 *   }
 * }
 * ```
 */
export interface OllamaProviderConfig {
  /** Base URL for the Ollama API (default: http://localhost:11434) */
  baseUrl?: string;
  /** List of available/preferred model names */
  models?: string[];
  /** Routing conditions: when to use Ollama instead of cloud providers */
  routeWhen?: {
    /** Complexity levels that should be routed to Ollama (e.g., ["simple"]) */
    complexity?: string[];
    /** Task types that should be routed to Ollama (e.g., ["question_answering"]) */
    taskTypes?: string[];
  };
  /** Timeout in milliseconds for Ollama requests (default: 120000 = 2 min) */
  timeoutMs?: number;
  /** Default model to use when none specified (default: first in models list) */
  defaultModel?: string;
  /** Enable Ollama provider (default: true when configured) */
  enabled?: boolean;
}

/** Default Ollama configuration values */
export const OLLAMA_DEFAULTS = {
  baseUrl: 'http://localhost:11434',
  timeoutMs: 120_000,
  models: [] as string[],
  enabled: true,
} as const;

/**
 * Ollama /api/chat request body
 * @see https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion
 */
interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    top_p?: number;
    top_k?: number;
  };
  tools?: unknown[];
}

/**
 * Ollama /api/chat response
 */
interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

/**
 * Ollama streaming chunk (NDJSON)
 */
interface OllamaStreamChunk {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama /api/tags response (list models)
 */
interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    modified_at: string;
    size: number;
  }>;
}

/**
 * Result of an Ollama health/availability check
 */
export interface OllamaHealthResult {
  available: boolean;
  models: string[];
  error?: string;
  responseTimeMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Health & Availability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the Ollama server is running and list available models.
 * Non-blocking, with a short timeout.
 */
export async function checkOllamaHealth(
  baseUrl: string = OLLAMA_DEFAULTS.baseUrl,
  timeoutMs: number = 5000,
): Promise<OllamaHealthResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return {
        available: false,
        models: [],
        error: `Ollama returned HTTP ${res.status}`,
        responseTimeMs: Date.now() - start,
      };
    }

    const data = (await res.json()) as OllamaTagsResponse;
    const models = (data.models ?? []).map((m) => m.name.replace(/:latest$/, ''));

    return {
      available: true,
      models,
      responseTimeMs: Date.now() - start,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // AbortError means timeout
    const isTimeout = errMsg.includes('abort') || errMsg.includes('AbortError');
    return {
      available: false,
      models: [],
      error: isTimeout ? `Ollama health check timed out (${timeoutMs}ms)` : `Ollama not reachable: ${errMsg}`,
      responseTimeMs: Date.now() - start,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing Decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether a request should be routed to Ollama based on config.
 *
 * @param config     - Ollama provider configuration
 * @param complexity - Classified complexity of the request (simple/moderate/complex)
 * @param taskType   - Inferred task type
 * @param model      - Requested model name (may match an Ollama model)
 *
 * @returns true if the request should be routed to Ollama
 */
export function shouldRouteToOllama(
  config: OllamaProviderConfig,
  complexity?: string,
  taskType?: string,
  model?: string,
): boolean {
  if (config.enabled === false) return false;

  // If the model name directly matches an Ollama model, route there
  if (model && config.models?.includes(model)) {
    return true;
  }

  // If model is prefixed with "ollama/" route there
  if (model?.startsWith('ollama/')) {
    return true;
  }

  const routeWhen = config.routeWhen;
  if (!routeWhen) return false;

  // Check complexity-based routing
  if (routeWhen.complexity && complexity) {
    if (routeWhen.complexity.includes(complexity)) {
      return true;
    }
  }

  // Check task-type-based routing
  if (routeWhen.taskTypes && taskType) {
    if (routeWhen.taskTypes.includes(taskType)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve the Ollama model name from a requested model string.
 *
 * - "ollama/llama3.2" → "llama3.2"
 * - "llama3.2" (if in models list) → "llama3.2"
 * - Unknown model → defaultModel or first in models list
 */
export function resolveOllamaModel(
  requestedModel: string,
  config: OllamaProviderConfig,
): string {
  // Strip "ollama/" prefix
  if (requestedModel.startsWith('ollama/')) {
    return requestedModel.slice('ollama/'.length);
  }

  // Direct match in configured models
  if (config.models?.includes(requestedModel)) {
    return requestedModel;
  }

  // Default model
  return config.defaultModel ?? config.models?.[0] ?? requestedModel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Translation: OpenAI → Ollama
// ─────────────────────────────────────────────────────────────────────────────

interface OpenAIChatMessage {
  role: string;
  content: string | unknown[];
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * Convert OpenAI-format messages to Ollama format.
 *
 * Ollama messages are simpler:
 * - role: "system" | "user" | "assistant"
 * - content: string (no array / multimodal blocks in base API)
 * - Tool calls are passed through for models that support them
 */
export function convertMessagesToOllama(
  messages: Array<{ role: string; content: string | unknown; [key: string]: unknown }>,
): Array<{ role: string; content: string }> {
  return messages.map((msg) => {
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Flatten multimodal content blocks to text
      content = (msg.content as Array<{ type?: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n');
    }

    // Map "tool" role to "user" for Ollama (tool results)
    const role = msg.role === 'tool' ? 'user' : msg.role;

    return { role, content };
  });
}

/**
 * Build an Ollama /api/chat request body from an OpenAI-compatible request.
 */
export function buildOllamaRequest(
  model: string,
  messages: Array<{ role: string; content: string | unknown; [key: string]: unknown }>,
  stream: boolean,
  options?: {
    temperature?: number;
    max_tokens?: number;
    tools?: unknown[];
  },
): OllamaChatRequest {
  const ollamaMessages = convertMessagesToOllama(messages);

  const req: OllamaChatRequest = {
    model,
    messages: ollamaMessages,
    stream,
  };

  // Map OpenAI options to Ollama options
  if (options?.temperature !== undefined || options?.max_tokens !== undefined) {
    req.options = {};
    if (options.temperature !== undefined) {
      req.options.temperature = options.temperature;
    }
    if (options.max_tokens !== undefined) {
      req.options.num_predict = options.max_tokens;
    }
  }

  // Pass through tools if the model supports them
  if (options?.tools && options.tools.length > 0) {
    req.tools = options.tools;
  }

  return req;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response Translation: Ollama → OpenAI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an Ollama /api/chat response to OpenAI chat completion format.
 */
export function convertOllamaResponse(
  ollamaData: OllamaChatResponse,
  requestedModel: string,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: ollamaData.message.content || null,
  };

  let finishReason = 'stop';

  // Handle tool calls if present
  if (ollamaData.message.tool_calls && ollamaData.message.tool_calls.length > 0) {
    message['tool_calls'] = ollamaData.message.tool_calls.map((tc, i) => ({
      id: `call_ollama_${Date.now()}_${i}`,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: JSON.stringify(tc.function.arguments),
      },
    }));
    finishReason = 'tool_calls';
  }

  return {
    id: `chatcmpl-ollama-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: ollamaData.prompt_eval_count ?? 0,
      completion_tokens: ollamaData.eval_count ?? 0,
      total_tokens:
        (ollamaData.prompt_eval_count ?? 0) +
        (ollamaData.eval_count ?? 0),
    },
  };
}

/**
 * Convert Ollama NDJSON streaming chunk to OpenAI SSE format.
 */
export function convertOllamaStreamChunk(
  chunk: OllamaStreamChunk,
  messageId: string,
  isFirst: boolean,
): string | null {
  const delta: Record<string, unknown> = {};

  if (isFirst) {
    delta['role'] = 'assistant';
  }

  if (chunk.message?.content) {
    delta['content'] = chunk.message.content;
  }

  const choice: Record<string, unknown> = {
    index: 0,
    delta,
    finish_reason: null,
  };

  if (chunk.done) {
    choice['finish_reason'] = 'stop';
    choice['delta'] = {};
  }

  const sseChunk = {
    id: messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: chunk.model,
    choices: [choice],
  };

  // Include usage in the final chunk
  if (chunk.done && (chunk.prompt_eval_count || chunk.eval_count)) {
    (sseChunk as Record<string, unknown>)['usage'] = {
      prompt_tokens: chunk.prompt_eval_count ?? 0,
      completion_tokens: chunk.eval_count ?? 0,
      total_tokens:
        (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
    };
  }

  return `data: ${JSON.stringify(sseChunk)}\n\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Forwarding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forward a non-streaming request to Ollama and return the response
 * translated to OpenAI format.
 */
export async function forwardToOllama(
  model: string,
  messages: Array<{ role: string; content: string | unknown; [key: string]: unknown }>,
  options?: {
    temperature?: number;
    max_tokens?: number;
    tools?: unknown[];
    baseUrl?: string;
    timeoutMs?: number;
  },
): Promise<{
  success: boolean;
  data?: Record<string, unknown>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: { code: string; message: string; status: number; retryable: boolean };
  latencyMs: number;
}> {
  const baseUrl = options?.baseUrl ?? OLLAMA_DEFAULTS.baseUrl;
  const timeoutMs = options?.timeoutMs ?? OLLAMA_DEFAULTS.timeoutMs;
  const start = Date.now();

  try {
    const reqBody = buildOllamaRequest(model, messages, false, options);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        success: false,
        error: {
          code: `ollama_${response.status}`,
          message: `Ollama returned ${response.status}: ${errText}`.trim(),
          status: response.status,
          retryable: response.status >= 500,
        },
        latencyMs: Date.now() - start,
      };
    }

    const ollamaData = (await response.json()) as OllamaChatResponse;
    const openAIResponse = convertOllamaResponse(ollamaData, model);
    const usage = openAIResponse['usage'] as { prompt_tokens: number; completion_tokens: number; total_tokens: number };

    return {
      success: true,
      data: openAIResponse,
      usage,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errMsg.includes('abort') || errMsg.includes('AbortError');
    return {
      success: false,
      error: {
        code: isTimeout ? 'ollama_timeout' : 'ollama_connection_error',
        message: isTimeout
          ? `Ollama request timed out after ${timeoutMs}ms`
          : `Failed to connect to Ollama: ${errMsg}`,
        status: isTimeout ? 408 : 502,
        retryable: true,
      },
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Forward a streaming request to Ollama.
 * Returns a readable stream of OpenAI-format SSE events.
 *
 * Ollama streams NDJSON (newline-delimited JSON), which we convert
 * to OpenAI SSE (data: {...}\n\n) on the fly.
 */
export async function forwardToOllamaStream(
  model: string,
  messages: Array<{ role: string; content: string | unknown; [key: string]: unknown }>,
  options?: {
    temperature?: number;
    max_tokens?: number;
    tools?: unknown[];
    baseUrl?: string;
    timeoutMs?: number;
  },
): Promise<{
  success: boolean;
  stream?: AsyncGenerator<string, void, unknown>;
  error?: { code: string; message: string; status: number; retryable: boolean };
}> {
  const baseUrl = options?.baseUrl ?? OLLAMA_DEFAULTS.baseUrl;
  const timeoutMs = options?.timeoutMs ?? OLLAMA_DEFAULTS.timeoutMs;

  try {
    const reqBody = buildOllamaRequest(model, messages, true, options);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        success: false,
        error: {
          code: `ollama_${response.status}`,
          message: `Ollama returned ${response.status}: ${errText}`.trim(),
          status: response.status,
          retryable: response.status >= 500,
        },
      };
    }

    const messageId = `chatcmpl-ollama-${Date.now()}`;

    async function* convertStream(): AsyncGenerator<string, void, unknown> {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body from Ollama');

      const decoder = new TextDecoder();
      let buffer = '';
      let isFirst = true;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Ollama streams NDJSON: one JSON object per line
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const chunk = JSON.parse(trimmed) as OllamaStreamChunk;
              const sseEvent = convertOllamaStreamChunk(chunk, messageId, isFirst);
              if (sseEvent) {
                yield sseEvent;
                isFirst = false;
              }

              if (chunk.done) {
                yield 'data: [DONE]\n\n';
                return;
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const chunk = JSON.parse(buffer.trim()) as OllamaStreamChunk;
            const sseEvent = convertOllamaStreamChunk(chunk, messageId, isFirst);
            if (sseEvent) yield sseEvent;
          } catch {
            // ignore
          }
        }

        yield 'data: [DONE]\n\n';
      } finally {
        reader.releaseLock();
      }
    }

    return {
      success: true,
      stream: convertStream(),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errMsg.includes('abort') || errMsg.includes('AbortError');
    return {
      success: false,
      error: {
        code: isTimeout ? 'ollama_timeout' : 'ollama_connection_error',
        message: isTimeout
          ? `Ollama request timed out after ${timeoutMs}ms`
          : `Failed to connect to Ollama: ${errMsg}`,
        status: isTimeout ? 408 : 502,
        retryable: true,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Caching for health status (avoid hammering Ollama on every request)
// ─────────────────────────────────────────────────────────────────────────────

let _healthCache: { result: OllamaHealthResult; checkedAt: number } | null = null;
const HEALTH_CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Check Ollama health with caching to avoid excessive probing.
 */
export async function checkOllamaHealthCached(
  baseUrl: string = OLLAMA_DEFAULTS.baseUrl,
): Promise<OllamaHealthResult> {
  const now = Date.now();
  if (_healthCache && now - _healthCache.checkedAt < HEALTH_CACHE_TTL_MS) {
    return _healthCache.result;
  }

  const result = await checkOllamaHealth(baseUrl);
  _healthCache = { result, checkedAt: now };
  return result;
}

/**
 * Clear the health cache (useful for testing or after config changes).
 */
export function clearOllamaHealthCache(): void {
  _healthCache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model mapping for cross-provider cascade
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map cloud model names to reasonable Ollama equivalents.
 * Used when falling back to Ollama from a cloud provider.
 */
export const CLOUD_TO_OLLAMA_MODEL_MAP: Record<string, string> = {
  // Anthropic → Ollama
  'claude-opus-4-6': 'llama3.2',
  'claude-sonnet-4-6': 'llama3.2',
  'claude-haiku-4-5': 'llama3.2',
  'claude-3-5-sonnet-latest': 'llama3.2',
  'claude-3-5-haiku-latest': 'llama3.2',
  // OpenAI → Ollama
  'gpt-4o': 'llama3.2',
  'gpt-4o-mini': 'llama3.2',
  'gpt-4.1': 'llama3.2',
  // Google → Ollama
  'gemini-2.0-flash': 'llama3.2',
  'gemini-2.0-flash-lite': 'llama3.2',
};

/**
 * Map a cloud model name to an Ollama model.
 * Returns the configured default or a reasonable fallback.
 */
export function mapCloudModelToOllama(
  cloudModel: string,
  config: OllamaProviderConfig,
): string {
  // Check custom mapping first
  const defaultModel = config.defaultModel ?? config.models?.[0];

  // Check built-in map
  const mapped = CLOUD_TO_OLLAMA_MODEL_MAP[cloudModel];
  if (mapped && config.models?.includes(mapped)) return mapped;

  // Fall back to default model
  return defaultModel ?? 'llama3.2';
}

// ─────────────────────────────────────────────────────────────────────────────
// Native Anthropic /v1/messages passthrough for Ollama
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an Anthropic Messages API response from Ollama.
 * Returns { valid: true } or { valid: false, reason: string }.
 *
 * Checks: content array, block types, tool_use fields, stop_reason, role, model, usage.
 */
export function validateAnthropicResponse(data: unknown): { valid: boolean; reason?: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: 'Response is not an object' };
  }

  const resp = data as Record<string, unknown>;

  if (!Array.isArray(resp['content'])) {
    return { valid: false, reason: 'Missing or non-array content field' };
  }

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
  }

  if (typeof resp['stop_reason'] !== 'string') {
    return { valid: false, reason: 'Missing or invalid stop_reason' };
  }

  if (resp['role'] !== 'assistant') {
    return { valid: false, reason: 'Missing or invalid role (expected "assistant")' };
  }

  if (typeof resp['model'] !== 'string') {
    return { valid: false, reason: 'Missing model field' };
  }

  if (!resp['usage'] || typeof resp['usage'] !== 'object') {
    return { valid: false, reason: 'Missing usage field' };
  }

  return { valid: true };
}

/**
 * Decide whether to route a /v1/messages request to Ollama's native endpoint.
 */
export function shouldRouteToOllamaNative(
  config: OllamaProviderConfig | undefined,
  complexity: string,
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
 * Resolve which Ollama model to use for the request.
 * - ollama/modelname → modelname
 * - Direct model match → as-is
 * - Complexity routing → default model or first configured model
 */
export function resolveOllamaNativeModel(
  config: OllamaProviderConfig,
  requestedModel: string,
): string {
  if (requestedModel.startsWith('ollama/')) {
    return requestedModel.slice('ollama/'.length);
  }
  if (config.models?.includes(requestedModel)) {
    return requestedModel;
  }
  return config.defaultModel ?? config.models?.[0] ?? 'llama3.2';
}

/**
 * Strip thinking-related fields from a request body before sending to Ollama.
 * Ollama models don't support Anthropic extended thinking.
 */
export function stripThinkingForOllama(body: Record<string, unknown>): Record<string, unknown> {
  const { thinking, ...rest } = body;
  return rest;
}

/**
 * Build a synthetic count_tokens response.
 * Ollama doesn't support /v1/messages/count_tokens, so we estimate.
 */
export function buildSyntheticTokenCount(body: Record<string, unknown>): { input_tokens: number } {
  let totalChars = 0;

  if (typeof body['system'] === 'string') {
    totalChars += body['system'].length;
  } else if (Array.isArray(body['system'])) {
    for (const block of body['system'] as Array<Record<string, unknown>>) {
      if (block['text'] && typeof block['text'] === 'string') {
        totalChars += block['text'].length;
      }
    }
  }

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

  if (Array.isArray(body['tools'])) {
    totalChars += JSON.stringify(body['tools']).length;
  }

  return { input_tokens: Math.ceil(totalChars / 4) };
}

/**
 * Forward a non-streaming request to Ollama's native /v1/messages endpoint.
 * Returns the raw response for validation before returning to the client.
 */
export async function forwardToOllamaNative(
  body: Record<string, unknown>,
  options?: {
    baseUrl?: string;
    timeoutMs?: number;
  },
): Promise<{
  success: boolean;
  status: number;
  data?: Record<string, unknown>;
  error?: string;
  latencyMs: number;
}> {
  const baseUrl = options?.baseUrl ?? OLLAMA_DEFAULTS.baseUrl;
  const timeoutMs = options?.timeoutMs ?? OLLAMA_DEFAULTS.timeoutMs;
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        success: false,
        status: response.status,
        error: `Ollama /v1/messages returned ${response.status}: ${errText}`.trim(),
        latencyMs: Date.now() - start,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    return {
      success: true,
      status: 200,
      data,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errMsg.includes('abort') || errMsg.includes('AbortError');
    return {
      success: false,
      status: isTimeout ? 408 : 502,
      error: isTimeout
        ? `Ollama request timed out after ${timeoutMs}ms`
        : `Failed to connect to Ollama: ${errMsg}`,
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Forward a streaming request to Ollama's native /v1/messages endpoint.
 * Returns the raw Response object so the proxy can pipe the SSE stream directly
 * to the client (Ollama's /v1/messages streams Anthropic-format SSE natively).
 */
export async function forwardToOllamaNativeStream(
  body: Record<string, unknown>,
  options?: {
    baseUrl?: string;
    timeoutMs?: number;
  },
): Promise<{
  success: boolean;
  response?: Response;
  error?: string;
}> {
  const baseUrl = options?.baseUrl ?? OLLAMA_DEFAULTS.baseUrl;
  const timeoutMs = options?.timeoutMs ?? OLLAMA_DEFAULTS.timeoutMs;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        success: false,
        error: `Ollama /v1/messages streaming returned ${response.status}: ${errText}`.trim(),
      };
    }

    return { success: true, response };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errMsg.includes('abort') || errMsg.includes('AbortError');
    return {
      success: false,
      error: isTimeout
        ? `Ollama stream timed out after ${timeoutMs}ms`
        : `Failed to connect to Ollama for streaming: ${errMsg}`,
    };
  }
}
