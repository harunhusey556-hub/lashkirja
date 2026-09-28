/**
 * CI-only autopilot for the iOS Simulator check
 * (.github/workflows/ios-sim-check.yml). It drives the REAL bundled app inside
 * WKWebView the way a person would -- the login form, the tab bar, the Lisää
 * button, the header buttons -- and asks the step server on the runner
 * (scripts/ci/sim-step-server.ts) to take a simulator screenshot at each step.
 *
 * Compiled in only when the mobile export is built with
 * NEXT_PUBLIC_CI_AUTOPILOT=1, which next.config.ts refuses unless the API base
 * URL is a local http one. Every normal build (the web app, the device IPA)
 * folds the guard in CiAutopilot.tsx to false and never contains this module;
 * build-ipa.yml greps the export for CI_AUTOPILOT_MARKER to prove it.
 *
 * Every step waits for the step server's answer, which only comes once the
 * screenshot file exists, so the screenshots are in lockstep with the UI and
 * no fixed timing on the runner side is needed.
 */
import { appNavigate } from "@/lib/app-nav";
import { CI_STEP_ORIGIN } from "@/lib/ci-autopilot/constants";

export const CI_AUTOPILOT_MARKER = "LASHKIRJA_CI_AUTOPILOT";

interface AutopilotConfig {
  /** "first" on the first launch, "relaunch" after the runner cold-restarts the app. */
  phase: "first" | "relaunch";
  routes: string[];
  email: string;
  password: string;
  /** Extra wait after a page looks loaded, before its screenshot. */
  settleMs: number;
}

interface Box {
  top: number;
  bottom: number;
  height: number;
}

let started = false;
let stepNo = 0;
const problems: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${CI_STEP_ORIGIN}${path}`, {
    method: "POST",
    credentials: "omit",
    // text/plain keeps this a CORS "simple" request: no preflight.
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(body),
  });
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function forward(level: string, args: unknown[]): void {
  const text = args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  void post("/log", { level, path: location.pathname, text }).catch(() => {});
}

/** Mirrors the WebView console to the runner (webview-console.log), on top of
 * Capacitor's own native console bridge (app-stdout.log). */
function forwardConsole(): void {
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      forward(level, args);
    };
  }
  window.addEventListener("error", (event) => {
    forward("uncaught", [event.message, `${event.filename}:${event.lineno}:${event.colno}`]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason : String(event.reason);
    forward("unhandledrejection", [reason]);
  });
}

function box(selector: string): Box | null {
  const element = document.querySelector(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
}

/** env(safe-area-inset-*) as WKWebView actually resolves it. */
function safeAreaInsets(): Record<string, number> {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
    "padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);" +
    "padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const insets = {
    top: parseFloat(style.paddingTop),
    right: parseFloat(style.paddingRight),
    bottom: parseFloat(style.paddingBottom),
    left: parseFloat(style.paddingLeft),
  };
  probe.remove();
  return insets;
}

/** The lowest painted content inside the scroller, in viewport coordinates. */
function lowestContentBottom(main: HTMLElement): number | null {
  let lowest: number | null = null;
  const elements = main.querySelectorAll("*");
  const limit = Math.min(elements.length, 4000);
  for (let index = 0; index < limit; index += 1) {
    const rect = elements[index].getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) continue;
    if (lowest === null || rect.bottom > lowest) lowest = rect.bottom;
  }
  return lowest === null ? null : Math.round(lowest);
}

function metrics(): Record<string, unknown> {
  const main = document.querySelector<HTMLElement>(".app-main");
  const tabBar = box(".app-tab-bar");
  const lowest = main ? lowestContentBottom(main) : null;
  return {
    path: `${location.pathname}${location.search}`,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      visualHeight: window.visualViewport ? Math.round(window.visualViewport.height) : null,
      dpr: window.devicePixelRatio,
    },
    safeArea: safeAreaInsets(),
    documentScrollTop: document.scrollingElement ? document.scrollingElement.scrollTop : null,
    documentScrollHeight: document.documentElement.scrollHeight,
    main: main
      ? {
          scrollTop: Math.round(main.scrollTop),
          scrollHeight: main.scrollHeight,
          clientHeight: main.clientHeight,
          paddingBottom: getComputedStyle(main).paddingBottom,
          overflowY: getComputedStyle(main).overflowY,
        }
      : null,
    header: box(".app-header"),
    tabBar,
    lowestContentBottom: lowest,
    contentClearsTabBar: tabBar && lowest !== null ? lowest <= tabBar.top : null,
    dialog: box('[role="dialog"]'),
    heading: document.querySelector("h1")?.textContent?.trim() ?? null,
  };
}

async function step(name: string): Promise<void> {
  stepNo += 1;
  console.info(`${CI_AUTOPILOT_MARKER} STEP ${stepNo} ${name}`);
  await post("/step", { n: stepNo, name, metrics: metrics() });
}

function problem(message: string): void {
  problems.push(message);
  console.warn(`${CI_AUTOPILOT_MARKER} PROBLEM ${message}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await sleep(200);
  }
  problem(`timed out after ${timeoutMs} ms waiting for ${label}`);
  return false;
}

function currentPath(): string {
  const path = location.pathname.replace(/\.html$/, "").replace(/\/+$/, "");
  return path || "/";
}

function routePath(route: string): string {
  const path = route.split("?")[0].replace(/\/+$/, "");
  return path || "/";
}

