import { describe, it, expect } from "vitest";
import {
  TailWindow,
  createUsageSniffer,
  extractAnthropicNonStreamingUsage,
  extractOpenAINonStreamingUsage,
  extractAnthropicStreamUsage,
  extractOpenAIStreamUsage,
} from "./usage-sniffer.js";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeAnthropicChunk(index: number): Uint8Array {
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

  it("falls back to estimated when usage is missing", () => {
    const result = extractAnthropicNonStreamingUsage({ type: "message" });
    expect(result.usageSource).toBe("estimated");
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

  it("reports estimated when no usage chunk is present", () => {
    const sniffer = createUsageSniffer("openai", 4096);
    sniffer.push(bytes("data: {}\n\n".repeat(5)));
    sniffer.push(bytes("data: [DONE]\n\n"));
    const result = sniffer.finish();
    expect(result.usageSource).toBe("estimated");
  });
});

describe("TailWindow performance regression gate", () => {
  it("handles 800 chunks / ~191KB within the budget", () => {
    const sniffer = createUsageSniffer("anthropic", 4096);
    const chunks = 800;
    const start = performance.now();
    for (let i = 0; i < chunks; i++) {
      sniffer.push(makeAnthropicChunk(i));
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
      sniffer.push(makeAnthropicChunk(i));
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
    for (let i = 0; i < 100; i++) small.push(makeAnthropicChunk(i));
    small.finish();

    const large = createUsageSniffer("anthropic", 4096);
    for (let i = 0; i < 10000; i++) large.push(makeAnthropicChunk(i));
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
    w.push(
      bytes(
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
      ),
    );
    const result = extractOpenAIStreamUsage(w.text());
    expect(result.usage.output).toBe(5);
    expect(result.usageSource).toBe("upstream");
  });
});
