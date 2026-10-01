// Flash probe (batch 3, lane B): WebKit iPhone, records a video, screenshot
// bursts and a per-frame DOM log (requestAnimationFrame) around each
// navigation tap, and every document / RSC (.txt) request.
// Usage: node probe.mjs <label> <port> [outDir]
// Needs: a served mobile export on <port>, the dev API on :3200, and a cached
// token at $SCRATCH/token.json (POST /api/auth/token once; login is rate-limited).
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(HERE, "../../../../app/package.json"));
const { webkit, devices } = require("playwright");

const label = process.argv[2] ?? "before";
const port = process.argv[3] ?? "3231";
const BASE = `http://127.0.0.1:${port}`;
const API = "http://127.0.0.1:3200";
const TOKEN_FILE = process.env.PROBE_TOKEN_FILE;
const OUT = process.argv[4] ?? path.join(HERE, "runs", label);
mkdirSync(OUT, { recursive: true });
const tok = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
const authValue = JSON.stringify({ token: tok.token, expiresAt: tok.expiresAt, issuedAt: new Date().toISOString(), userId: tok.user.userId });

const browser = await webkit.launch();
const context = await browser.newContext({
  ...devices["iPhone 13"],
  viewport: { width: 390, height: 844 },
  recordVideo: { dir: OUT, size: { width: 390, height: 844 } },
});
const page = await context.newPage();
const videoT0 = Date.now();
await page.addInitScript(({ value }) => {
  localStorage.setItem("lashkirja.emu.lashkirja.auth.v1", value);
  const docId = Math.random().toString(36).slice(2, 7);
  const log = (window.__frames = []);
  window.__docId = docId;
  const s = document.createElement("style");
  s.textContent = ":root{--safe-top:47px !important;--safe-bottom:34px !important}";
  const add = () => (document.head || document.documentElement).appendChild(s);
  if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
  const tick = (t) => {
    const main = document.querySelector("main.app-main");
    const snaps = [...document.querySelectorAll(".page-snapshot")];
    log.push({
      t: Math.round(t),
      doc: docId,
      path: location.pathname,
      main: main ? 1 : 0,
      mainLen: main ? main.innerText.length : -1,
      h1: main?.querySelector("h1")?.textContent?.slice(0, 24) ?? null,
      skel: main ? main.querySelectorAll(".skeleton, .animate-pulse, [aria-busy='true']").length : -1,
      snaps: snaps.length,
      snapLen: snaps.reduce((n, el) => n + el.innerText.length, 0),
      mainTf: main ? getComputedStyle(main).transform : null,
      mainOp: main ? getComputedStyle(main).opacity : null,
      vt: document.documentElement.dataset.navAnim ?? null,
    });
    if (log.length > 4000) log.splice(0, 1000);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__taps = [];
  document.addEventListener("pointerdown", () => window.__taps.push(Math.round(performance.now())), true);
}, { value: authValue });

// The dev API only allows the :3210 emulation origin; proxy and rewrite CORS.
const cors = { "access-control-allow-origin": BASE, "access-control-allow-credentials": "true", "access-control-expose-headers": "Retry-After, Content-Disposition, X-LashKirja-Api-Version", vary: "Origin" };
await page.route(`${API}/**`, async (route) => {
  const req = route.request();
  const m = req.method();
  if (m === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key, Accept" } });
  if (m !== "GET" && m !== "HEAD") return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: '{"ok":true}' });
  try {
    const res = await route.fetch({ headers: { ...req.headers(), origin: "http://127.0.0.1:3210" } });
    return route.fulfill({ status: res.status(), headers: { ...res.headers(), ...cors }, body: await res.body() });
  } catch { return route.abort(); }
});

const events = [];
const t0 = Date.now();
const isNavReq = (r) => r.resourceType() === "document" || /\.txt(\?|$)/.test(r.url());
page.on("request", (r) => { if (r.url().startsWith(BASE) && isNavReq(r)) events.push({ ms: Date.now() - t0, kind: r.resourceType(), url: r.url().replace(BASE, "") }); });
page.on("response", (r) => { if (r.url().startsWith(BASE) && isNavReq(r.request())) events.push({ ms: Date.now() - t0, kind: "resp " + r.status(), url: r.url().replace(BASE, "") }); });
page.on("framenavigated", (f) => { if (f === page.mainFrame()) events.push({ ms: Date.now() - t0, kind: "framenavigated", url: f.url().replace(BASE, "") }); });
page.on("console", (m) => { if (m.type() === "error") events.push({ ms: Date.now() - t0, kind: "console.error", url: m.text().slice(0, 160) }); });

