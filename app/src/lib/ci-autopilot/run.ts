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
import { onboardingStep, type OnboardingStepId } from "@/lib/onboarding";

export const CI_AUTOPILOT_MARKER = "LASHKIRJA_CI_AUTOPILOT";

interface AutopilotConfig {
  /** "first" on the first launch, "relaunch" after the runner cold-restarts the app. */
  phase: "first" | "relaunch";
  routes: string[];
  email: string;
  password: string;
  /** A user seeded with onboarded: false (`demo-seed.ts --ci`). */
  onboardingEmail?: string;
  onboardingPassword?: string;
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

async function logIn(
  config: AutopilotConfig,
  credentials: { email: string; password: string } = config,
  prefix = ""
): Promise<void> {
  const email = document.querySelector<HTMLInputElement>("#email");
  const password = document.querySelector<HTMLInputElement>("#password");
  const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
  if (!email || !password || !submit) {
    problem("login form fields not found");
    return;
  }
  email.value = credentials.email;
  password.value = credentials.password;
  await sleep(300);
  await step(`${prefix}login-filled`);
  submit.click();
  await waitFor(() => Boolean(document.querySelector(".app-main")), 30_000, "the app shell after login");
  await settle("/dashboard", config.settleMs);
  await step(`${prefix}after-login`);
}

function textOf(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function buttonWithText(root: ParentNode | null, text: string, selector = "button"): HTMLButtonElement | null {
  if (!root) return null;
  return (
    Array.from(root.querySelectorAll<HTMLButtonElement>(selector)).find((button) => textOf(button).includes(text)) ??
    null
  );
}

/** Hidden or inert UI (a panel between questions) is not tappable. */
function isLive(element: Element): boolean {
  return !element.closest('[data-hidden="true"], [inert], [aria-hidden="true"]');
}

// ---- Chat onboarding (SHELL-14/15/16, OWN-11) with the not-onboarded user.

const ONBOARDING_SURFACE = '[role="dialog"][aria-labelledby="onboarding-title"]';

function onboardingSurface(): HTMLElement | null {
  return document.querySelector<HTMLElement>(ONBOARDING_SURFACE);
}

/** The panel's choices for a question, once they are up and tappable. */
function questionGroup(id: OnboardingStepId): HTMLElement | null {
  const surface = onboardingSurface();
  if (!surface) return null;
  const question = onboardingStep(id).question;
  const group = Array.from(surface.querySelectorAll<HTMLElement>('[role="radiogroup"], [role="group"]')).find(
    (element) => element.getAttribute("aria-label") === question
  );
  return group && isLive(group) ? group : null;
}

async function showQuestion(id: OnboardingStepId, name: string): Promise<HTMLElement | null> {
  if (!(await waitFor(() => questionGroup(id) !== null, 8_000, `onboarding question ${id}`))) return null;
  // The chips' staggered entrance (up to ~320 ms) before the screenshot.
  await sleep(600);
  await step(name);
  return questionGroup(id);
}

function chipLabel(id: OnboardingStepId, value: string | boolean): string {
  const chip = onboardingStep(id).chips.find((item) => item.value === value);
  if (!chip) throw new Error(`no chip ${String(value)} on ${id}`);
  return chip.label;
}

async function answerSingle(id: OnboardingStepId, value: string | boolean, name: string): Promise<boolean> {
  const group = await showQuestion(id, name);
  const chip = buttonWithText(group, chipLabel(id, value), '[role="radio"]');
  if (!chip) {
    problem(`onboarding ${id}: no choice "${chipLabel(id, value)}"`);
    return false;
  }
  chip.click();
  return true;
}

async function answerMulti(id: OnboardingStepId, values: string[], name: string): Promise<boolean> {
  const group = await showQuestion(id, `${name}-question`);
  if (!group) return false;
  for (const value of values) {
    const chip = buttonWithText(group, chipLabel(id, value), "button[aria-pressed]");
    if (!chip) {
      problem(`onboarding ${id}: no choice "${chipLabel(id, value)}"`);
      return false;
    }
    if (chip.getAttribute("aria-pressed") !== "true") chip.click();
  }
  await sleep(400);
  await step(`${name}-selected`);
  const next = buttonWithText(group.parentElement, "Jatka");
  if (!next) {
    problem(`onboarding ${id}: no "Jatka" button after choosing`);
    return false;
  }
  next.click();
  return true;
}

function approveButton(): HTMLButtonElement | null {
  const button = buttonWithText(onboardingSurface(), "Hyväksy ja aloita");
  return button && isLive(button) ? button : null;
}

async function showSummary(name: string): Promise<boolean> {
  if (!(await waitFor(() => approveButton() !== null, 8_000, "the onboarding summary"))) return false;
  await sleep(600);
  await step(name);
  return true;
}

async function signOutFromProfileSheet(): Promise<boolean> {
  const open = document.querySelector<HTMLButtonElement>('.app-header button[aria-haspopup="dialog"]');
  if (!open) {
    problem("sign-out: no profile button in the header");
    return false;
  }
  open.click();
  if (!(await waitFor(() => buttonWithText(document, "Kirjaa ulos") !== null, 5_000, "the profile sheet"))) {
    return false;
  }
  await sleep(700);
  buttonWithText(document, "Kirjaa ulos")?.click();
  return waitFor(() => Boolean(document.querySelector("#email")), 20_000, "the login form after signing out");
}

/**
 * Walks the whole chat onboarding with the not-onboarded user: every
 * question answered, one step back with the header button, one answer
 * changed from the summary, then saved. A screenshot per step (onboarding-*).
 */
async function walkOnboarding(config: AutopilotConfig): Promise<void> {
  if (!config.onboardingEmail || !config.onboardingPassword) {
    problem("no onboarding user in the step server config");
    return;
  }
  navigate("/dashboard");
  await settle("/dashboard", config.settleMs);
  if (!(await signOutFromProfileSheet())) return;
  await sleep(config.settleMs);
  await step("onboarding-signed-out");
  await logIn(config, { email: config.onboardingEmail, password: config.onboardingPassword }, "onboarding-");

  if (!(await waitFor(() => onboardingSurface() !== null, 15_000, "the onboarding chat for a new user"))) return;
  // The sheet's entrance before the first screenshot.
  await sleep(900);

  if (!(await answerSingle("entityType", "toiminimi", "onboarding-01-yritysmuoto"))) return;
  if (!(await answerSingle("vatRegistered", true, "onboarding-02-alv-rekisteri"))) return;
  // The third question is up; go back once with the header button.
  if (!(await showQuestion("vatPeriod", "onboarding-03-alv-kausi"))) return;
  const back = buttonWithText(onboardingSurface()?.querySelector("header") ?? null, "Takaisin");
  if (!back || back.getAttribute("aria-hidden") === "true") {
    problem("onboarding: the header back button is missing on question 3");
    return;
  }
  back.click();
  if (!(await answerSingle("vatRegistered", true, "onboarding-04-takaisin-alv-rekisteri"))) return;
  if (!(await answerSingle("vatPeriod", "month", "onboarding-05-alv-kausi"))) return;
  if (!(await answerMulti("salesTypes", ["ripsipalvelut", "kulmapalvelut"], "onboarding-06-myynti"))) return;
  if (!(await answerMulti("expenseCategories", ["tarvikkeet"], "onboarding-07-kulut"))) return;
  if (!(await showSummary("onboarding-08-yhteenveto"))) return;

  // Use the summary: reopen the VAT period from its row and change it.
  const row = onboardingSurface()?.querySelector<HTMLButtonElement>('button[aria-label^="Muokkaa: ALV-kausi"]');
  if (!row) {
    problem("onboarding: no ALV-kausi row in the summary");
    return;
  }
  row.click();
  if (!(await answerSingle("vatPeriod", "quarter", "onboarding-09-muokkaa-alv-kausi"))) return;
  // Later answers stay as defaults: continue through them unchanged.
  if (!(await answerMulti("salesTypes", ["ripsipalvelut", "kulmapalvelut"], "onboarding-10-myynti"))) return;
  if (!(await answerMulti("expenseCategories", ["tarvikkeet"], "onboarding-11-kulut"))) return;
  if (!(await showSummary("onboarding-12-yhteenveto-muokattu"))) return;
  if (!textOf(onboardingSurface() ?? document.body).includes("Neljännesvuosittain")) {
    problem("onboarding: the summary does not show the changed VAT period (Neljännesvuosittain)");
  }

  approveButton()?.click();
  await sleep(300);
  await step("onboarding-13-tallennetaan");
  if (!(await waitFor(() => onboardingSurface() === null, 15_000, "the onboarding chat to close after saving"))) {
    const alert = onboardingSurface()?.querySelector('[role="alert"]');
    if (alert) problem(`onboarding save failed: ${textOf(alert)}`);
    return;
  }
  await settle("/dashboard", config.settleMs);
  await step("onboarding-14-valmis");
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
  await walkOnboarding(config);
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
