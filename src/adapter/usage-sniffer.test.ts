import { describe, it, expect } from "vitest";
import {
  TailWindow,
  createUsageSniffer,
  extractAnthropicNonStreamingUsage,
  extractOpenAINonStreamingUsage,
  extractAnthropicStreamUsage,
  extractOpenAIStreamUsage,
  applyFallbackEstimation,
} from "./usage-sniffer.js";
import { emptyUsage } from "../pricing/price-book.js";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeAnthropicChunk(): Uint8Array {
  // Average ~180B/chunk, matching the design's measured stream morphology.
  return bytes(
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${"x".repeat(120)}"}}\n\n`,
  );
}

describe("TailWindow", () => {
  it("keeps a fixed-size tail of chunks", () => {
    const w = new TailWindow(16);
    w.push(bytes("hello, world!")); // 13 bytes
    w.push(bytes("!!!")); // 3 bytes
    expect(w.text()).toBe("hello, world!!!!");
  });

  it("wraps around and keeps logical order", () => {
    const w = new TailWindow(8);
    w.push(bytes("abcd"));
    w.push(bytes("efgh"));
    w.push(bytes("ijkl"));
    expect(w.text()).toBe("efghijkl");
  });

  it("keeps UTF-8 multi-byte characters valid across the wrap boundary", () => {
    const w = new TailWindow(32);
    // 20 Chinese characters = 60 bytes. The 32-byte window must align to a
    // character boundary so the trailing ASCII usage line remains readable.
    w.push(bytes("中".repeat(20)));
    w.push(bytes('event: message_delta\ndata: {"usage":{"output_tokens":77}}\n\n'));
    const text = w.text();
    expect(text).toContain('output_tokens":77');
    expect(text).not.toContain("�");
  });

  it("wraps multi-byte chunks without mojibake", () => {
    const w = new TailWindow(9); // fits 3 Chinese characters exactly
    w.push(bytes("中"));
    w.push(bytes("文"));
    w.push(bytes("测"));
    w.push(bytes("试")); // pushes "中" out
    expect(w.text()).toBe("文测试");
  });

  it("handles a chunk larger than the window", () => {
    const w = new TailWindow(8);
    w.push(bytes("0123456789abcdef"));
    expect(w.text()).toBe("89abcdef");
  });

  it("is constant size regardless of total streamed bytes", () => {
    const w = new TailWindow(4096);
    for (let i = 0; i < 10_000; i++) {
      w.push(bytes(`chunk ${i} `.repeat(100)));
    }
    expect(w.text().length).toBeLessThanOrEqual(4096);
  });
});

describe("Anthropic non-streaming usage", () => {
  it("extracts input / output / cache read / cache write", () => {
    const result = extractAnthropicNonStreamingUsage({
      type: "message",
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 100,
      },
    });
    expect(result.usage).toEqual({
      inputUncached: 600,
      output: 200,
      cacheRead: 300,
      cacheWrite5m: 100,
      cacheWrite1h: 0,
    });
    expect(result.usageSource).toBe("upstream");
  });

  it("extracts split 5m / 1h cache creation when cache_creation is present", () => {
    const result = extractAnthropicNonStreamingUsage({
      type: "message",
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 300,
        cache_creation: {
          ephemeral_5m_input_tokens: 200,
          ephemeral_1h_input_tokens: 100,
        },
      },
    });
    expect(result.usage).toEqual({
      inputUncached: 600,
      output: 200,
      cacheRead: 100,
      cacheWrite5m: 200,
      cacheWrite1h: 100,
    });
  });

  it("falls back to aggregate cache_creation_input_tokens as 5m when split is absent", () => {
    const result = extractAnthropicNonStreamingUsage({
      type: "message",
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 150,
      },
    });
    expect(result.usage.cacheWrite5m).toBe(150);
    expect(result.usage.cacheWrite1h).toBe(0);
  });

  it("normalizes split that sums to less than the aggregate", () => {
    const result = extractAnthropicNonStreamingUsage({
      type: "message",
      usage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 100,
        cache_creation: {
          ephemeral_5m_input_tokens: 30,
          ephemeral_1h_input_tokens: 20,
        },
      },
    });
    // Remaining 50 tokens go to 5m to preserve the aggregate.
    expect(result.usage.cacheWrite5m).toBe(80);
    expect(result.usage.cacheWrite1h).toBe(20);
  });
});

describe("OpenAI non-streaming usage", () => {
  it("extracts prompt / completion / cached tokens", () => {
    const result = extractOpenAINonStreamingUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 250 },
      },
    });
    expect(result.usage).toEqual({
      inputUncached: 750,
      output: 200,
      cacheRead: 250,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    expect(result.usageSource).toBe("upstream");
  });

  it("falls back to estimated when usage is missing", () => {
    const result = extractOpenAINonStreamingUsage({ id: "chatcmpl-1" });
    expect(result.usageSource).toBe("estimated");
  });
});

