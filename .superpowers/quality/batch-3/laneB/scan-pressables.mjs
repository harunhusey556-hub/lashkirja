// Lists pressables (button / Link / a / onClick elements) whose static className has no
// background and no shared press class. Usage: node scan-pressables.mjs <src dir>
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
const root = process.argv[2];
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".tsx") && !name.includes(".test.")) files.push(full);
  }
})(root);
const tagRe = /<(button|Link|a|div|span|li|label)\b((?:[^>"'`{}]|"[^"]*"|'[^']*'|`[^`]*`|\{(?:[^{}]|\{[^{}]*\})*\})*?)>/gs;
let total = 0;
const rows = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(tagRe)) {
    const [, tag, attrs] = m;
    const pressable = tag === "button" || tag === "Link" || tag === "a" || /\bonClick=/.test(attrs);
    if (!pressable) continue;
    total++;
    const cls = (attrs.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/s) ?? []).slice(1).find(Boolean) ?? "";
    if (/buttonClass|tintedButtonClass|chipClass|BARE_LINK_CLASS|QUIET_LINK|PILL|press-row|row-link|tab-plus|header-circle|sr-only|hidden/.test(cls)) continue;
    const hasBg = /\bbg-(?!transparent)/.test(cls);
    const bordered = /\bborder\b/.test(cls);
    const role = /role="button"/.test(attrs) ? " role=button" : "";
    const divClick = tag !== "button" && tag !== "Link" && tag !== "a" ? " NON-BUTTON-onClick" : "";
    if (!hasBg && !bordered) {
      const line = text.slice(0, m.index).split("\n").length;
      rows.push(`${path.relative(root, file)}:${line} <${tag}${role}${divClick}> ${cls.replace(/\s+/g, " ").slice(0, 110)}`);
    }
  }
}
console.log(`pressables scanned: ${total}; without background/border/shared press class: ${rows.length}`);
for (const row of rows) console.log(row);
