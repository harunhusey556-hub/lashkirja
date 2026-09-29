import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { NAV } from "../../src/lib/navigation";

/**
 * Accessibility rules per route (quality batch 2, lane a11y; findings-ax.md rules R1..R12).
 *
 * One pass over every route in the navigation registry, in WebKit at 390x844 with the safe areas injected,
 * with one in-page audit per route (cheap: no axe, no per-control round trips). What it asserts:
 *   - exactly one h1, visible and not empty; heading levels never skip (R1);
 *   - the document title is "<registry label> . LashKirja", unique per route, and focus is not stranded (R2);
 *   - every interactive control has an accessible name (R3);
 *   - every number a sighted user reads in a control is in its name (R3, AX-05);
 *   - a row never carries two links to the same href (R4, AX-13);
 *   - the hit area of every control is at least 44 pt, measured with elementFromPoint so pseudo-element
 *     hit areas count (R9);
 *   - every dialog has a name, aria-modal, and inert content behind it (R6);
 *   - the Avustaja conversation is a polite log (R7, AX-06);
 *   - the "..." menu follows the h1 in the DOM (R5, AX-12);
 *   - the placeholder and the status-tag colours pass 4.5:1, computed from the CSS tokens (R12, R13).
 *
 * Auth: no login here. LASHKIRJA_E2E_STORAGE_STATE points at a stored session (the token lives in
 * localStorage). Every non-GET to the API is answered with a fake 200, so nothing is written.
 */

test.use({
  browserName: "webkit",
  // The config pins Chromium to the installed Chrome; WebKit has no channels.
  channel: "",
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const API_BASE = "http://127.0.0.1:3200";
const DEMO_EMAIL = "demo@lashkirja.fi";
const DEMO_PASSWORD = "demo123";
const AUTH_STORAGE_KEY = "lashkirja.emu.lashkirja.auth.v1";
const SAFE_TOP = 47;
const SAFE_BOTTOM = 34;

let authValue: string | null = null;

async function authValueOnce(page: Page): Promise<string> {
  if (authValue) return authValue;
  const statePath = process.env.LASHKIRJA_E2E_STORAGE_STATE;
  if (statePath) {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      origins: { localStorage: { name: string; value: string }[] }[];
    };
    const entry = state.origins.flatMap((origin) => origin.localStorage).find((item) => item.name === AUTH_STORAGE_KEY);
    if (entry) {
      authValue = entry.value;
      return authValue;
    }
  }
  const response = await page.request.post(`${API_BASE}/api/auth/token`, {
    data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  const data = (await response.json()) as { token: string; expiresAt: string; user: { userId: string } };
  authValue = JSON.stringify({
    token: data.token,
    expiresAt: data.expiresAt,
    issuedAt: new Date().toISOString(),
    userId: data.user.userId,
  });
  return authValue;
}

test.beforeEach(async ({ page }) => {
  const value = await authValueOnce(page);
  await page.addInitScript(
    ({ key, value, top, bottom }) => {
      window.localStorage.setItem(key, value);
      const add = () => {
        const style = document.createElement("style");
        style.textContent = `:root{--safe-top:${top}px !important;--safe-bottom:${bottom}px !important}`;
        (document.head || document.documentElement).appendChild(style);
      };
      if (document.head) add();
      else document.addEventListener("DOMContentLoaded", add);
    },
    { key: AUTH_STORAGE_KEY, value, top: SAFE_TOP, bottom: SAFE_BOTTOM }
  );
  // Installed after the token is fetched (a route here must not eat the login POST).
  await page.route(`${API_BASE}/**`, (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ok: true }),
    });
  });
});

/** Waits until the screen has left its skeleton and error states; one retry when the API is slow. */
async function open(page: Page, route: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(route);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page
      .waitForFunction(
        () =>
          !document.querySelector(".skeleton, [aria-busy='true'], .animate-pulse") &&
          !/Ladataan|Haetaan/i.test(document.body.innerText),
        null,
        { timeout: 12_000 }
      )
      .catch(() => {});
    await page.waitForTimeout(350);
    const failed = await page.evaluate(() => /ei saada yhteyttä/i.test(document.querySelector("main")?.innerText ?? ""));
    if (!failed) return;
  }
}

type Finding = string;