async function settle() {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForFunction(() => !/Ladataan|Haetaan/i.test(document.body.innerText), null, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(900);
}

const summary = [];
async function step(name, act, waitUrl) {
  const dir = path.join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const start = await page.evaluate(() => performance.now());
  events.push({ ms: Date.now() - t0, kind: "STEP", url: name });
  const tapVideoMs = Date.now() - videoT0;
  await act();
  if (waitUrl) await page.waitForURL(waitUrl, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const frames = await page.evaluate((s) => (window.__frames || []).filter((f) => f.t >= s - 50), start).catch(() => []);
  const taps = await page.evaluate((s) => window.__taps.filter((t) => t >= s), start).catch(() => []);
  writeFileSync(path.join(dir, "frames.json"), "[\n" + frames.map((f) => JSON.stringify(f)).join(",\n") + "\n]\n");
  const docs = [...new Set(frames.map((f) => f.doc))];
  const visible = frames.filter((f) => f.main).map((f) => f.mainLen + f.snapLen);
  const firstNew = frames.find((f) => f.path !== frames[0]?.path);
  const moving = (f) => f.snaps > 0 || f.mainOp !== "1" || f.mainTf !== "none" || f.vt;
  const lastMoving = [...frames].reverse().find(moving);
  const line = {
    step: name,
    frames: frames.length,
    documents: docs.length,
    minVisibleText: visible.length ? Math.min(...visible) : -1,
    blankFrames: frames.filter((f) => !f.main || f.mainLen + f.snapLen < 40).length,
    skeletonFramesAfterTap: frames.filter((f) => f.skel > 0 && taps.length && f.t >= taps[0]).length,
    dimFrames: frames.filter((f) => f.mainOp !== null && Number(f.mainOp) < 0.9).length,
    tapToNewPathMs: taps.length && firstNew ? firstNew.t - taps[0] : null,
    tapToAnimationEndMs: taps.length && lastMoving ? lastMoving.t - taps[0] : null,
    tapVideoMs,
  };
  summary.push(line);
  console.log(JSON.stringify(line));
  await settle();
}

await page.goto(`${BASE}/dashboard`);
await settle();

// Pass "cold": first visit of each screen in this session (no page cache).
// Pass "warm": the same walk again, every screen cached (the owner's daily use).
for (const pass of ["cold", "warm"]) {
  await step(`${pass}-1-koti-to-kirjanpito-tab`, () => page.locator('.app-tab-bar a[href="/kirjanpito"]').tap(), "**/kirjanpito");
  await step(`${pass}-2-kirjanpito-to-alv-push`, () => page.locator('main a[href^="/kirjanpito/alv"]').first().tap(), "**/kirjanpito/alv**");
  await step(`${pass}-3-alv-back-pop`, () => page.locator('.app-header button[aria-label^="Takaisin"]').tap(), /\/kirjanpito$/);
  await step(`${pass}-4-kirjanpito-to-myynti-tab`, () => page.locator('.app-tab-bar a[href="/laskut"]').tap(), "**/laskut");
  await step(`${pass}-5-myynti-to-koti-tab`, () => page.locator('.app-tab-bar a[href="/dashboard"]').tap(), "**/dashboard");
}

writeFileSync(path.join(OUT, "events.json"), JSON.stringify(events, null, 1));
writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
const video = page.video();
await context.close();
await browser.close();
// Frame strips from the video (25 fps, every frame): 100 ms before the tap to
// 1.34 s after (the WebKit recorder lags the page clock by a few hundred ms).
const { execFileSync } = await import("node:child_process");
const videoPath = await video.path();
for (const line of summary) {
  const at = Math.max(0, (line.tapVideoMs - 100) / 1000).toFixed(3);
  const strip = path.join(OUT, `${line.step}-strip.png`);
  try {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", at, "-i", videoPath, "-t", "1.44", "-vf", "scale=120:-1,tile=12x3:padding=4:color=white", "-frames:v", "1", strip]);
  } catch (error) {
    console.log("strip failed", line.step, String(error).slice(0, 200));
  }
}
console.log("video", videoPath);