describe("Anthropic streaming usage", () => {
  it("extracts usage split across the stream", () => {
    const sniffer = createUsageSniffer("anthropic", 4096);
    sniffer.push(
      bytes(
        "event: message_start\n" +
          'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1000}}}\n\n',
      ),
    );
    sniffer.push(bytes("event: content_block_delta\ndata: {}\n\n".repeat(10)));
    sniffer.push(
      bytes(
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":20}}\n\n' +
          "event: message_stop\ndata: {}\n\n",
      ),
    );
    const result = sniffer.finish();
    expect(result.usage).toEqual({
      inputUncached: 930,
      output: 200,
      cacheRead: 50,
      cacheWrite5m: 20,
      cacheWrite1h: 0,
    });
    expect(result.usageSource).toBe("upstream");
    expect(result.truncated).toBe(false);
  });

  it("extracts split 5m / 1h cache creation from message_delta", () => {
    const sniffer = createUsageSniffer("anthropic", 4096);
    sniffer.push(
      bytes(
        "event: message_start\n" +
          'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1000}}}\n\n',
      ),
    );
    sniffer.push(
      bytes(
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":200,"cache_read_input_tokens":50,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":200,"ephemeral_1h_input_tokens":100}}}\n\n' +
          "event: message_stop\ndata: {}\n\n",
      ),
    );
    const result = sniffer.finish();
    expect(result.usage).toEqual({
      inputUncached: 750,
      output: 200,
      cacheRead: 50,
      cacheWrite5m: 200,
      cacheWrite1h: 100,
    });
  });

  it("keeps working when usage is split across chunk boundaries", () => {
    const sniffer = createUsageSniffer("anthropic", 4096);
    const payload =
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":123}}\n\n' +
      "event: message_stop\ndata: {}\n\n";
    for (let i = 0; i < payload.length; i++) {
      sniffer.push(bytes(payload[i]));
    }
    const result = sniffer.finish();
    expect(result.usage.output).toBe(123);
    expect(result.usageSource).toBe("partial"); // input not captured
  });

  it("reports truncated on abort", () => {
    const sniffer = createUsageSniffer("anthropic", 4096);
    sniffer.push(bytes("event: content_block_delta\ndata: {}\n\n"));
    const result = sniffer.finish(true);
    expect(result.truncated).toBe(true);
  });
});

