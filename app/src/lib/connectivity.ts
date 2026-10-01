"use client";

/**
 * One connectivity store for the whole app -- device reachability
 * (`navigator.onLine` plus the native Network plugin) and server
 * reachability (derived from how `apiFetch` calls actually go), used by
 * the banner (ConnectivityBanner.tsx) and by `assertCanWrite()` to fail a
 * write fast instead of leaving a button spinning until a 25s timeout.
 *
 * Web uses the same store -- the banner is useful there too, and a write
 * screen can fail fast on a dropped Wi-Fi connection exactly like on
 * mobile.
 */
import { useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { apiUrl } from "@/lib/build-target";

export type DeviceState = "online" | "offline";
export type ServerState = "ok" | "unreachable";

export interface Connectivity {
  device: DeviceState;
  server: ServerState;
  lastOkAt: number | null;
  serverApiVersion: number | null;
}

const HEALTH_PROBE_INTERVAL_MS = 15_000;
/** Two in a row -- one blip (a single dropped request) is not "unreachable". */
const UNREACHABLE_AFTER = 2;

function initialDeviceState(): DeviceState {
  if (typeof navigator === "undefined" || navigator.onLine === undefined) return "online";
  return navigator.onLine ? "online" : "offline";
}

let state: Connectivity = {
  device: initialDeviceState(),
  server: "ok",
  lastOkAt: null,
  serverApiVersion: null,
};

let consecutiveNetworkErrors = 0;
const listeners = new Set<() => void>();
let wired = false;
let healthProbeTimer: ReturnType<typeof setInterval> | null = null;
let nativeNetworkHandle: { remove: () => void } | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function isHealthy(snapshot: Connectivity): boolean {
  return snapshot.device === "online" && snapshot.server === "ok";
}

/** Every state change funnels through here, so the reconnect transition
 * (device coming back online, the server becoming reachable again, or
 * both) is detected in one place regardless of which field changed. */
function setState(partial: Partial<Connectivity>): void {
  const previous = state;
  const next = { ...state, ...partial };
  if (
    next.device === previous.device &&
    next.server === previous.server &&
    next.lastOkAt === previous.lastOkAt &&
    next.serverApiVersion === previous.serverApiVersion
  ) {
    return;
  }
  state = next;
  emit();
  if (!isHealthy(previous) && isHealthy(next)) onReconnect();
}

/** Pure transition: how a device-level signal ("online"/"offline" event,
 * or the native plugin's status) changes device state. Exported for the
 * unit tests' transition table. */
export function nextDeviceState(connected: boolean): DeviceState {
  return connected ? "online" : "offline";
}

/** Pure transition: how one request's outcome changes server state.
 * Exported for the unit tests' transition table. */
export function nextServerState(
  current: ServerState,
  outcome: "ok" | "network-error",
  consecutiveErrors: number
): { server: ServerState; consecutiveErrors: number } {
  if (outcome === "ok") return { server: "ok", consecutiveErrors: 0 };
  const errors = consecutiveErrors + 1;
  return { server: errors >= UNREACHABLE_AFTER ? "unreachable" : current, consecutiveErrors: errors };
}

function stopHealthProbe(): void {
  if (healthProbeTimer !== null) {
    clearInterval(healthProbeTimer);
    healthProbeTimer = null;
  }
}

/** A gateway or proxy answer: the request never reached the app. One rule for probe and apiFetch. */
export function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function probeHealth(): Promise<void> {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  try {
    // A plain fetch, not apiFetch: this must never itself be blocked by
    // assertCanWrite, and it carries no auth by design. Production answers
    // 401 with no health token, which still proves the server is there. A
    // 502/503/504 does not -- unless the app itself sent it (a degraded
    // health check carries the app's version header, a gateway page does
    // not) -- so "Yhteys palautui" is never announced over a dead server.
    const response = await fetch(apiUrl("/api/health"), { credentials: "omit", cache: "no-store" });
    const fromApp = response.headers.get("X-LashKirja-Api-Version") !== null;
    reportRequestOutcome(isGatewayStatus(response.status) && !fromApp ? "network-error" : "ok");
  } catch {
    reportRequestOutcome("network-error");
  }
}

/** "Yritä uudelleen" on the connectivity banner: probe the server now. */
export function retryConnection(): Promise<void> {
  return probeHealth();
}

function startHealthProbe(): void {
  if (healthProbeTimer !== null) return;
  healthProbeTimer = setInterval(() => void probeHealth(), HEALTH_PROBE_INTERVAL_MS);
}

/** Called by clientFetch.ts after every real request attempt. */
export function reportRequestOutcome(outcome: "ok" | "network-error", apiVersion?: number | null): void {
  const result = nextServerState(state.server, outcome, consecutiveNetworkErrors);
  consecutiveNetworkErrors = result.consecutiveErrors;

  setState({
    server: result.server,
    lastOkAt: outcome === "ok" ? Date.now() : state.lastOkAt,
    serverApiVersion: apiVersion != null ? apiVersion : state.serverApiVersion,
  });

  if (result.server === "unreachable") startHealthProbe();
  else stopHealthProbe();
}

/** On the transition back to "ok": the session source refreshes and pages
 * that care can react to the event -- both dispatched here, once, rather
 * than duplicated at every call site that reports an "ok" outcome. */
function onReconnect(): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new Event("lashkirja-reconnected"));
}

