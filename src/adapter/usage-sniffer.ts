/**
 * Usage sniffer — extract provider-reported token usage from responses.
 *
 * Non-streaming bodies are parsed once after the upstream response arrives.
 * Streaming responses keep only a fixed-size tail window (4KB by default) of
 * the SSE stream, because usage events live at the end of the stream.
 *
 * Performance contract (Savings Ledger 决策 3):
 *   - The tail window is a single pre-allocated Uint8Array.
 *   - `push()` uses `TypedArray.set()` directly; no per-chunk allocation.
 *   - `text()` is called once, at stream end.
 *   - Buffer.concat / string accumulation is forbidden (1100× slower,评审红线).
 *
 * Anthropic SSE naturally carries usage:
 *   - `message_start` reports input tokens.
 *   - `message_delta` reports output tokens and cache read / write tokens.
 *   Because `message_start` is at the beginning of the stream, the sniffer
 *   inspects the first chunk(s) only until it finds that event; afterwards it
 *   only pushes into the tail window.
 *
 * OpenAI SSE only reports usage when the client sent `stream_options.include_usage`.
 * Some gateways strip or zero-out usage events; when `estimateMissingTokens` is
 * enabled the caller can fall back to text-length estimation so the ledger never
 * records all-zero usage for a real request.
 */

import { emptyUsage, type TokenUsage } from "../pricing/price-book.js";
import { estimateTokenCount, extractRequestText } from "./token-estimator.js";

export type UsageSource = "upstream" | "estimated" | "partial";

export type UsageCapture = {
  usage: TokenUsage;
  usageSource: UsageSource;
  truncated: boolean;
};

/** 4KB ring tail window. Exported for tests and the performance regression gate. */
export class TailWindow {
  private readonly buf: Uint8Array;
  private pos = 0;
  /** Logical bytes written into the window (capped at buf.length). */
  private size = 0;
  /** Total bytes ever pushed (including bytes that fell out of the window). */
  private total = 0;

  constructor(bytes: number) {
    this.buf = new Uint8Array(bytes);
  }

  /** Total bytes pushed since construction. */
  get totalBytes(): number {
    return this.total;
  }

  /** Direct write into the pre-allocated buffer. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;

    if (chunk.length >= this.buf.length) {
      // Chunk is larger than the window: keep only the trailing bytes. Align to
      // a UTF-8 character boundary so text() does not start with a continuation
      // byte and produce replacement characters.
      let start = chunk.length - this.buf.length;
      while (start < chunk.length && (chunk[start] & 0xc0) === 0x80) {
        start++;
      }
      const kept = chunk.slice(start);
      this.buf.set(kept);
      this.pos = 0;
      this.size = kept.length;
      return;
    }

    const remaining = this.buf.length - this.pos;
    if (chunk.length <= remaining) {
      this.buf.set(chunk, this.pos);
      this.pos += chunk.length;
    } else {
      this.buf.set(chunk.slice(0, remaining), this.pos);
      this.buf.set(chunk.slice(remaining), 0);
      this.pos = chunk.length - remaining;
    }
    this.size = Math.min(this.size + chunk.length, this.buf.length);
  }

  /** Reconstruct the logical content in order. Called once at stream end. */
  text(): string {
    if (this.size < this.buf.length) {
      return new TextDecoder().decode(this.buf.subarray(0, this.size));
    }
    const tail = this.buf.subarray(this.pos);
    const head = this.buf.subarray(0, this.pos);
    const ordered = new Uint8Array(this.buf.length);
    ordered.set(tail);
    ordered.set(head, tail.length);
    return new TextDecoder().decode(ordered);
  }
}

