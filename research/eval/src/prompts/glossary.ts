/**
 * 合成・公開情報だけの用語集。人名・実住所・実会話本文を入れない。
 * 拠点（鎌倉）向けに host が用意する想定の地名・不動産語の例。
 */
export interface GlossaryEntry { readonly ja: string; readonly en: string; readonly kind: "place" | "term" }

export const GLOSSARY: ReadonlyArray<GlossaryEntry> = [
  { ja: "鎌倉", en: "Kamakura", kind: "place" },
  { ja: "湘南", en: "Shonan", kind: "place" },
  { ja: "逗子", en: "Zushi", kind: "place" },
  { ja: "葉山", en: "Hayama", kind: "place" },
  { ja: "由比ヶ浜", en: "Yuigahama", kind: "place" },
  { ja: "材木座", en: "Zaimokuza", kind: "place" },
  { ja: "七里ヶ浜", en: "Shichirigahama", kind: "place" },
  { ja: "江ノ島", en: "Enoshima", kind: "place" },
  { ja: "藤沢", en: "Fujisawa", kind: "place" },
  { ja: "横須賀", en: "Yokosuka", kind: "place" },
  { ja: "横浜", en: "Yokohama", kind: "place" },
  { ja: "川崎", en: "Kawasaki", kind: "place" },
  { ja: "湘南モノレール", en: "Shonan Monorail", kind: "place" },
  { ja: "不動産", en: "real estate", kind: "term" },
  { ja: "物件", en: "property", kind: "term" },
  { ja: "内見", en: "property viewing", kind: "term" },
  { ja: "契約", en: "contract", kind: "term" },
  { ja: "手付金", en: "deposit (earnest money)", kind: "term" },
  { ja: "管理会社", en: "property management company", kind: "term" },
  { ja: "建ぺい率", en: "building coverage ratio", kind: "term" },
  { ja: "借地権", en: "leasehold", kind: "term" },
  { ja: "所有権", en: "freehold ownership", kind: "term" },
  { ja: "賃貸", en: "rental", kind: "term" },
  { ja: "住宅ローン", en: "mortgage", kind: "term" },
  { ja: "学生ビザ", en: "student visa", kind: "term" },
  { ja: "観光ビザ", en: "tourist visa", kind: "term" },
  { ja: "ワーキングホリデー", en: "working holiday", kind: "term" },
  { ja: "土砂災害警戒区域", en: "landslide hazard zone", kind: "term" },
];

export function glossaryLines(): string {
  return GLOSSARY.map(entry => `${entry.ja} → ${entry.en}`).join("\n");
}

/** ASR の keywords 用（原語側）。 */
export function glossarySourceTerms(): string[] {
  return GLOSSARY.map(entry => entry.ja);
}