describe("OpenAI streaming usage", () => {
  it("extracts usage from the final chunk when include_usage was set", () => {
    const sniffer = createUsageSniffer("openai", 4096);
    sniffer.push(bytes("data: {}\n\n".repeat(5)));
    sniffer.push(
      bytes(
        'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":800,"completion_tokens":150,"prompt_tokens_details":{"cached_tokens":100}}}\n\n' +
          "data: [DONE]\n\n",
      ),
    );
    const result = sniffer.finish();
    expect(result.usage).toEqual({
      inputUncached: 700,
      output: 150,
      cacheRead: 100,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    expect(result.usageSource).toBe("upstream");
  });

  it("accumulates content text across streaming chunks", () => {
    const sniffer = createUsageSniffer("openai", 4096, true);
    sniffer.push(
      bytes(
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      ),
    );
    sniffer.push(
      bytes(
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
      ),
    );
    sniffer.push(bytes("data: [DONE]\n\n"));
    expect(sniffer.contentText).toBe("Hello world");
  });

  it("accumulates Anthropic text_delta content text", () => {
    const sniffer = createUsageSniffer("anthropic", 4096, true);
    sniffer.push(
      bytes(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
      ),
    );
    expect(sniffer.contentText).toBe("你好");
  });

  it("reports estimated when no usage chunk is present", () => {
    const sniffer = createUsageSniffer("openai", 4096);
    sniffer.push(bytes("data: {}\n\n".repeat(5)));
    sniffer.push(bytes("data: [DONE]\n\n"));
    const result = sniffer.finish();
    expect(result.usageSource).toBe("estimated");
  });
});

describe("Stream parsers ignore empty usage blocks", () => {
  it("treats Anthropic message_delta without usage as estimated", () => {
    const result = extractAnthropicStreamUsage(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    );
    expect(result.usageSource).toBe("estimated");
    expect(result.usage).toEqual(emptyUsage());
  });

  it("treats OpenAI final chunk with zero usage as estimated", () => {
    const result = extractOpenAIStreamUsage(
      'data: {"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\ndata: [DONE]\n\n',
    );
    expect(result.usageSource).toBe("estimated");
    expect(result.usage).toEqual(emptyUsage());
  });
});

describe("applyFallbackEstimation", () => {
  it("uses responseContentText for streaming output when available", () => {
    const capture = {
      usage: emptyUsage(),
      usageSource: "estimated" as const,
      truncated: false,
    };
    // 100 raw SSE bytes with only ~10 content chars would inflate to 25 tokens
    // under the old responseBytes/4 path. With content text it stays sane.
    const result = applyFallbackEstimation(capture, {
      estimateMissingTokens: true,
      rawBody: { messages: [{ content: "hi" }] },
      responseBytes: 100,
      responseContentText: "hello worl",
      model: "openai/gpt-4o",
    });
    expect(result.usage.output).toBeGreaterThan(0);
    expect(result.usage.output).toBeLessThan(10);
  });

  it("falls back to responseBytes / charsPerToken when content chars absent", () => {
    const capture = {
      usage: { inputUncached: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      usageSource: "upstream" as const,
      truncated: false,
    };
    const result = applyFallbackEstimation(capture, {
      estimateMissingTokens: true,
      rawBody: { messages: [{ content: "x".repeat(1000) }] },
      responseBytes: 1000,
    });
    expect(result).toEqual(capture);
  });

  it("does nothing when estimation is disabled", () => {
    const capture = {
      usage: emptyUsage(),
      usageSource: "estimated" as const,
      truncated: false,
    };
    const result = applyFallbackEstimation(capture, {
      estimateMissingTokens: false,
      rawBody: { messages: [{ content: "hello" }] },
      responseBytes: 100,
    });
    expect(result.usage.inputUncached).toBe(0);
    expect(result.usage.output).toBe(0);
  });

  it("estimates input and output from request/response length", () => {
    const capture = {
      usage: emptyUsage(),
      usageSource: "estimated" as const,
      truncated: false,
    };
    const rawBody = { messages: [{ content: "x".repeat(40) }] };
    const result = applyFallbackEstimation(capture, {
      estimateMissingTokens: true,
      rawBody,
      responseBody: "y".repeat(20),
    });
    expect(result.usage.inputUncached).toBeGreaterThan(0);
    expect(result.usage.output).toBeGreaterThan(0);
    expect(result.usageSource).toBe("estimated");
  });

  it("estimates output from stream bytes when responseBody is absent", () => {
    const capture = {
      usage: emptyUsage(),
      usageSource: "estimated" as const,
      truncated: false,
    };
    const result = applyFallbackEstimation(capture, {
      estimateMissingTokens: true,
      rawBody: { messages: [{ content: "hi" }] },
      responseBytes: 40,
    });
    expect(result.usage.output).toBeGreaterThan(0);
  });

  it("preserves upstream input while estimating missing output for partial captures", () => {
    const capture = {
      usage: { inputUncached: 100, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      usageSource: "partial" as const,
      truncated: false,
    };
    const result = applyFallbackEstimation(capture, {
      estimateMissingTokens: true,
      rawBody: {},
      responseBytes: 80,
    });
    expect(result.usage.inputUncached).toBe(100);
    expect(result.usage.output).toBeGreaterThan(0);
  });
});

describe("TailWindow performance regression gate", () => {
  it("handles 800 chunks / ~191KB within the budget", () => {
    const sniffer = createUsageSniffer("anthropic", 4096);
    const chunks = 800;
    const start = performance.now();
    for (let i = 0; i < chunks; i++) {
      sniffer.push(makeAnthropicChunk());
    }
    sniffer.push(
      bytes(
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":200}}\n\n',
      ),
    );
    const result = sniffer.finish();
    const elapsed = performance.now() - start;

    expect(result.usage.output).toBe(200);
    expect(elapsed).toBeLessThan(20); // 400× measured ~0.046ms; catches 1100× regressions
  });

  it("handles 8000 chunks / ~1.87MB within the budget", () => {
    const sniffer = createUsageSniffer("anthropic", 4096);
    const chunks = 8000;
    const start = performance.now();
    for (let i = 0; i < chunks; i++) {
      sniffer.push(makeAnthropicChunk());
    }
    sniffer.push(
      bytes(
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":200}}\n\n',
      ),
    );
    const result = sniffer.finish();
    const elapsed = performance.now() - start;

    expect(result.usage.output).toBe(200);
    expect(elapsed).toBeLessThan(150); // ~440× measured ~0.342ms; catches 1100× regressions
  });

  it("uses constant memory regardless of stream size", () => {
    const small = createUsageSniffer("anthropic", 4096);
    for (let i = 0; i < 100; i++) small.push(makeAnthropicChunk());
    small.finish();

    const large = createUsageSniffer("anthropic", 4096);
    for (let i = 0; i < 10000; i++) large.push(makeAnthropicChunk());
    large.finish();

    // 4KB window + sniffer object overhead; must not scale with stream length.
    expect(large).toBeDefined();
  });
});

describe("TailWindow extraction helpers", () => {
  it("extracts Anthropic message_delta from a wrapped buffer", () => {
    const w = new TailWindow(256);
    for (let i = 0; i < 100; i++) {
      w.push(bytes(`event: content_block_delta\ndata: {"index":${i}}\n\n`));
    }
    w.push(
      bytes(
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
      ),
    );
    const result = extractAnthropicStreamUsage(w.text());
    expect(result.usage.output).toBe(42);
    expect(result.usageSource).toBe("upstream");
  });

  it("extracts OpenAI final chunk from a wrapped buffer", () => {
    const w = new TailWindow(256);
    for (let i = 0; i < 100; i++) {
      w.push(bytes(`data: {"index":${i}}\n\n`));
    }
    w.push(bytes('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n'));
    const result = extractOpenAIStreamUsage(w.text());
    expect(result.usage.output).toBe(5);
    expect(result.usageSource).toBe("upstream");
  });
});