function safeInt(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** True when a usage object contains at least one positive token count. */
function hasPositiveUsage(usage: Record<string, unknown>): boolean {
  return (
    safeInt(usage.input_tokens) > 0 ||
    safeInt(usage.output_tokens) > 0 ||
    safeInt(usage.prompt_tokens) > 0 ||
    safeInt(usage.completion_tokens) > 0 ||
    safeInt(usage.cache_read_input_tokens) > 0 ||
    safeInt(usage.cache_creation_input_tokens) > 0 ||
    safeInt((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) > 0
  );
}

function parseAnthropicCacheCreation(usage: Record<string, unknown>): {
  cacheWrite5m: number;
  cacheWrite1h: number;
} {
  const total = safeInt(usage.cache_creation_input_tokens);
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  const explicit5m = safeInt(creation?.ephemeral_5m_input_tokens);
  const explicit1h = safeInt(creation?.ephemeral_1h_input_tokens);

  if (explicit5m === 0 && explicit1h === 0) {
    // No split provided: treat the aggregate as 5m, matching the legacy behavior.
    return { cacheWrite5m: total, cacheWrite1h: 0 };
  }

  // If the split sum differs from the aggregate (e.g. upstream rounded or only
  // reported one side), preserve the aggregate by assigning the remainder to 5m.
  const remainder = Math.max(0, total - explicit5m - explicit1h);
  return { cacheWrite5m: explicit5m + remainder, cacheWrite1h: explicit1h };
}

function parseAnthropicUsage(data: Record<string, unknown>): TokenUsage {
  const usage = (data.usage as Record<string, unknown>) || {};
  const input = safeInt(usage.input_tokens);
  const cacheRead = safeInt(usage.cache_read_input_tokens);
  const { cacheWrite5m, cacheWrite1h } = parseAnthropicCacheCreation(usage);
  const cacheWriteTotal = cacheWrite5m + cacheWrite1h;
  return {
    inputUncached: Math.max(0, input - cacheRead - cacheWriteTotal),
    output: safeInt(usage.output_tokens),
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
  };
}

export function extractAnthropicNonStreamingUsage(body: unknown): UsageCapture {
  const data = body as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    return { usage: emptyUsage(), usageSource: "estimated", truncated: false };
  }
  if ("usage" in data && data.usage && typeof data.usage === "object") {
    return { usage: parseAnthropicUsage(data), usageSource: "upstream", truncated: false };
  }
  return { usage: emptyUsage(), usageSource: "estimated", truncated: false };
}

export function extractOpenAINonStreamingUsage(body: unknown): UsageCapture {
  const data = body as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    return { usage: emptyUsage(), usageSource: "estimated", truncated: false };
  }
  const usage = (data.usage as Record<string, unknown>) || {};
  if (Object.keys(usage).length === 0) {
    return { usage: emptyUsage(), usageSource: "estimated", truncated: false };
  }
  const promptDetails = (usage.prompt_tokens_details as Record<string, unknown>) || {};
  const promptTokens = safeInt(usage.prompt_tokens);
  const cached = safeInt(promptDetails.cached_tokens);
  return {
    usage: {
      inputUncached: Math.max(0, promptTokens - cached),
      output: safeInt(usage.completion_tokens),
      cacheRead: cached,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    },
    usageSource: "upstream",
    truncated: false,
  };
}

export function extractAnthropicStreamUsage(tailText: string): UsageCapture {
  // Final event is `message_delta`; look for the last one in the tail.
  const deltaMatch = tailText.match(
    /event:\s*message_delta\s+data:\s*(\{[\s\S]*?\})(?=\s*\n\nevent:|\s*$)/,
  );
  if (deltaMatch) {
    try {
      const data = JSON.parse(deltaMatch[1]) as Record<string, unknown>;
      const usage = (data.usage as Record<string, unknown>) || {};
      if (hasPositiveUsage(usage)) {
        return { usage: parseAnthropicUsage(data), usageSource: "upstream", truncated: false };
      }
    } catch {
      // Fall through to estimated.
    }
  }
  return { usage: emptyUsage(), usageSource: "estimated", truncated: false };
}

export function extractOpenAIStreamUsage(tailText: string): UsageCapture {
  // OpenAI puts usage on the final data: line when include_usage is set.
  const lines = tailText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("data: ")) {
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const data = JSON.parse(payload) as Record<string, unknown>;
        const usage = (data.usage as Record<string, unknown>) || {};
        if (usage && typeof usage === "object" && hasPositiveUsage(usage)) {
          const promptDetails = (usage.prompt_tokens_details as Record<string, unknown>) || {};
          const promptTokens = safeInt(usage.prompt_tokens);
          const cached = safeInt(promptDetails.cached_tokens);
          return {
            usage: {
              inputUncached: Math.max(0, promptTokens - cached),
              output: safeInt(usage.completion_tokens),
              cacheRead: cached,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
            },
            usageSource: "upstream",
            truncated: false,
          };
        }
      } catch {
        // Keep scanning earlier lines.
      }
    }
  }
  return { usage: emptyUsage(), usageSource: "estimated", truncated: false };
}

