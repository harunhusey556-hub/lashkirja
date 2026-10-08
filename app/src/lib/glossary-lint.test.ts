import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import { RETIRED_TERMS } from "./glossary";
import { LEGACY_LIMITED_NOTICE_FI, PREVIOUS_LIMITED_NOTICE_FI } from "./chat-legacy";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated") continue;
      walk(full, out);
    } else if (entry.name !== "glossary.ts" && /\.(ts|tsx)$/.test(entry.name) &&!/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** String literals and JSX text only: comments and identifiers are not UI. */
export function uiStrings(file: string): { text: string; line: number }[] {
  const source = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { text: string; line: number }[] = [];
  const add = (node: ts.Node, text: string) => {
    if (!text.trim()) return;
    found.push({ text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    // Server logs are not UI.
    if (ts.isCallExpression(node) && /^console./.test(node.expression.getText(sf))) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
    else if (ts.isJsxText(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// A literal that is a database value, an API key or a route is data, not a label.
// Intentional uses (a code that must still match a stored retired value) go here
// as "relative/path.ts:text".
const ALLOWED: string[] = [
  // Internal tab id of the Koti tab (persisted and matched in tests); the label is "Koti".
  "lib/navigation.ts:etusivu",
  // A word searched for in the subject of incoming mail, not a label.
  "lib/mail-sync.ts:tosite",
  // The two notice texts an applied SQL migration wrote into stored rows; only these exact
  // strings are exempt, so a new string in the file is still linted.
  `lib/chat-legacy.ts:${LEGACY_LIMITED_NOTICE_FI}`,
  `lib/chat-legacy.ts:${PREVIOUS_LIMITED_NOTICE_FI}`,
  // Byte-identical copies of the notice text an applied SQL migration wrote; shown through a sanitiser.
  // The double-entry books use the statutory terms an accountant reads (tosite, myyntisaamiset,
  // ostovelat): the plain-language words of the rest of the app would misname the accounts.
  "lib/ledger/chart.ts:*",
  "lib/ledger/posting.ts:*",
  "app/api/ledger/export/route.ts:*",
  "app/kirjanpito/paakirja/page.tsx:*",
];

describe("glossary lint", () => {
  it("no retired word appears in a UI string", () => {
    const hits: string[] = [];
    for (const file of walk(SRC, [])) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      for (const { text, line } of uiStrings(file)) {
        for (const term of RETIRED_TERMS) {
          if (term.pattern.test(text) && !ALLOWED.includes(`${rel}:${text}`) && !ALLOWED.includes(`${rel}:*`)) {
            hits.push(`${rel}:${line} "${text.trim().slice(0, 70)}" -> ${term.use}`);
          }
        }
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
});

describe("the retired-word patterns", () => {
  const flagged = (text: string) => RETIRED_TERMS.some((term) => term.pattern.test(text));

  it("catch the retired words, in any case and inflection", () => {
    for (const text of [
      "Puuttuva tosite", "Linkitä kuitti", "Kuitti linkitetty.", "Täsmäytys hyväksytty", "Palaa etusivulle",
      "602,40 € erääntynyt", "Myyntisaamiset", "Ostovelat", "Tilitapahtumat", "Taustatyöt", "Poikkeusjono",
      "Ota kuva", "Kirjaudu ulos", "Kopioi virheviite", "Muu IMAP", "Maksuaika 14 pv",
      "Hyväksy kaikki 3 kpl", "Lähetetty", "Avoimet", "Täsmää",
      "Ei puuttuvia tositteita.", "Poista linkitys", "Linkitys epäonnistui", "Tilitapahtuma", "tilitapahtumaan",
      "Tilitapahtumasta", "Kirjaudutaan ulos…", "Kirjaudu ulos", "Kirjaudutko ulos", "Kirjaudutaanko ulos", "Kirjaudut ulos",
    ]) {
      expect(flagged(text), text).toBe(true);
    }
  });

  it("leave plain Finnish alone", () => {
    for (const text of [
      "Salasanat eivät täsmää.", "Koodi ei täsmää.", "Kuitti kohdistettu.", "Odottaa maksua", "Kirjaa ulos",
      "Kuvaa kuitti", "Lisää kuitti", "Kuitti puuttuu", "Koti", "Pankkitapahtumat", "Huomioitavat", "Lasku on lähetetty asiakkaalle.",
      "IMAP_CONNECTION_FAILED", "Maksuaika 14 päivää",
    ]) {
      expect(flagged(text), text).toBe(false);
    }
  });
});
