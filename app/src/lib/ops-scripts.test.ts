import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// The Windows ops scripts (app/scripts/ops) run the production instance. The contract checks below
// read their source and run anywhere; the PowerShell suites need a PowerShell, and the ones that run
// the scripts need Windows. Every run uses a temp -Root, a temp LOCALAPPDATA (so no Telegram token
// can be found) and a scheduled-task name that does not exist: nothing here can touch C:\LashKirja.

const opsDir = path.join(process.cwd(), "scripts/ops");
const read = (name: string) => readFileSync(path.join(opsDir, name), "utf8");

function findPowerShell(): string | null {
  const candidates = process.platform === "win32" ? ["powershell.exe", "pwsh"] : ["pwsh"];
  for (const exe of candidates) {
    const probe = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { stdio: "ignore" });
    if (probe.status === 0) return exe;
  }
  return null;
}

// Each case starts PowerShell once or twice, which is slow next to the 5 s default.
vi.setConfig({ testTimeout: 90_000 });

const powershell = findPowerShell();
const canRun = process.platform === "win32" && powershell !== null;
const noSuchTask = "lk-test-no-such-task";
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lk-ops-"));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, "localappdata"));
  return dir;
}

// process.env is typed with a required NODE_ENV here; the scripts get a plain string map.
type Env = Record<string, string | undefined>;

interface PsResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runPowerShell(args: string[], root: string, extraEnv: Env = {}): Promise<PsResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: path.join(root, "localappdata"), ...extraEnv };
  delete env.DATABASE_URL;
  return new Promise((resolve) => {
    execFile(
      powershell as string,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
      { env, timeout: 90_000, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
      }
    );
  });
}

function runScript(script: string, args: string[], root: string, extraEnv: Env = {}): Promise<PsResult> {
  return runPowerShell(["-File", path.join(opsDir, script), ...args], root, extraEnv);
}

function readLogs(root: string, prefix: string): string {
  const dir = path.join(root, "logs");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".log"))
    .map((name) => readFileSync(path.join(dir, name), "utf8"))
    .join("");
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function listen(handler: Handler) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function closedPort(): Promise<number> {
  const server = await listen(() => undefined);
  const { port } = server;
  await server.close();
  return port;
}

function healthHandler(
  status: number,
  disk: { ok: boolean; detail: string } = { ok: true, detail: "writable" },
  worker: { ok: boolean; detail: string } = { ok: true, detail: "ok" }
): Handler {
  return (_req, res) => {
    const body = {
      ok: status === 200,
      checks: { db: { ok: true, detail: "ok" }, disk, mail: { ok: true, detail: "ok" }, bankJobs: { ok: true, detail: "ok" }, worker },
    };
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

function ageFile(file: string, ageMinutes: number): void {
  const when = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(file, when, when);
}

function writeBackup(root: string, ageHours: number): void {
  const dir = path.join(root, "backups");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "lashkirja-2026-10-01.zip");
  writeFileSync(file, "not a real zip");
  ageFile(file, ageHours * 60);
}

function writeLock(root: string, pid: number, ageMinutes: number): void {
  const dir = path.join(root, "run");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "deploy.lock");
  writeFileSync(file, `${pid}\r\n`);
  ageFile(file, ageMinutes);
}

// A restart in the last ten minutes makes a real run stop at "not restarting again", so a test that
// expects a healthy answer can never reach Restart-App even if its server is not reached.
function writeCalmState(root: string): void {
  const dir = path.join(root, "run");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "watchdog-state.json"),
    JSON.stringify({ lastRestart: new Date().toISOString(), consecutiveFailures: 0, lastStatus: "healthy" })
  );
}

function readState(root: string): Record<string, unknown> {
  const text = readFileSync(path.join(root, "run", "watchdog-state.json"), "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text) as Record<string, unknown>;
}

async function watchdog(root: string, port: number, extra: string[] = []): Promise<PsResult & { log: string }> {
  const result = await runScript(
    "watchdog-prod.ps1",
    ["-Root", root, "-Port", String(port), "-ConfirmWaitSeconds", "0", "-TimeoutSec", "3", "-TaskName", noSuchTask, ...extra],
    root
  );
  return { ...result, log: readLogs(root, "watchdog") };
}

async function sleeper() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  await once(child, "spawn");
  return child;
}

