/**
 * ASR item ごとの delta / completed を、順序どおりの安定テキスト S にまとめる（純粋）。
 * - item の順序は最初に見えた順（delta か committed の早い方）。committed の previous_item_id で補正する。
 * - 先頭の未確定 item だけが delta を S に出す（後続 item は先頭が確定するまで保留: head-of-line）。
 * - 確定時に delta 連結と最終文字列が違えば、最終文字列を正とする（revised として数える）。
 */

interface ItemState {
  readonly id: string;
  deltas: string;
  final: string | null;
}

export interface CompletionResult {
  /** 最終文字列が delta の連結と違った。 */
  readonly revised: boolean;
  /** S の中でこの item が終わる位置（区切りの位置）。 */
  readonly endPos: number;
  readonly finalChars: number;
  readonly deltaChars: number;
}

export class TranscriptAssembler {
  private readonly items: ItemState[] = [];
  private readonly byId = new Map<string, ItemState>();

  private ensure(id: string): ItemState {
    let item = this.byId.get(id);
    if (!item) {
      item = { id, deltas: "", final: null };
      this.items.push(item);
      this.byId.set(id, item);
    }
    return item;
  }

  /** delta を足す。確定済み item への遅着 delta は無視する。 */
  delta(itemId: string, delta: string): void {
    const item = this.ensure(itemId);
    if (item.final !== null) return;
    // item 先頭の空白は最終文字列で落ちるので、最初から入れない。
    item.deltas += item.deltas.length === 0 ? delta.trimStart() : delta;
  }

  /** commit 順を previous_item_id で補正する。 */
  committed(itemId: string, previousItemId: string | null): void {
    const item = this.ensure(itemId);
    if (previousItemId === null) return;
    const prevIndex = this.items.findIndex(entry => entry.id === previousItemId);
    const index = this.items.indexOf(item);
    if (prevIndex < 0 || index === prevIndex + 1) return;
    this.items.splice(index, 1);
    const insertAt = this.items.findIndex(entry => entry.id === previousItemId) + 1;
    this.items.splice(insertAt, 0, item);
  }

  completed(itemId: string, rawTranscript: string): CompletionResult {
    const item = this.ensure(itemId);
    const transcript = rawTranscript.trim();
    const deltaChars = item.deltas.length;
    const revised = item.final === null ? item.deltas.trimEnd() !== transcript : item.final !== transcript;
    item.final = transcript;
    return { revised, endPos: this.endOf(itemId), finalChars: transcript.length, deltaChars };
  }

  /** item が失敗した（文字なしで確定扱い）。 */
  failed(itemId: string): void {
    const item = this.ensure(itemId);
    if (item.final === null) item.final = item.deltas;
  }

  /** 先頭から、最初の未確定 item の delta までを連結した安定テキスト。 */
  get text(): string {
    let out = "";
    for (const item of this.items) {
      if (item.final !== null) {
        out += item.final;
        continue;
      }
      out += item.deltas;
      break;
    }
    return out;
  }

  /** item の終わりまでの S（その item が S に入っていなければ現在の S 全体）。 */
  textThrough(itemId: string): string {
    let out = "";
    for (const item of this.items) {
      if (item.final === null) return out + item.deltas;
      out += item.final;
      if (item.id === itemId) return out;
    }
    return out;
  }

  private endOf(itemId: string): number {
    return this.textThrough(itemId).length;
  }

  /** 先頭から順に、確定済みの item id（最初の未確定 item の手前まで）。 */
  finalItemsInOrder(): string[] {
    const out: string[] = [];
    for (const item of this.items) {
      if (item.final === null) break;
      out.push(item.id);
    }
    return out;
  }

  /** 未確定の item 数。 */
  get openItems(): number {
    return this.items.filter(item => item.final === null).length;
  }

  /** delta を受けたが未確定の item があるか。 */
  hasOpenText(): boolean {
    return this.items.some(item => item.final === null && item.deltas.length > 0);
  }
}