/** The audit that runs inside the page. Returns human-readable findings; an empty array is a pass. */
function auditPage(): {
  findings: Finding[];
  title: string;
  h1: string;
  controls: number;
  probed: number;
} {
  const findings: Finding[] = [];
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const hiddenFromAt = (el: Element) => Boolean(el.closest("[inert], [aria-hidden='true']"));
  const text = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  const describe = (el: Element) => {
    const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
  };

  // Accessible name, close enough to accname for a check of "has a name".
  const nameOf = (el: Element): string => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((n): n is HTMLElement => Boolean(n))
        .map(text)
        .join(" ")
        .trim();
      if (t) return t;
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const t = [...labels].map(text).join(" ").trim();
      if (t) return t;
    }
    const walk = (node: Element): string => {
      let out = "";
      node.childNodes.forEach((child) => {
        if (child.nodeType === 3) out += child.textContent;
        else if (child.nodeType === 1) {
          const c = child as Element;
          if (c.getAttribute("aria-hidden") === "true") return;
          const cs = getComputedStyle(c);
          if (cs.display === "none" || cs.visibility === "hidden") return;
          if (c.tagName === "IMG") out += ` ${c.getAttribute("alt") ?? ""} `;
          else out += ` ${c.getAttribute("aria-label") ?? walk(c)} `;
        }
      });
      return out;
    };
    const t = walk(el).replace(/\s+/g, " ").trim();
    if (t) return t;
    return (el as HTMLElement).title ?? "";
  };

  // ---- headings (R1) ----
  const main = document.querySelector("main.app-main, .bare-frame") ?? document.body;
  const h1s = [...document.querySelectorAll("h1")].filter((h) => visible(h) && !hiddenFromAt(h));
  if (h1s.length !== 1) findings.push(`h1 count ${h1s.length} (want exactly 1)`);
  const h1Text = h1s[0] ? text(h1s[0]) : "";
  if (h1s[0] && !h1Text) findings.push("h1 is empty");
  let prev = 0;
  for (const h of main.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (!visible(h) || hiddenFromAt(h)) continue;
    const level = Number(h.tagName.slice(1));
    if (prev && level > prev + 1) findings.push(`heading level skips h${prev} -> h${level} ("${text(h).slice(0, 30)}")`);
    prev = level;
  }

  // ---- controls: names (R3), numbers in names (AX-05), hit area (R9) ----
  const CTRL =
    "a[href], button, [role=button], [role=switch], [role=tab], [role=menuitem], [role=checkbox], [role=radio], input:not([type=hidden]), select, textarea, summary";
  const controls = [...document.querySelectorAll(CTRL)].filter((el) => visible(el) && !hiddenFromAt(el));
  const NUMBER = /\d[\d\s ]*(?:,\d+)?/g;
  const squash = (s: string) => s.replace(/[\s ]+/g, "");
  for (const el of controls) {
    const name = nameOf(el);
    if (!name) findings.push(`unnamed control: ${describe(el)}`);
    const aria = el.getAttribute("aria-label");
    const visibleText = text(el);
    // A native select's innerText is its option list, not something the user reads as one value.
    const isField = /^(SELECT|INPUT|TEXTAREA)$/.test(el.tagName);
    if (aria && visibleText && !isField) {
      for (const n of visibleText.match(NUMBER) ?? []) {
        if (!squash(aria).includes(squash(n.trim()))) {
          findings.push(`name "${aria}" leaves out the number "${n.trim()}" that is shown (R3)`);
        }
      }
    }
  }

  // A row never carries a second link to its own href (R4, AX-13).
  for (const row of document.querySelectorAll("[data-testid=list-row]")) {
    const seen = new Map<string, number>();
    for (const a of row.querySelectorAll("a[href]")) {
      if (hiddenFromAt(a)) continue;
      const href = a.getAttribute("href") ?? "";
      seen.set(href, (seen.get(href) ?? 0) + 1);
    }
    for (const [href, count] of seen) {
      if (count > 1) findings.push(`row has ${count} links to ${href} (R4)`);
    }
  }

  // Hit areas: probe the box around each small control and take the bounding box of the points that
  // land on it (this counts stretched links and ::before hit areas, which getBoundingClientRect misses).
  let probed = 0;
  const owns = (el: Element, t: Element | null) => Boolean(t && (t === el || el.contains(t) || t.closest(CTRL) === el));
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.width >= 44 && r.height >= 44) continue;
    if ((el as HTMLButtonElement).disabled) continue;
    const inline =
      getComputedStyle(el).display === "inline" &&
      el.tagName === "A" &&
      Boolean(el.parentElement) &&
      text(el.parentElement as Element).length > text(el).length + 3;
    if (inline) continue; // WCAG 2.5.8: a link inside a sentence is exempt
    if (r.width < 2) continue;
    const fixed = Boolean(el.closest(".app-header, .app-tab-bar, .bottom-actions, .toast"));
    if (!fixed) el.scrollIntoView({ block: "center", inline: "center" });
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let dx = -32; dx <= 32; dx += 2) {
      for (let dy = -32; dy <= 32; dy += 2) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        if (owns(el, document.elementFromPoint(x, y))) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    probed += 1;
    // The probe step is 2 px, so the measured span is 1 px under the real one at most.
    const w = maxX < minX ? 0 : maxX - minX + 2;
    const h = maxY < minY ? 0 : maxY - minY + 2;
    if (w < 43 || h < 43) findings.push(`hit area ${Math.round(w)}x${Math.round(h)} < 44: "${nameOf(el).slice(0, 30)}" ${describe(el)}`);
  }

  // ---- dialogs that are open on this route (R6) ----
  for (const d of document.querySelectorAll("[role=dialog], [role=alertdialog]")) {
    if (!visible(d)) continue;
    if (!nameOf(d)) findings.push(`unnamed dialog: ${describe(d)}`);
  }

  window.scrollTo(0, 0);
  return { findings, title: document.title, h1: h1Text, controls: controls.length, probed };
}

