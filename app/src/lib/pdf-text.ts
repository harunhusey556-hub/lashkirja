/**
 * Text and money that are safe to hand to pdfkit.
 *
 * pdfkit's built-in fonts are WinAnsi and its encoder does no range check: a
 * code point it cannot map is written as raw hex digits, which shifts every
 * following byte of the string and prints garbage over the next column. A
 * control character does the same. So every string that reaches a PDF goes
 * through `sanitizePdfText` first, whichever font draws it.
 */
import { centsToEuros } from "./money";
import { formatEur } from "./format";

const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

/** The characters the built-in Helvetica (WinAnsi) can draw. */
export function winAnsiCanDraw(codePoint: number): boolean {
  return (
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa0 && codePoint <= 0xff) ||
    WIN_ANSI_EXTRAS.has(codePoint)
  );
}

/** Letters NFKD leaves whole although a plain Latin letter stands in well. */
const LOOKALIKES: Record<string, string> = {
  "\u0141": "L", // Ł
  "\u0142": "l", // ł
  "\u0110": "D", // Đ
  "\u0111": "d", // đ
  "\u0131": "i", // dotless i
};

/** Zero-width, bidi and variation marks: invisible, so they vanish instead of becoming "?". */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/gu;
/** C0 (minus \t, \n, \r, handled on their own), DEL and C1 controls. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

function plainFormOf(char: string, canDraw: (codePoint: number) => boolean): string | null {
  const direct = LOOKALIKES[char];
  if (direct) return direct;
  const decomposed = char.normalize("NFKD").replace(/\p{M}/gu, "");
  if (decomposed === "" || decomposed === char) return null;
  for (const part of decomposed) {
    if (!canDraw(part.codePointAt(0)!)) return null;
  }
  return decomposed;
}

/**
 * - control and invisible characters are removed (a tab becomes a space,
 *   every kind of line break becomes \n);
 * - a character the font cannot draw becomes its closest plain form (NFKD,
 *   plus a few lookalikes), or "?" - once per run, so an emoji or a word in
 *   another script reads as one "?" instead of a row of them.
 */
export function sanitizePdfText(
  value: string | null | undefined,
  canDraw: (codePoint: number) => boolean
): string {
  if (!value) return "";
  const cleaned = value
    .normalize("NFC")
    .replace(/\r\n|\r|\u2028|\u2029/g, "\n")
    .replace(/\t/g, " ")
    .replace(CONTROL, "")
    .replace(INVISIBLE, "");

  let out = "";
  let inUnknownRun = false;
  for (const char of cleaned) {
    if (char === "\n" || canDraw(char.codePointAt(0)!)) {
      out += char;
      inUnknownRun = false;
      continue;
    }
    const plain = plainFormOf(char, canDraw);
    if (plain) {
      out += plain;
      inUnknownRun = false;
    } else if (!inUnknownRun) {
      out += "?";
      inUnknownRun = true;
    }
  }
  return out;
}

/**
 * Money as it is printed on a PDF: the same Finnish format as the screens,
 * but a plain hyphen-minus for negatives (U+2212 has no glyph in the built-in
 * font and prints as a quotation mark), one kind of no-break space, and never
 * a negative zero.
 */
export function pdfMoney(cents: number): string {
  return formatEur(centsToEuros(cents === 0 ? 0 : cents))
    .replace(/\u2212/g, "-")
    .replace(/\u202f/g, "\u00a0");
}