function deadPid(): number {
  const finished = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  return finished.pid;
}

describe("ops scripts: contracts read from the source", () => {
  const scripts = readdirSync(opsDir).filter((name) => name.endsWith(".ps1"));

  it("keeps every script ASCII: Windows PowerShell 5.1 reads a file without a BOM as Windows-1252", () => {
    for (const name of scripts) {
      const text = read(name).replace(/^\uFEFF/, "");
      const bad = [...text].findIndex((char) => char.charCodeAt(0) > 127);
      expect(bad, `${name} has a non-ASCII character at ${bad}`).toBe(-1);
    }
  });

  it("reads the Telegram token in lk-common.ps1 only, and every alerting script loads that file", () => {
    for (const name of scripts.filter((n) => n !== "lk-common.ps1")) {
      const text = read(name);
      expect(text, name).not.toMatch(/api\.telegram\.org|TELEGRAM_BOT_TOKEN|TELEGRAM_HOME_CHANNEL/);
    }
    const common = read("lk-common.ps1");
    expect(common).toContain("function Notify");
    expect(common).toContain("function Read-DotEnv");
    for (const name of ["watchdog-prod.ps1", "backup-local.ps1", "run-cron.ps1", "deploy-local.ps1"]) {
      expect(read(name), name).toMatch(/\.\s+\(Join-Path \S+ 'lk-common\.ps1'\)/);
    }
    // The watchdog's own Notify and Read-DotEnv moved into the shared file.
    expect(read("watchdog-prod.ps1")).not.toMatch(/function (Notify|Read-DotEnv)/);
  });

  it("makes the watchdog look at deploy.lock before it probes anything", () => {
    const text = read("watchdog-prod.ps1");
    const main = text.slice(text.indexOf("$exitCode = 0"));
    expect(main.indexOf("Get-DeployLock")).toBeGreaterThan(-1);
    expect(main.indexOf("Get-DeployLock")).toBeLessThan(main.indexOf("Probe-Health"));
    expect(text).toContain("'deploy.lock'");
    // ...and once more right before it restarts, since the probes take a while.
    expect(main.lastIndexOf("Get-DeployLock")).toBeLessThan(main.indexOf("Restart-App"));
    expect(main.lastIndexOf("Get-DeployLock")).toBeGreaterThan(main.indexOf("Get-DeployLock"));
  });

  it("pins DATABASE_URL in deploy-local.ps1 before the first npm or prisma call, and never logs it", () => {
    const text = read("deploy-local.ps1");
    const main = text.slice(text.indexOf("$exitCode = 0"));
    const pin = main.indexOf("Set-ProdDatabaseUrl");
    expect(pin).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(main.indexOf("Exec 'npm.cmd'"));
    expect(pin).toBeLessThan(main.indexOf("prisma\\build\\index.js"));
    const fn = text.slice(text.indexOf("function Set-ProdDatabaseUrl"), text.indexOf("function Get-HealthToken"));
    expect(fn).not.toMatch(/Log\s.*\$url/);
    // Only that one variable: the .env is not copied into the environment wholesale.
    expect(count(fn, "$env:")).toBe(1);
  });

  it("sends the backup failure to Telegram from both failure paths", () => {
    const text = read("backup-local.ps1");
    expect(text.match(/^\s*Notify "LashKirja HATA/gm)).toHaveLength(2);
    // The failure marker and the event log come first: they stay the guaranteed signals.
    const failed = text.slice(text.indexOf("$failure = $_"));
    expect(failed.indexOf("BACKUP-FAILED.txt")).toBeLessThan(failed.indexOf('Notify "LashKirja HATA'));
    const missingDb = text.slice(text.indexOf("does not exist"));
    expect(missingDb.indexOf("Notify")).toBeLessThan(missingDb.indexOf("exit 1"));
  });
});

describe.skipIf(powershell === null)("ops scripts: the PowerShell parser", () => {
  it("parses every .ps1", async () => {
    const root = tempRoot();
    const script = path.join(root, "parse.ps1");
    writeFileSync(
      script,
      [
        "$problems = @()",
        "foreach ($f in Get-ChildItem -LiteralPath $env:LK_OPS_DIR -Filter *.ps1) {",
        "  $t = $null; $e = $null",
        "  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e)",
        "  foreach ($x in $e) { $problems += ('{0}:{1}: {2}' -f $f.Name, $x.Extent.StartLineNumber, $x.Message) }",
        "}",
        "ConvertTo-Json -InputObject @($problems) -Compress",
      ].join("\n")
    );
    const result = await runPowerShell(["-File", script], root, { LK_OPS_DIR: opsDir });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([]);
  });
});

describe.skipIf(!canRun)("watchdog-prod.ps1", () => {
  it("exits at once, without probing or restarting, while a live deploy holds run\\deploy.lock", async () => {
    const down = await closedPort();

    // Control: the same dead server without a lock does reach the restart (suppressed by -DryRun).
    const free = tempRoot();
    writeBackup(free, 1);
    const unlocked = await watchdog(free, down, ["-DryRun"]);
    expect(unlocked.log).toContain("restarting:");
    expect(unlocked.code).toBe(1);

    const root = tempRoot();
    writeBackup(root, 1);
    const holder = await sleeper();
    try {
      writeLock(root, holder.pid as number, 0);
      const run = await watchdog(root, down, ["-DryRun"]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.log).toContain("deploy in progress");
      expect(run.log).not.toContain("health not ok");
      expect(run.log).not.toContain("restarting:");
      expect(run.log).not.toContain("notify");
    } finally {
      holder.kill();
    }
  });

  it("does not let a lock whose process is gone block it, and tells the owner once", async () => {
    const server = await listen(healthHandler(200));
    try {
      const root = tempRoot();
      writeBackup(root, 1);
      writeCalmState(root);
      const pid = deadPid();
      writeLock(root, pid, 5);
      const first = await watchdog(root, server.port);
      expect(first.code, first.stderr).toBe(0);
      expect(first.log).toContain(`stale deploy.lock (process ${pid} is not running)`);
      expect(first.log).toContain("healthy (ok)");
      expect(count(first.log, "deploy.lock on jaanyt paalle")).toBe(1);
      expect(readState(root).staleLockAlerted).toBeTruthy();

      const second = await watchdog(root, server.port);
      expect(count(second.log, "deploy.lock on jaanyt paalle")).toBe(1);
      expect(count(second.log, "stale deploy.lock")).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("calls a lock stale once its process has held it for DeployLockStaleMinutes", async () => {
    const server = await listen(healthHandler(200));
    const holder = await sleeper();
    try {
      const root = tempRoot();
      writeBackup(root, 1);
      writeCalmState(root);
      writeLock(root, holder.pid as number, 0);
      const run = await watchdog(root, server.port, ["-DeployLockStaleMinutes", "0"]);
      expect(run.log).toContain(`process ${holder.pid} has held it for`);
      expect(run.log).not.toContain("deploy in progress");
      expect(run.log).toContain("deploy.lock on jaanyt paalle");
    } finally {
      holder.kill();
      await server.close();
    }
  });

  it("does not take a reused process id for the deploy: a process younger than the lock is not its writer", async () => {
    const server = await listen(healthHandler(200));
    const bystander = await sleeper();
    try {
      const root = tempRoot();
      writeBackup(root, 1);
      writeCalmState(root);
      writeLock(root, bystander.pid as number, 90);
      const run = await watchdog(root, server.port);
      expect(run.log).toContain("started after the lock was written");
      expect(run.log).not.toContain("deploy in progress");
    } finally {
      bystander.kill();
      await server.close();
    }
  });

  it("alerts when the newest backup is older than 36 h, at most once per AlertGapHours", async () => {
    const server = await listen(healthHandler(200));
    try {
      const root = tempRoot();
      writeBackup(root, 40);
      writeCalmState(root);
      const first = await watchdog(root, server.port);
      expect(first.code, first.stderr).toBe(0);
      expect(first.log).toMatch(/notify skipped .*LashKirja HATA: uusin varmuuskopio on 40 h vanha \(lashkirja-2026-10-01\.zip\)/);
      expect(readState(root).backupAlerted).toBeTruthy();

      const second = await watchdog(root, server.port);
      expect(count(second.log, "LashKirja HATA: uusin varmuuskopio on")).toBe(1);
      expect(count(second.log, "backup stale")).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("stays quiet about a 35 h old backup, and says so when there is no backup at all", async () => {
    const server = await listen(healthHandler(200));
    try {
      const recent = tempRoot();
      writeBackup(recent, 35);
      writeCalmState(recent);
      const quiet = await watchdog(recent, server.port);
      expect(quiet.log).not.toContain("backup stale");

      const none = tempRoot();
      writeCalmState(none);
      const missing = await watchdog(none, server.port);
      expect(missing.log).toContain("varmuuskopioita ei loydy");
    } finally {
      await server.close();
    }
  });

  it("treats a 503 whose only red check is low-space as a warning: no restart, one alert", async () => {
    const server = await listen(healthHandler(503, { ok: false, detail: "low-space" }));
    try {
      const root = tempRoot();
      writeBackup(root, 1);
      writeCalmState(root);
      const first = await watchdog(root, server.port);
      expect(first.code, first.stderr).toBe(0);
      expect(first.log).toContain("healthy (degraded)");
      expect(first.log).toContain("disk: low-space");
      expect(first.log).not.toContain("health not ok");
      expect(first.log).not.toContain("restarting:");
      expect(first.log).toContain("levytila on vahissa");

      const second = await watchdog(root, server.port);
      expect(count(second.log, "levytila on vahissa")).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("still restarts for a disk that is unwritable", async () => {
    const server = await listen(healthHandler(503, { ok: false, detail: "unwritable" }));
    try {
      const root = tempRoot();
      writeBackup(root, 1);
      const run = await watchdog(root, server.port, ["-DryRun"]);
      expect(run.log).toContain("health not ok: down_503");
      expect(run.log).toContain("restarting:");
    } finally {
      await server.close();
    }
  });

  // A stale worker makes /api/health 503 like a failed bank sync does, and a restart of the web
  // server does not bring the worker back: the web server stays up, the owner gets one line.
  it.each(["stale", "never-started", "unreadable"])(
    "treats a 503 whose only red check is the worker (%s) as serving: no restart, one alert",
    async (detail) => {
      const server = await listen(healthHandler(503, undefined, { ok: false, detail }));
      try {
        const root = tempRoot();
        writeBackup(root, 1);
        writeCalmState(root);
        const first = await watchdog(root, server.port);
        expect(first.code, first.stderr).toBe(0);
        expect(first.log).toContain("healthy (degraded)");
        expect(first.log).toContain(`worker: heartbeat ${detail}`);
        expect(first.log).not.toContain("health not ok");
        expect(first.log).not.toContain("restarting:");
        expect(first.log).toContain("taustatyo (worker) ei toimi");

        const second = await watchdog(root, server.port);
        expect(count(second.log, "taustatyo (worker) ei toimi")).toBe(1);
      } finally {
        await server.close();
      }
    }
  );

  // The cases above run with a recent restart on record, which would stop any restart at "not
  // restarting again"; with no state at all this one shows that the decision itself is not to restart.
  it("never reaches the restart for a stale worker", async () => {
    const server = await listen(healthHandler(503, undefined, { ok: false, detail: "stale" }));
    try {
      const root = tempRoot();
      writeBackup(root, 1);
      const run = await watchdog(root, server.port, ["-DryRun"]);
      expect(run.log).toContain("healthy (degraded)");
      expect(run.log).not.toContain("restarting:");
    } finally {
      await server.close();
    }
  });

  it("still restarts for a dead database, whatever the worker says", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          checks: {
            db: { ok: false, detail: "unavailable" },
            disk: { ok: true, detail: "writable" },
            mail: { ok: true, detail: "ok" },
            bankJobs: { ok: true, detail: "ok" },
            worker: { ok: false, detail: "stale" },
          },
        })
      );
    });
    try {
      const root = tempRoot();
      writeBackup(root, 1);
      const run = await watchdog(root, server.port, ["-DryRun"]);
      expect(run.log).toContain("health not ok: down_503");
      expect(run.log).toContain("restarting:");
    } finally {
      await server.close();
    }
  });

  it("reads a 503 from a server that has no worker check yet (mid-deploy) as before", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          checks: {
            db: { ok: true, detail: "ok" },
            disk: { ok: true, detail: "writable" },
            mail: { ok: true, detail: "ok" },
            bankJobs: { ok: false, detail: "failed-recent" },
          },
        })
      );
    });
    try {
      const root = tempRoot();
      writeBackup(root, 1);
      writeCalmState(root);
      const run = await watchdog(root, server.port);
      expect(run.code, run.stderr).toBe(0);
      expect(run.log).toContain("healthy (degraded)");
      expect(run.log).not.toContain("worker: heartbeat");
      expect(run.log).not.toContain("restarting:");
    } finally {
      await server.close();
    }
  });
});

