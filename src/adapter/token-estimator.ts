/**
 * Character-class weighted token estimator.
 *
 * When an upstream gateway omits usage, crude `length / 4` estimates are
 * wildly wrong for non-Latin text and for bodies that carry base64 images.
 * This module ports new-api's per-provider heuristic: treat CJK characters,
 * emoji, symbols, numbers and Latin words as separate token classes with
 * provider-specific weights, and strip base64 multimodal payloads before
 * measuring anything.
 *
 * The output is an integer token count meant for the ledger fallback path;
 * it is not a real tokenizer and does not replace upstream-reported usage.
 */

export type ProviderFamily = "openai" | "claude" | "gemini";

type Multipliers = {
  word: number;
  number: number;
  cjk: number;
  symbol: number;
  mathSymbol: number;
  urlDelim: number;
  atSign: number;
  emoji: number;
  newline: number;
  space: number;
};

const MULTIPLIERS: Record<ProviderFamily, Multipliers> = {
  openai: {
    word: 1.02,
    number: 1.55,
    cjk: 0.85,
    symbol: 0.4,
    mathSymbol: 2.68,
    urlDelim: 1.0,
    atSign: 2.0,
    emoji: 2.12,
    newline: 0.5,
    space: 0.42,
  },
  claude: {
    word: 1.13,
    number: 1.63,
    cjk: 1.21,
    symbol: 0.4,
    mathSymbol: 4.52,
    urlDelim: 1.26,
    atSign: 2.82,
    emoji: 2.6,
    newline: 0.89,
    space: 0.39,
  },
  gemini: {
    word: 1.15,
    number: 2.8,
    cjk: 0.68,
    symbol: 0.38,
    mathSymbol: 1.05,
    urlDelim: 1.2,
    atSign: 2.5,
    emoji: 1.08,
    newline: 1.15,
    space: 0.2,
  },
};

/** Map a provider-prefixed model id (or bare model name) to a known family. */
export function providerFromModel(model?: string): ProviderFamily {
  if (!model) return "openai";
  const lower = model.toLowerCase();
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("claude")) return "claude";
  return "openai";
}

function isCJK(r: number): boolean {
  return (
    (r >= 0x4e00 && r <= 0x9fff) || // CJK Unified Ideographs
    (r >= 0x3040 && r <= 0x30ff) || // Hiragana + Katakana
    (r >= 0xac00 && r <= 0xd7a3) // Hangul Syllables
  );
}

function isEmoji(r: number): boolean {
  return (
    (r >= 0x1f300 && r <= 0x1f9ff) ||
    (r >= 0x2600 && r <= 0x26ff) ||
    (r >= 0x2700 && r <= 0x27bf) ||
    (r >= 0x1f600 && r <= 0x1f64f) ||
    (r >= 0x1f900 && r <= 0x1f9ff) ||
    (r >= 0x1fa00 && r <= 0x1faff)
  );
}

function isMathSymbol(r: number): boolean {
  if (r >= 0x2200 && r <= 0x22ff) return true;
  if (r >= 0x2a00 && r <= 0x2aff) return true;
  if (r >= 0x1d400 && r <= 0x1d7ff) return true;
  return false;
}

function isURLDelim(r: number): boolean {
  return [0x2f, 0x3a, 0x3f, 0x26, 0x3d, 0x3b, 0x23, 0x25].includes(r); // / : ? & = ; # %
}

function isLatinOrNumber(r: number): boolean {
  return (
    (r >= 0x41 && r <= 0x5a) || // A-Z
    (r >= 0x61 && r <= 0x7a) || // a-z
    (r >= 0x30 && r <= 0x39) // 0-9
  );
}

function isSpace(r: number): boolean {
  return r === 0x20 || r === 0x0d || r === 0xa0;
}

function isNewline(r: number): boolean {
  return r === 0x0a || r === 0x09;
}

type WordType = "none" | "latin" | "number";

/**
 * Estimate token count from text using provider-specific character-class weights.
 * Returns 0 for empty/undefined text.
 */
export function estimateTokenCount(text: string | undefined, model?: string): number {
  if (!text) return 0;
  const m = MULTIPLIERS[providerFromModel(model)];
  let count = 0;
  let current: WordType = "none";

  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i) ?? 0;
    const charLen = code > 0xffff ? 2 : 1;

    if (isNewline(code)) {
      current = "none";
      count += m.newline;
    } else if (isSpace(code)) {
      current = "none";
      count += m.space;
    } else if (isCJK(code)) {
      current = "none";
      count += m.cjk;
    } else if (isEmoji(code)) {
      current = "none";
      count += m.emoji;
    } else if (isLatinOrNumber(code)) {
      const isNum = code >= 0x30 && code <= 0x39;
      const next: WordType = isNum ? "number" : "latin";
      if (current === "none" || current !== next) {
        count += isNum ? m.number : m.word;
        current = next;
      }
      // same-run continuation is free
    } else {
      current = "none";
      if (code === 0x40) {
        count += m.atSign;
      } else if (isMathSymbol(code)) {
        count += m.mathSymbol;
      } else if (isURLDelim(code)) {
        count += m.urlDelim;
      } else {
        count += m.symbol;
      }
    }

    i += charLen;
  }

  return Math.max(0, Math.ceil(count));
}

/** Strip data-URI base64 so a 1MB image does not inflate the estimate. */
function stripBase64(text: string): string {
  // Matches `data:[mime/type];base64,XXXX...` where XXXX is base64-ish.
  return text.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, "");
}

function extractTextFromContentPart(part: unknown): string {
  if (typeof part === "string") return stripBase64(part);
  if (!part || typeof part !== "object") return "";
  const p = part as Record<string, unknown>;

  if (p.type === "text" && typeof p.text === "string") {
    return stripBase64(p.text);
  }

  if (p.type === "image_url") {
    const url =
      typeof p.image_url === "string"
        ? p.image_url
        : typeof p.image_url === "object" && p.image_url
          ? String((p.image_url as Record<string, unknown>).url ?? "")
          : "";
    // Keep only a tiny marker — the image itself contributes geometric tokens,
    // not its base64 byte count. A fixed per-image overhead is handled elsewhere.
    return url.startsWith("data:") ? "" : "";
  }

  if (p.type === "image") {
    const source = p.source as Record<string, unknown> | undefined;
    if (source?.type === "base64" && typeof source.data === "string") {
      return "";
    }
  }

  return "";
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return stripBase64(content);
  if (Array.isArray(content)) {
    return content.map(extractTextFromContentPart).join("");
  }
  return "";
}

/**
 * Extract human-readable text from a request body for token estimation.
 *
 * Supports OpenAI and Anthropic message shapes, strips base64 multimodal
 * payloads, and ignores tool definitions / schemas. Returns empty string for
 * non-object or unrecognised bodies.
 */
export function extractRequestText(rawBody: unknown): string {
  if (!rawBody || typeof rawBody !== "object") return "";
  const body = rawBody as Record<string, unknown>;
  const messages = body.messages;
  if (!Array.isArray(messages)) return "";

  const parts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const text = extractTextFromContent((msg as Record<string, unknown>).content);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Convenience helper: extract text from a request body and estimate tokens.
 */
export function estimateRequestTokens(rawBody: unknown, model?: string): number {
  return estimateTokenCount(extractRequestText(rawBody), model);
}
