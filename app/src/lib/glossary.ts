/**
 * The retired Finnish words (findings-vs section 2.10). The glossary lint test
 * (glossary-lint.test.ts) fails when one of them shows up in a UI string.
 * Each entry: a pattern and the word to use instead.
 */
export interface RetiredTerm {
  pattern: RegExp;
  use: string;
}

// \b does not know ä/ö, so word starts are spelled with a lookbehind.
const S = String.raw`(?<![\p{L}])`;
const re = (source: string, flags = "iu") => new RegExp(source, flags);

export const RETIRED_TERMS: RetiredTerm[] = [
  { pattern: re(`${S}tositt?e`), use: "kuitti" },
  { pattern: re(`${S}linkit[aä]`), use: "kohdista" },
  { pattern: re(`linkit(?:t|et|y)`), use: "kohdistettu" },
  // "ei täsmää" (a password or a total that differs) is plain Finnish; the retired
  // senses are the receipt-matching verb and noun.
  { pattern: re(`${S}täsmäy`), use: "kohdista" },
  { pattern: re(`${S}täsmät`), use: "kohdistettu" },
  { pattern: re(String.raw`^täsmää(?:[ ,]|$)`), use: "kohdista" },
  { pattern: re(`${S}etusiv`), use: "Koti" },
  { pattern: re(`${S}erääntyn`), use: "myöhässä" },
  { pattern: re(`${S}erääntyi`), use: "myöhässä" },
  { pattern: re(`${S}myyntisaamiset`), use: "Avoimet myyntilaskut" },
  { pattern: re(`${S}ostovelat`), use: "Avoimet ostolaskut" },
  { pattern: re(`${S}tilitapahtum`), use: "Pankkitapahtumat" },
  { pattern: re(`${S}taustatyö`), use: "Huomioitavat" },
  { pattern: re(`${S}poikkeusjono`), use: "Huomioitavat" },
  { pattern: re(`${S}lisää kuitti`), use: "Uusi kuitti" },
  { pattern: re(`${S}ota kuva`), use: "Kuvaa kuitti" },
  { pattern: re(`${S}kirjaudu(?:taanko|taan|tko|t)? ulos`), use: "Kirjaa ulos" },
  { pattern: re(`${S}virheviite`), use: "tukikoodi" },
  { pattern: re(`${S}tekoälyapuri`), use: "Avustaja" },
  { pattern: re(`${S}tekoälyavustaja`), use: "Avustaja" },
  { pattern: re(`${S}ei linkitystä`), use: "Ei kohdistettu" },
  { pattern: re(String.raw`${S}IMAP(?![\p{L}_])`, "u"), use: "sähköpostipalvelin" },
  { pattern: re(String.raw`\d\s?(?:pv|kpl)(?![\p{L}])`, "u"), use: "päivää / kappaletta" },
  // Money labels: Tulot / Menot, not Myynnit / Ostot.
  { pattern: re(String.raw`^(?:Ostot|Myynnit)$`, "u"), use: "Menot / Tulot" },
  // A status word: only the bare label or an arrow transition, not a sentence.
  { pattern: re(String.raw`^(?:Avoimet|Lähetetty)$`, "u"), use: "Odottaa maksua" },
  { pattern: re(String.raw`(?:→|:) Lähetetty|Lähetetty →`, "u"), use: "Odottaa maksua" },
];
