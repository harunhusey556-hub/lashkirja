/**
 * The runner side of the CI simulator autopilot (src/lib/ci-autopilot/run.ts),
 * used only by .github/workflows/ios-sim-check.yml on the macOS runner. The
 * app inside the iOS Simulator reaches it on 127.0.0.1 (the simulator shares
 * the runner's loopback).
 *
 *   POST /config  -> { phase, routes, email, password, settleMs }
 *   POST /step    -> takes `xcrun simctl io <udid> screenshot`, THEN answers,
 *                    so the app waits until its screen is on disk
 *   POST /log     -> appends to webview-console.log
 *   POST /done    -> writes done-<phase> (+ problems) for the runner script
 *
 * Every body is text/plain JSON (a CORS "simple" request, no preflight).
 * Node built-ins only.
 *
 * Usage: tsx scripts/ci/sim-step-server.ts --udid <udid> --out <dir>
 *        [--port 3999] [--routes "/dashboard,/laskut"] [--settle-ms 1200]
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index === -1 || index === args.length - 1 ? fallback : args[index + 1];
}

const PORT = Number(argValue("--port", "3999"));
const UDID = argValue("--udid", "booted");
const OUT = path.resolve(argValue("--out", "sim-artifacts"));
const ROUTES = argValue("--routes", "/dashboard")
  .split(",")
  .map((route) => route.trim())
  .filter((route) => route.startsWith("/"));
const SETTLE_MS = Number(argValue("--settle-ms", "1200"));

const SHOTS = path.join(OUT, "screenshots");
mkdirSync(SHOTS, { recursive: true });

let launches = 0;
const startedAt = Date.now();

function stamp(): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 60);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({ raw: text });
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function screenshot(file: string): Promise<string | null> {
  try {
    await run("xcrun", ["simctl", "io", UDID, "screenshot", "--type=png", file], { timeout: 30_000 });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const body = (await readBody(req)) as Record<string, unknown>;

  switch (url.pathname) {
    case "/config": {
      launches += 1;
      const phase = launches === 1 ? "first" : "relaunch";
      console.log(`[${stamp()}] config -> phase ${phase} (${String(body.userAgent ?? "")})`);
      appendFileSync(path.join(OUT, "launches.jsonl"), `${JSON.stringify({ at: stamp(), phase, ...body })}\n`);
      return send(res, 200, {
        phase,
        routes: ROUTES,
        // The throwaway demo account from scripts/demo-seed.ts, on the
        // runner's own fresh database.
        email: "demo@lashkirja.fi",
        password: "demo123",
        // The not-onboarded user that `demo-seed.ts --ci` adds; the first
        // launch signs out and walks the chat onboarding with it.
        onboardingEmail: "onboarding@lashkirja.fi",
        onboardingPassword: "demo123",
        settleMs: SETTLE_MS,
      });
    }
    case "/step": {
      const n = Number(body.n ?? 0);
      const name = safeName(String(body.name ?? "step"));
      const prefix = launches > 1 ? "r" : "";
      const file = path.join(SHOTS, `${prefix}${String(n).padStart(2, "0")}-${name}.png`);
      const error = await screenshot(file);
      appendFileSync(
        path.join(OUT, "steps.jsonl"),
        `${JSON.stringify({ at: stamp(), launch: launches, n, name, file: path.basename(file), error, metrics: body.metrics })}\n`
      );
      console.log(`[${stamp()}] step ${prefix}${n} ${name}${error ? ` (screenshot failed: ${error})` : ""}`);
      return send(res, 200, { ok: !error });
    }
    case "/log": {
      appendFileSync(
        path.join(OUT, "webview-console.log"),
        `[${stamp()}] [${String(body.level)}] ${String(body.path ?? "")} ${String(body.text ?? "")}\n`
      );
      return send(res, 200, { ok: true });
    }
    case "/done": {
      const phase = String(body.phase ?? "first");
      const problems = Array.isArray(body.problems) ? body.problems.map(String) : [];
      writeFileSync(path.join(OUT, `done-${phase}.json`), JSON.stringify({ at: stamp(), ...body }, null, 2));
      console.log(`[${stamp()}] done ${phase}: ${String(body.steps)} steps, ${problems.length} problems`);
      for (const problem of problems) console.log(`  problem: ${problem}`);
      return send(res, 200, { ok: true });
    }
    default:
      return send(res, 404, { error: "unknown path" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[${stamp()}] step server on http://127.0.0.1:${PORT} (udid ${UDID}, out ${OUT})`);
  console.log(`routes: ${ROUTES.join(" ")}`);
});