export type FallbackEstimationOptions = {
  /** Master switch: do nothing when false. */
  estimateMissingTokens: boolean;
  /** Raw request body; used to estimate input tokens from JSON length. */
  rawBody?: unknown;
  /** Non-streaming response body string; used to estimate output tokens. */
  responseBody?: string;
  /** Streaming total bytes; used to estimate output tokens when responseBody is absent. */
  responseBytes?: number;
  /** Streaming accumulated response content text; preferred over responseBytes. */
  responseContentText?: string;
  /** Model/provider that served the request; drives character-class weights. */
  model?: string;
  /**
   * Deprecated crude fallback (chars / charsPerToken). Kept only for backward
   * compatibility; when `model` is provided the character-class estimator is used.
   */
  charsPerToken?: number;
};

/** Estimate tokens from text length when upstream usage is missing or empty. */
export function applyFallbackEstimation(
  capture: UsageCapture,
  opts: FallbackEstimationOptions,
): UsageCapture {
  if (!opts.estimateMissingTokens || capture.usageSource === "upstream") return capture;

  const requestText = opts.rawBody !== undefined ? extractRequestText(opts.rawBody) : "";
  const estimatedInput =
    requestText.length > 0 ? Math.max(1, estimateTokenCount(requestText, opts.model)) : 0;

  let estimatedOutput = 0;
  if (opts.responseBody !== undefined && opts.responseBody.length > 0) {
    estimatedOutput = Math.max(1, estimateTokenCount(opts.responseBody, opts.model));
  } else if (opts.responseContentText !== undefined && opts.responseContentText.length > 0) {
    // Prefer accumulated delta.content length over raw SSE bytes.
    estimatedOutput = Math.max(1, estimateTokenCount(opts.responseContentText, opts.model));
  } else if (opts.responseBytes !== undefined && opts.responseBytes > 0) {
    // Streaming bytes are mostly JSON framing; use the legacy byte divisor as a
    // conservative fallback when we don't have the actual response text.
    const charsPerToken = opts.charsPerToken ?? 4;
    estimatedOutput = Math.max(1, Math.ceil(opts.responseBytes / charsPerToken));
  }

  const usage: TokenUsage = { ...capture.usage };
  let changed = false;

  const inputEmpty =
    usage.inputUncached === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite5m === 0 &&
    usage.cacheWrite1h === 0;
  if (inputEmpty && estimatedInput > 0) {
    usage.inputUncached = estimatedInput;
    changed = true;
  }
  if (usage.output === 0 && estimatedOutput > 0) {
    usage.output = estimatedOutput;
    changed = true;
  }

  if (!changed) return capture;
  return { ...capture, usage, usageSource: "estimated" };
}

function extractContentFromDataLine(line: string): string {
  const idx = line.indexOf("data:");
  if (idx === -1) return "";
  const payload = line.slice(idx + 5).trim();
  if (payload === "[DONE]") return "";
  // Fast reject: only lines that may carry content need JSON parsing.
  if (!payload.includes('"content"') && !payload.includes('"text"')) return "";
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(choices)) {
      return choices
        .map((c) => {
          const delta = c.delta as Record<string, unknown> | undefined;
          const content = delta?.content;
          return typeof content === "string" ? content : "";
        })
        .join("");
    }
    const delta = data.delta as Record<string, unknown> | undefined;
    if (delta) {
      const text = delta.text;
      if (typeof text === "string") return text;
    }
  } catch {
    // Malformed line in a partial chunk — will be reassembled next push.
  }
  return "";
}

const CONTENT_BUFFER_CAP = 4096;

/** Append extracted content to a bounded buffer, keeping the most recent text. */
function appendContent(buffer: string, text: string): string {
  if (text.length === 0) return buffer;
  const combined = buffer + text;
  if (combined.length <= CONTENT_BUFFER_CAP) return combined;
  return combined.slice(combined.length - CONTENT_BUFFER_CAP);
}

/** Accumulate delta content text across SSE data lines. */
function accumulateContent(buffer: string, text: string): { buffer: string; content: string } {
  const combined = buffer + text;
  let content = "";
  let start = 0;
  let end = combined.indexOf("\n");
  while (end !== -1) {
    content += extractContentFromDataLine(combined.slice(start, end));
    start = end + 1;
    end = combined.indexOf("\n", start);
  }
  return { buffer: combined.slice(start), content };
}