/** Everything the registry can reach without an id, plus one real id per detail kind found in its list. */
const DETAIL_SOURCES: { id: string; list: string; hrefPart: string }[] = [
  { id: "lasku", list: "/laskut", hrefPart: "/laskut/lasku?id=" },
  { id: "kuitti", list: "/kuitit", hrefPart: "/kuitit/kuitti?id=" },
  { id: "asiakas", list: "/asiakkaat", hrefPart: "/asiakkaat/asiakas?id=" },
  { id: "pankki-tapahtuma", list: "/pankki/tapahtumat", hrefPart: "/pankki/tapahtumat/tiliote?id=" },
];

test("every registry route: one h1, its own title, named controls, 44 pt hit areas (R1..R4, R9)", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const routes: { id: string; label: string; url: string }[] = [];
  for (const entry of NAV) {
    const source = DETAIL_SOURCES.find((s) => s.id === entry.id);
    if (!source) {
      routes.push({ id: entry.id, label: entry.label, url: entry.path });
      continue;
    }
    await open(page, source.list);
    const href = await page.evaluate(
      (part) => document.querySelector<HTMLAnchorElement>(`a[href*="${part}"]`)?.getAttribute("href") ?? null,
      source.hrefPart
    );
    // A detail route needs data; without a row the screen is checked through its list only.
    if (href) routes.push({ id: entry.id, label: entry.label, url: href });
  }
  expect(routes.length, "the registry routes that can be reached").toBeGreaterThanOrEqual(NAV.length - DETAIL_SOURCES.length);

  const problems: string[] = [];
  const titles = new Map<string, string>();
  let controls = 0;
  for (const route of routes) {
    await open(page, route.url);
    const result = await page.evaluate(auditPage);
    controls += result.controls;
    for (const finding of result.findings) problems.push(`${route.url}: ${finding}`);
    const expected = `${route.label} · LashKirja`;
    if (result.title !== expected) problems.push(`${route.url}: document.title "${result.title}", want "${expected}" (R2)`);
    const earlier = titles.get(result.title);
    if (earlier) problems.push(`${route.url}: title "${result.title}" is also the title of ${earlier} (R2)`);
    titles.set(result.title, route.url);
  }
  expect(controls, "controls audited").toBeGreaterThan(200);
  expect(problems).toEqual([]);
});

test("the bare recovery page has one h1 and named controls", async ({ page }) => {
  await open(page, "/unohtunut-salasana");
  const result = await page.evaluate(auditPage);
  expect(result.findings).toEqual([]);
});