function isBusy(): boolean {
  return Boolean(document.querySelector('[aria-busy="true"], .animate-pulse'));
}

/** Loaded = on the route, the shell's scroller is mounted, and no skeleton
 * or busy region is left (bounded), then a short settle for animations. */
async function settle(route: string, settleMs: number): Promise<void> {
  await waitFor(() => currentPath() === routePath(route), 15_000, `route ${route}`);
  await waitFor(() => Boolean(document.querySelector(".app-main")), 10_000, `.app-main on ${route}`);
  const startedAt = Date.now();
  while (isBusy() && Date.now() - startedAt < 8_000) await sleep(200);
  await sleep(settleMs);
}

function navigate(route: string): void {
  // A tab root is reached the way a person does it: the tab bar link.
  const tab = document.querySelector<HTMLAnchorElement>(`.app-tab-bar a[href="${route}"]`);
  if (tab) {
    tab.click();
    return;
  }
  appNavigate(route);
}

async function scrollMain(to: "bottom" | "top"): Promise<void> {
  const main = document.querySelector<HTMLElement>(".app-main");
  if (!main) {
    problem(`no .app-main to scroll on ${currentPath()}`);
    return;
  }
  main.scrollTo({ top: to === "bottom" ? main.scrollHeight : 0, behavior: "smooth" });
  await sleep(1_400);
  // Smooth scrolling can be cut short; make the end position exact.
  main.scrollTop = to === "bottom" ? main.scrollHeight : 0;
  await sleep(400);
}

function slug(route: string): string {
  return (
    route
      .replace(/^\/+/, "")
      .replace(/[?=&]/g, "-")
      .replace(/[^a-zA-Z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "root"
  );
}

function openDialogs(): Element[] {
  return Array.from(document.querySelectorAll('[role="dialog"]'));
}

async function openAndClose(buttonSelector: string, name: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(buttonSelector);
  if (!button) {
    problem(`${name}: no button matches ${buttonSelector} on ${currentPath()}`);
    return;
  }
  const before = openDialogs().length;
  button.click();
  await waitFor(() => openDialogs().length > before, 5_000, `${name} to open`);
  // Let the open animation finish before the screenshot.
  await sleep(900);
  await step(name);

  const dialogs = openDialogs();
  const dialog = dialogs[dialogs.length - 1];
  const close = dialog?.querySelector<HTMLButtonElement>('button[aria-label="Sulje"]');
  if (close) {
    close.click();
  } else {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }
  await waitFor(() => openDialogs().length <= before, 5_000, `${name} to close`);
  await sleep(700);
}

async function waitForFirstScreen(): Promise<"login" | "app" | null> {
  const found = await waitFor(
    () => Boolean(document.querySelector("#email") || document.querySelector(".app-main")),
    45_000,
    "the login form or the app shell"
  );
  if (!found) return null;
  return document.querySelector("#email") ? "login" : "app";
}

async function logIn(config: AutopilotConfig): Promise<void> {
  const email = document.querySelector<HTMLInputElement>("#email");
  const password = document.querySelector<HTMLInputElement>("#password");
  const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
  if (!email || !password || !submit) {
    problem("login form fields not found");
    return;
  }
  email.value = config.email;
  password.value = config.password;
  await sleep(300);
  await step("login-filled");
  submit.click();
  await waitFor(() => Boolean(document.querySelector(".app-main")), 30_000, "the app shell after login");
  await settle("/dashboard", config.settleMs);
  await step("after-login");
}

async function firstLaunch(config: AutopilotConfig): Promise<void> {
  const screen = await waitForFirstScreen();
  await sleep(config.settleMs);
  await step("launch");
  if (screen === "login") await logIn(config);
  else if (screen === null) return;

  for (const route of config.routes) {
    navigate(route);
    await settle(route, config.settleMs);
    const name = slug(route);
    await step(`${name}-top`);
    await scrollMain("bottom");
    await step(`${name}-bottom`);
    await scrollMain("top");
  }

  navigate("/dashboard");
  await settle("/dashboard", config.settleMs);
  await openAndClose('.app-tab-bar button[aria-label="Lisää"]', "sheet-lisaa");
  await openAndClose('.app-header button[aria-label="Avustaja"]', "drawer-avustaja");
  await openAndClose('.app-header button[aria-haspopup="dialog"]', "sheet-profiili");
  await step("end");
}

async function relaunch(config: AutopilotConfig): Promise<void> {
  // A cold start after the runner terminated the app: the Keychain session
  // must bring the user straight back into the app, not to the login form.
  const screen = await waitForFirstScreen();
  await sleep(config.settleMs);
  await step("relaunch");
  if (screen !== "app") problem(`cold relaunch showed ${screen ?? "nothing"} instead of the signed-in app`);
}

async function run(): Promise<void> {
  forwardConsole();
  const config = (await post("/config", { href: location.href, userAgent: navigator.userAgent })) as AutopilotConfig;
  try {
    if (config.phase === "relaunch") await relaunch(config);
    else await firstLaunch(config);
  } catch (error) {
    problem(`autopilot threw: ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  }
  await post("/done", { phase: config.phase, steps: stepNo, problems });
}

/** Called once per app launch by CiAutopilot.tsx (root layout). */
export function startCiAutopilot(): void {
  if (started) return;
  started = true;
  void run().catch(() => {
    // The step server is unreachable; the runner's timeout reports it.
  });
}