/** Common interface for streaming capture. */
export type UsageSniffer = {
  push(chunk: Uint8Array): void;
  finish(truncated?: boolean): UsageCapture;
  readonly totalBytes: number;
  /** Bounded accumulated delta content text, used for fallback estimation. */
  readonly contentText: string;
};

class AnthropicStreamSniffer implements UsageSniffer {
  private readonly tail: TailWindow;
  private readonly accumulateContent: boolean;
  private inputTokens: number | null = null;
  private prefixBuffer = "";
  private gotStart = false;
  private contentBuffer = "";
  private contentLineBuffer = "";

  constructor(tailBytes: number, accumulateContent = false) {
    this.tail = new TailWindow(tailBytes);
    this.accumulateContent = accumulateContent;
  }

  get totalBytes(): number {
    return this.tail.totalBytes;
  }

  get contentText(): string {
    return this.contentBuffer;
  }

  push(chunk: Uint8Array): void {
    const text = new TextDecoder().decode(chunk);

    if (!this.gotStart) {
      this.prefixBuffer += text;
      const match = this.prefixBuffer.match(
        /event:\s*message_start\s+data:\s*(\{[\s\S]*?\})(?=\s*\n\nevent:|\s*$)/,
      );
      if (match) {
        try {
          const data = JSON.parse(match[1]) as Record<string, unknown>;
          const usage = (data.message as Record<string, unknown>)?.usage as
            Record<string, unknown> | undefined;
          if (usage && typeof usage === "object" && hasPositiveUsage(usage)) {
            this.inputTokens = safeInt(usage.input_tokens);
          }
        } catch {
          // ignore
        }
        this.gotStart = true;
      } else if (this.prefixBuffer.length >= 4096) {
        // Give up looking for message_start; stream is too long at the front.
        this.gotStart = true;
      }
    }

    if (this.accumulateContent) {
      const { buffer, content } = accumulateContent(this.contentLineBuffer, text);
      this.contentLineBuffer = buffer;
      this.contentBuffer = appendContent(this.contentBuffer, content);
    }

    this.tail.push(chunk);
  }

  finish(truncated = false): UsageCapture {
    const tail = extractAnthropicStreamUsage(this.tail.text());
    const inputTotal = this.inputTokens ?? 0;
    const cacheRead = tail.usage.cacheRead;
    const cacheWrite5m = tail.usage.cacheWrite5m;
    const usage: TokenUsage = {
      inputUncached: Math.max(0, inputTotal - cacheRead - cacheWrite5m),
      output: tail.usage.output,
      cacheRead,
      cacheWrite5m,
      cacheWrite1h: tail.usage.cacheWrite1h,
    };

    let source: UsageSource = tail.usageSource;
    if (this.inputTokens === null && tail.usageSource === "upstream") {
      source = "partial";
    }
    if (this.inputTokens !== null && tail.usageSource === "estimated") {
      source = "partial";
    }

    return { usage, usageSource: source, truncated };
  }
}

class OpenAIStreamSniffer implements UsageSniffer {
  private readonly tail: TailWindow;
  private readonly accumulateContent: boolean;
  private contentBuffer = "";
  private contentLineBuffer = "";

  constructor(tailBytes: number, accumulateContent = false) {
    this.tail = new TailWindow(tailBytes);
    this.accumulateContent = accumulateContent;
  }

  get totalBytes(): number {
    return this.tail.totalBytes;
  }

  get contentText(): string {
    return this.contentBuffer;
  }

  push(chunk: Uint8Array): void {
    if (!this.accumulateContent) {
      this.tail.push(chunk);
      return;
    }
    const text = new TextDecoder().decode(chunk);
    const { buffer, content } = accumulateContent(this.contentLineBuffer, text);
    this.contentLineBuffer = buffer;
    this.contentBuffer = appendContent(this.contentBuffer, content);
    this.tail.push(chunk);
  }

  finish(truncated = false): UsageCapture {
    const result = extractOpenAIStreamUsage(this.tail.text());
    return { ...result, truncated };
  }
}

export function createUsageSniffer(
  protocol: "anthropic" | "openai",
  tailBytes: number,
  accumulateContent = false,
): UsageSniffer {
  if (protocol === "anthropic") return new AnthropicStreamSniffer(tailBytes, accumulateContent);
  return new OpenAIStreamSniffer(tailBytes, accumulateContent);
}