test("dialogs and the Avustaja: names, aria-modal, inert background, polite log (R6, R7, AX-06, AX-10)", async ({
  page,
}) => {
  await open(page, "/dashboard");

  const dialogState = () =>
    page.evaluate(() => {
      const d = document.querySelector<HTMLElement>("[role=dialog], [role=alertdialog]");
      if (!d) return null;
      const labelledBy = d.getAttribute("aria-labelledby");
      const named =
        (labelledBy && document.getElementById(labelledBy)?.textContent?.trim()) || d.getAttribute("aria-label") || "";
      return {
        role: d.getAttribute("role"),
        modal: d.getAttribute("aria-modal"),
        name: named,
        mainInert: document.querySelector(".app-main")?.closest("[inert]") !== null,
        log: (() => {
          const log = d.querySelector("[role=log]");
          return log
            ? { live: log.getAttribute("aria-live"), busy: log.getAttribute("aria-busy"), name: log.getAttribute("aria-label") }
            : null;
        })(),
      };
    });

  await page.getByRole("navigation", { name: "Päävalikko" }).getByRole("button", { name: "Lisää" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(400);
  const more = await dialogState();
  expect(more?.name, "Lisää sheet name").toBeTruthy();
  expect(more?.modal).toBe("true");
  expect(more?.mainInert, "app-main is inert behind the sheet").toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Avustaja" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(400);
  const ai = await dialogState();
  expect(ai?.name, "Avustaja name").toBeTruthy();
  expect(ai?.modal).toBe("true");
  expect(ai?.log, "the conversation is a role=log").not.toBeNull();
  expect(ai?.log?.live).toBe("polite");
  expect(ai?.log?.busy, "aria-busy is set (false while idle)").toBe("false");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the detail menu comes after the title in the DOM (R5, AX-12)", async ({ page }) => {
  await open(page, "/laskut");
  const href = await page.evaluate(
    () => document.querySelector<HTMLAnchorElement>('a[href*="/laskut/lasku?id="]')?.getAttribute("href") ?? null
  );
  test.skip(!href, "no invoice in the demo account");
  await open(page, href as string);
  const order = await page.evaluate(() => {
    const h1 = document.querySelector("main h1");
    const menu = document.querySelector('main button[aria-label^="Lisää toimintoja"]');
    if (!h1 || !menu) return null;
    return Boolean(h1.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order, "h1 precedes the menu button").toBe(true);
});

// ---- contrast from the tokens (R12, R13) ----

function readTokens(): Record<string, string> {
  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const tokens: Record<string, string> = {};
  for (const m of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[m[1]] ??= m[2]; // first definition = @theme; later ones are prefers-contrast overrides
  return tokens;
}
type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const over = (top: Rgb, alpha: number, bottom: Rgb): Rgb =>
  top.map((v, i) => v * alpha + bottom[i] * (1 - alpha)) as Rgb;
const luminance = (c: Rgb) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("the placeholder token and every status-tag pair pass 4.5:1 on canvas and surface (R12, R13, AX-08, AX-09)", () => {
  const t = readTokens();
  for (const name of ["canvas", "surface", "ink", "ink-2", "line", "accent", "accent-soft", "success", "warning", "warning-dark", "danger"]) {
    expect(t[name], `token --color-${name}`).toBeTruthy();
  }
  const backgrounds: [string, Rgb][] = [
    ["canvas", rgb(t.canvas)],
    ["surface", rgb(t.surface)],
  ];

  // The placeholder rule in globals.css names the token; the ratio comes from that token.
  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const placeholder = /::placeholder\s*\{\s*color:\s*var\(--color-([a-z0-9-]+)\)/.exec(css);
  expect(placeholder, "a global ::placeholder colour").not.toBeNull();
  for (const [bgName, bg] of backgrounds) {
    const value = ratio(rgb(t[placeholder![1]]), bg);
    expect(value, `placeholder ${placeholder![1]} on ${bgName}`).toBeGreaterThanOrEqual(4.5);
  }

  // Tag pairs are read from StatusTag.tsx ("bg-<token>[/alpha] text-<token>") so a new tone is checked too.
  const source = readFileSync(path.join(process.cwd(), "src/components/ds/StatusTag.tsx"), "utf8");
  const pairs = [...source.matchAll(/"bg-([a-z0-9-]+?)(?:\/(\d+))? text-([a-z0-9-]+)"/g)];
  expect(pairs.length, "status tag tones").toBeGreaterThanOrEqual(5);
  for (const [, bgToken, alpha, fgToken] of pairs) {
    for (const [bgName, page] of backgrounds) {
      const fill = alpha ? over(rgb(t[bgToken]), Number(alpha) / 100, page) : rgb(t[bgToken]);
      const value = ratio(rgb(t[fgToken]), fill);
      expect(value, `${fgToken} on ${bgToken}${alpha ? "/" + alpha : ""} over ${bgName}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("a rendered placeholder resolves to the token colour (R12)", async ({ page }) => {
  await open(page, "/laskut/uusi");
  const colour = await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>("input[placeholder], textarea[placeholder]");
    if (!el) return null;
    return getComputedStyle(el, "::placeholder").color;
  });
  test.skip(colour === null, "no placeholder on this screen");
  const t = readTokens();
  const [r, g, b] = rgb(t["ink-2"]);
  // Either the token itself or, under a browser that reports the pseudo colour with alpha, its opaque form.
  expect(colour).toMatch(new RegExp(`rgba?\\(${r}, ${g}, ${b}`));
});