/** Repeated online flips (a flapping Wi-Fi) probe at most once per this long. */
const ONLINE_PROBE_DEBOUNCE_MS = 1_000;
let lastOnlineProbeAt = 0;

/**
 * A device-level signal (the browser's online/offline events, the native
 * plugin). Coming back online while the server still counts as unreachable
 * probes at once instead of waiting for the 15 s timer, so the banner and the
 * error card clear when the connection returns (C-8); the probe's own "ok"
 * runs the reconnect refetch.
 */
export function applyDeviceSignal(connected: boolean): void {
  setState({ device: nextDeviceState(connected) });
  if (!connected || state.server !== "unreachable") return;
  const now = Date.now();
  if (now - lastOnlineProbeAt < ONLINE_PROBE_DEBOUNCE_MS) return;
  lastOnlineProbeAt = now;
  void probeHealth();
}

function onWindowOnline(): void {
  applyDeviceSignal(true);
}

function onWindowOffline(): void {
  applyDeviceSignal(false);
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible" && state.server === "unreachable") {
    void probeHealth();
  }
}

async function wireNativeNetwork(): Promise<void> {
  try {
    if (!Capacitor.isNativePlatform()) return;
    const { Network } = await import("@capacitor/network");
    const status = await Network.getStatus();
    setState({ device: nextDeviceState(status.connected) });
    nativeNetworkHandle = await Network.addListener("networkStatusChange", (next) => {
      applyDeviceSignal(next.connected);
    });
  } catch {
    // No native plugin (web, or an IPA built before it was added) --
    // navigator.onLine/online/offline below already cover this case.
  }
}

/** Registers the window/document listeners exactly once, on first
 * subscriber -- mirrors AppLock.tsx's `subscribeView` pattern. */
function wireOnce(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("online", onWindowOnline);
  window.addEventListener("offline", onWindowOffline);
  document.addEventListener("visibilitychange", onVisibilityChange);
  void wireNativeNetwork();
}

function subscribe(listener: () => void): () => void {
  wireOnce();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Connectivity {
  return state;
}

export function useConnectivity(): Connectivity {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only read of the current snapshot -- there is no DOM to render a
 * hook against in the unit tests (state transitions, probe scheduling). */
export function connectivitySnapshotForTests(): Connectivity {
  return state;
}

/** Pure version compare, used by ConnectivityBanner.tsx. `null` (never
 * seen a response yet) is never "newer". */
export function isServerNewer(serverApiVersion: number | null, localVersion: number): boolean {
  return serverApiVersion != null && serverApiVersion > localVersion;
}

export class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineError";
  }
}

const OFFLINE_MESSAGE =
  "Ei verkkoyhteyttä. Tämä toiminto vaatii yhteyden. Yritä uudelleen, kun yhteys palaa.";
const UNREACHABLE_MESSAGE =
  "Palvelimeen ei saada yhteyttä. Tämä toiminto vaatii yhteyden. Yritä hetken kuluttua uudelleen.";

/** Throws before a write even starts -- fail fast instead of a button
 * spinning until the request's own timeout. */
export function assertCanWrite(): void {
  if (state.device === "offline") throw new OfflineError(OFFLINE_MESSAGE);
  if (state.server === "unreachable") throw new OfflineError(UNREACHABLE_MESSAGE);
}

export function setDeviceStateForTests(next: DeviceState): void {
  setState({ device: next });
}

export function resetConnectivityForTests(): void {
  state = { device: initialDeviceState(), server: "ok", lastOkAt: null, serverApiVersion: null };
  consecutiveNetworkErrors = 0;
  lastOnlineProbeAt = 0;
  stopHealthProbe();
  if (wired && typeof window !== "undefined") {
    window.removeEventListener("online", onWindowOnline);
    window.removeEventListener("offline", onWindowOffline);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
  wired = false;
  nativeNetworkHandle?.remove();
  nativeNetworkHandle = null;
  listeners.clear();
}
