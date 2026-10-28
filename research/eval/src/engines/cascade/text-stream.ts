/** LLM の stream を扱う純関数: SSE の分解と、英訳 token 列から TTS へ渡す片を切る。 */

export interface SseEvent {
  readonly event?: string;
  readonly data: string;
}

export class SseParser {
  private buffer = "";

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.parseBlock(block);
    }
  }

  end(): void {
    if (this.buffer.trim().length > 0) this.parseBlock(this.buffer);
    this.buffer = "";
  }

  private parseBlock(block: string): void {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.length === 0 || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    this.onEvent(event === undefined ? { data: data.join("\n") } : { event, data: data.join("\n") });
  }
}

export type TtsChunkMode = "sentence" | "clause" | "unit";

function countWords(text: string): number {
  return text.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * 英訳の stream を TTS へ渡す片に切る。
 * sentence: . ? ! の後に空白が来たら（3 語以上）。clause: さらに , ; : — の後（6 語以上）。unit: 切らない。
 * 次の文字を見るまで切らないので "2.5" や "U.S." では切れない。
 */
export class EnglishChunker {
  private buffer = "";

  constructor(
    private readonly mode: TtsChunkMode,
    private readonly minSentenceWords = 3,
    private readonly minClauseWords = 6,
  ) {}

  push(delta: string): string[] {
    this.buffer += delta;
    if (this.mode === "unit") return [];
    const out: string[] = [];
    for (;;) {
      const index = this.findSplit();
      if (index < 0) break;
      const chunk = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index);
      if (chunk.length > 0) out.push(chunk);
    }
    return out;
  }

  /** 残りを返す（空なら null）。 */
  finish(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest.length > 0 ? rest : null;
  }

  private findSplit(): number {
    const text = this.buffer;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const sentence = ch === "." || ch === "?" || ch === "!" || ch === "…";
      const clause = this.mode === "clause" && (ch === "," || ch === ";" || ch === ":" || ch === "—");
      if (!sentence && !clause) continue;
      let j = i + 1;
      while (j < text.length && /["'”’)\]]/u.test(text[j] ?? "")) j++;
      if (j >= text.length) return -1;
      if (!/\s/u.test(text[j] ?? "")) continue;
      const words = countWords(text.slice(0, j));
      if (sentence && words >= this.minSentenceWords) return j;
      if (clause && words >= this.minClauseWords) return j;
    }
    return -1;
  }
}