describe.skipIf(!canRun)("deploy-local.ps1 (its functions, run on their own)", () => {
  const prelude = [
    "$ErrorActionPreference = 'Stop'",
    ". $env:LK_COMMON",
    "$tokens = $null; $errs = $null",
    "$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:LK_SCRIPT, [ref]$tokens, [ref]$errs)",
    "foreach ($name in $env:LK_FUNCTIONS.Split(',')) {",
    "  $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)",
    "  if (-not $fn) { throw \"function $name not found\" }",
    "  Invoke-Expression $fn.Extent.Text",
    "}",
    "$script:lines = @()",
    "function Log([string]$m) { $script:lines += $m }",
    "$AppDir = $env:LK_APP_DIR",
  ].join("\n");

  async function runFunctions(root: string, functions: string[], body: string, extraEnv: Env = {}) {
    const driver = path.join(root, `driver-${functions.join("-")}.ps1`);
    writeFileSync(driver, `${prelude}\n${body}\n`);
    const result = await runPowerShell(["-File", driver], root, {
      LK_COMMON: path.join(opsDir, "lk-common.ps1"),
      LK_SCRIPT: path.join(opsDir, "deploy-local.ps1"),
      LK_FUNCTIONS: functions.join(","),
      LK_APP_DIR: path.join(root, "prod", "app"),
      ...extraEnv,
    });
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim()) as { url?: string; secret?: string; thrown?: string; ok?: boolean; lines: string[] };
  }

  const pinBody = [
    "$env:DATABASE_URL = 'file:C:/stray/es_m98_test.db'",
    "Remove-Item Env:SESSION_SECRET -ErrorAction SilentlyContinue",
    "try { Set-ProdDatabaseUrl; $thrown = '' } catch { $thrown = $_.Exception.Message }",
    "[pscustomobject]@{ url = \"$env:DATABASE_URL\"; secret = \"$env:SESSION_SECRET\"; thrown = $thrown; lines = @($script:lines) } | ConvertTo-Json -Compress",
  ].join("\n");

  it("sets DATABASE_URL from the prod .env over a value inherited from the caller, and never logs it", async () => {
    const root = tempRoot();
    mkdirSync(path.join(root, "prod", "app"), { recursive: true });
    writeFileSync(
      path.join(root, "prod", "app", ".env"),
      ["# prod", "SESSION_SECRET=not-for-the-environment", "DATABASE_URL='file:C:/LashKirja/data/prod.db'", ""].join("\r\n")
    );
    const out = await runFunctions(root, ["Set-ProdDatabaseUrl"], pinBody);
    expect(out.thrown).toBe("");
    expect(out.url).toBe("file:C:/LashKirja/data/prod.db");
    expect(out.secret).toBe("");
    expect(out.lines.join("\n")).not.toContain("prod.db");
  });

  it("refuses to go on when the prod .env has no DATABASE_URL, whatever the caller has set", async () => {
    const root = tempRoot();
    mkdirSync(path.join(root, "prod", "app"), { recursive: true });
    writeFileSync(path.join(root, "prod", "app", ".env"), "SESSION_SECRET=x\r\n");
    const out = await runFunctions(root, ["Set-ProdDatabaseUrl"], pinBody);
    expect(out.thrown).toContain("has no DATABASE_URL");
    expect(out.thrown).not.toContain("es_m98_test");
  });

  // The whole script, stopped before it can touch anything: the fake .git makes `git fetch` the first
  // real step, and it fails there. GIT_CEILING_DIRECTORIES keeps git from finding a repo above the temp dir.
  async function deployUntilFetch(env: string) {
    const root = tempRoot();
    mkdirSync(path.join(root, "prod", ".git"), { recursive: true });
    mkdirSync(path.join(root, "prod", "app"), { recursive: true });
    writeFileSync(path.join(root, "prod", "app", ".env"), env);
    const run = await runScript("deploy-local.ps1", ["-Root", root, "-TaskName", noSuchTask], root, {
      DATABASE_URL: "file:C:/stray/es_m98_test.db",
      GIT_CEILING_DIRECTORIES: path.dirname(root),
    });
    return { run, root, log: readdirSync(path.join(root, "logs")).map((n) => readFileSync(path.join(root, "logs", n), "utf8")).join("") };
  }

  it("stops the deploy before any git, npm or prisma call when the prod .env has no DATABASE_URL", async () => {
    const { run, root, log } = await deployUntilFetch("SESSION_SECRET=x\r\n");
    expect(run.code).toBe(1);
    expect(log).toContain("has no DATABASE_URL");
    expect(log).toContain("deploy FAILED at stage 'start'");
    expect(log).not.toContain("> git");
    expect(log).not.toContain("es_m98_test");
    expect(existsSync(path.join(root, "run", "deploy.lock"))).toBe(false);
  });

  it("pins the prod value before the first step, and the log never shows it", async () => {
    const { run, log } = await deployUntilFetch("DATABASE_URL=file:C:/LashKirja/data/prod.db\r\n");
    expect(run.code).toBe(1);
    expect(log).toContain("DATABASE_URL set from the prod .env");
    expect(log.indexOf("DATABASE_URL set from")).toBeLessThan(log.indexOf("> git"));
    expect(log).toContain("deploy FAILED at stage 'fetch'");
    expect(log).not.toContain("prod.db");
    expect(log).not.toContain("es_m98_test");
  });

  const healthBody = [
    "$Port = [int]$env:LK_PORT",
    "$result = @(Test-Health 3)[-1]",
    "[pscustomobject]@{ ok = [bool]$result; lines = @($script:lines) } | ConvertTo-Json -Compress",
  ].join("\n");

  it("keeps a deploy whose health check is 503 only because the disk is low on space", async () => {
    const server = await listen(healthHandler(503, { ok: false, detail: "low-space" }));
    try {
      const root = tempRoot();
      mkdirSync(path.join(root, "prod", "app"), { recursive: true });
      writeFileSync(path.join(root, "prod", "app", ".env"), "HEALTH_TOKEN=\r\n");
      const out = await runFunctions(root, ["Get-HealthToken", "Get-HealthErrorBody", "Test-Health"], healthBody, {
        LK_PORT: String(server.port),
      });
      expect(out.ok).toBe(true);
      expect(out.lines.join("\n")).toContain("degraded: disk");
    } finally {
      await server.close();
    }
  });

  it("keeps a deploy whose health check is 503 only because the worker has not written its heartbeat", async () => {
    const server = await listen(healthHandler(503, undefined, { ok: false, detail: "never-started" }));
    try {
      const root = tempRoot();
      mkdirSync(path.join(root, "prod", "app"), { recursive: true });
      writeFileSync(path.join(root, "prod", "app", ".env"), "HEALTH_TOKEN=\r\n");
      const out = await runFunctions(root, ["Get-HealthToken", "Get-HealthErrorBody", "Test-Health"], healthBody, {
        LK_PORT: String(server.port),
      });
      expect(out.ok).toBe(true);
      expect(out.lines.join("\n")).toContain("degraded: worker");
    } finally {
      await server.close();
    }
  });

  it("still rolls back when the disk is unwritable", async () => {
    const server = await listen(healthHandler(503, { ok: false, detail: "unwritable" }));
    try {
      const root = tempRoot();
      mkdirSync(path.join(root, "prod", "app"), { recursive: true });
      writeFileSync(path.join(root, "prod", "app", ".env"), "HEALTH_TOKEN=\r\n");
      const out = await runFunctions(root, ["Get-HealthToken", "Get-HealthErrorBody", "Test-Health"], healthBody, {
        LK_PORT: String(server.port),
      });
      expect(out.ok).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe.skipIf(!canRun)("backup-local.ps1", () => {
  it("tells the owner when there is no database to back up", async () => {
    const root = tempRoot();
    const run = await runScript("backup-local.ps1", ["-Root", root, "-NoMirror"], root);
    expect(run.code, run.stderr).toBe(1);
    const log = readLogs(root, "backup");
    expect(log).toContain("backup FAILED");
    expect(log).toMatch(/notify skipped .*LashKirja HATA: varmuuskopio epaonnistui, tietokantaa ei loydy/);
  });

  it("still runs when the shared alert helper is missing: only the alert is lost", async () => {
    const root = tempRoot();
    const lonely = path.join(root, "ops");
    mkdirSync(lonely);
    writeFileSync(path.join(lonely, "backup-local.ps1"), readFileSync(path.join(opsDir, "backup-local.ps1")));
    const run = await runPowerShell(["-File", path.join(lonely, "backup-local.ps1"), "-Root", root, "-NoMirror"], root);
    expect(run.code, run.stderr).toBe(1);
    const log = readLogs(root, "backup");
    expect(log).toContain("alerting unavailable");
    expect(log).toContain("notify unavailable: LashKirja HATA: varmuuskopio epaonnistui");
  });
});

describe.skipIf(!canRun)("run-cron.ps1", () => {
  async function cron(root: string, port: number) {
    const result = await runScript("run-cron.ps1", ["-Root", root, "-Port", String(port)], root);
    return { ...result, log: readLogs(root, "cron") };
  }

  function cronRoot(): string {
    const root = tempRoot();
    mkdirSync(path.join(root, "prod", "app"), { recursive: true });
    writeFileSync(path.join(root, "prod", "app", ".env"), "CRON_SECRET=cron-secret-for-the-test\r\n");
    return root;
  }

  it("alerts when a route fails, once per AlertGapHours, and alerts again after a success", async () => {
    let status = 500;
    const server = await listen((_req, res) => {
      res.writeHead(status);
      res.end("{}");
    });
    try {
      const root = cronRoot();
      const first = await cron(root, server.port);
      // The exit code is what Task Scheduler shows; it used to be 0 here whatever the routes answered.
      expect(first.code, first.stderr).toBe(1);
      expect(first.log).toContain("recurring-invoices -> HTTP 500");
      expect(first.log).toMatch(/notify skipped .*LashKirja HATA: ajastettu ajo epaonnistui \(recurring-invoices, cleanup\)/);
      expect(first.log).not.toContain("cron-secret-for-the-test");

      const second = await cron(root, server.port);
      expect(second.code).toBe(1);
      expect(count(second.log, "ajastettu ajo epaonnistui")).toBe(1);

      status = 200;
      const ok = await cron(root, server.port);
      expect(ok.code, ok.stderr).toBe(0);
      expect(existsSync(path.join(root, "run", "cron-alert.txt"))).toBe(false);

      status = 500;
      const again = await cron(root, server.port);
      expect(again.code).toBe(1);
      expect(count(again.log, "ajastettu ajo epaonnistui")).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("names only the route that failed", async () => {
    const server = await listen((req, res) => {
      res.writeHead(req.url?.includes("/cleanup") ? 500 : 200);
      res.end("{}");
    });
    try {
      const run = await cron(cronRoot(), server.port);
      expect(run.code).toBe(1);
      expect(run.log).toMatch(/ajastettu ajo epaonnistui \(cleanup\)/);
    } finally {
      await server.close();
    }
  });

  it("sends no alert when both routes succeed", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200);
      res.end("{}");
    });
    try {
      const run = await cron(cronRoot(), server.port);
      expect(run.code, run.stderr).toBe(0);
      expect(run.log).not.toContain("notify");
    } finally {
      await server.close();
    }
  });
});
