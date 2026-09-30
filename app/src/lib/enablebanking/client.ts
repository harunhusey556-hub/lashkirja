import type { EbBalance, EbSessionAccount, EbTransaction } from "./mapping";
import {
  loadEnableBankingConfig,
  signEnableBankingJwt,
  type EnableBankingConfig,
} from "./signing";

/**
 * A safety ceiling against a bank that never stops paging, not a limit a real
 * account reaches. A pull that does reach it is reported as truncated, never
 * returned as if it were complete.
 */
export const MAX_TRANSACTION_PAGES = 1000;
const FALLBACK_WINDOWS_DAYS = [365, 90, 30, 7];
const TERMINAL_SESSION = new Set([
  "EXPIRED_SESSION",
  "CLOSED_SESSION",
  "REVOKED_SESSION",
  "SESSION_DOES_NOT_EXIST",
  "WRONG_SESSION_STATUS",
]);

export class EnableBankingError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: unknown;

  constructor(message: string, status: number, code?: string, detail?: unknown) {
    super(message);
    this.name = "EnableBankingError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface EbAspsp {
  name: string;
  country: string;
  logo?: string;
  psu_types?: string[];
  maximum_consent_validity?: number;
  required_psu_headers?: string[];
  beta?: boolean;
}

export interface EbSession {
  session_id: string;
  accounts?: EbSessionAccount[];
  access?: { valid_until?: string };
  aspsp?: { name?: string; country?: string };
  psu_type?: string;
}

export interface PsuContext {
  ipAddress?: string;
  userAgent?: string;
  referer?: string;
  accept?: string;
  acceptCharset?: string;
  acceptEncoding?: string;
  acceptLanguage?: string;
}

export interface TransactionQuery {
  accountUid: string;
  dateFrom?: string;
  dateTo?: string;
  continuationKey?: string;
  strategy?: "default" | "longest";
  psuHeaders?: Record<string, string>;
}

export interface TransactionPageFetcher {
  getAccountTransactions(
    query: TransactionQuery
  ): Promise<{ transactions: EbTransaction[]; continuationKey: string | null }>;
}

const PSU_HEADER_FIELDS: Record<string, keyof PsuContext> = {
  "Psu-Ip-Address": "ipAddress",
  "Psu-User-Agent": "userAgent",
  "Psu-Referer": "referer",
  "Psu-Accept": "accept",
  "Psu-Accept-Charset": "acceptCharset",
  "Psu-Accept-Encoding": "acceptEncoding",
  "Psu-Accept-language": "acceptLanguage",
};

export function psuContextFromHeaders(headers: Headers): PsuContext {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ipAddress: forwarded || headers.get("x-real-ip")?.trim() || "127.0.0.1",
    userAgent: headers.get("user-agent")?.trim() || "LashKirja",
    referer: headers.get("referer")?.trim() || undefined,
    accept: headers.get("accept")?.trim() || undefined,
    acceptCharset: headers.get("accept-charset")?.trim() || undefined,
    acceptEncoding: headers.get("accept-encoding")?.trim() || undefined,
    acceptLanguage: headers.get("accept-language")?.trim() || "fi",
  };
}

export function parseRequiredPsuHeaders(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );
  } catch {
    return [];
  }
}

export function buildPsuHeaders(
  required: string[],
  context: PsuContext | null
): { headers: Record<string, string> } | { missing: string[] } {
  if (!context || required.length === 0) return { headers: {} };
  const headers: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of required) {
    const field = PSU_HEADER_FIELDS[name];
    const value = field ? context[field]?.trim() : undefined;
    if (!value) missing.push(name);
    else headers[name] = value;
  }
  if (missing.length > 0) return { missing };
  return { headers };
}

export function isTerminalSessionError(error: unknown): boolean {
  return error instanceof EnableBankingError && TERMINAL_SESSION.has(error.code || "");
}

export function sessionTerminalStatus(error: unknown): "expired" | "revoked" | null {
  if (!(error instanceof EnableBankingError)) return null;
  if (error.code === "REVOKED_SESSION") return "revoked";
  if (
    error.code === "EXPIRED_SESSION" ||
    error.code === "CLOSED_SESSION" ||
    error.code === "SESSION_DOES_NOT_EXIST" ||
    error.code === "WRONG_SESSION_STATUS"
  ) {
    return "expired";
  }
  return null;
}

export function shouldRetryWithoutStrategy(error: unknown): boolean {
  if (!(error instanceof EnableBankingError)) return false;
  if (isTerminalSessionError(error)) return false;
  if (error.status !== 400 && error.status !== 422) return false;
  if (error.code === "WRONG_TRANSACTIONS_PERIOD") return false;
  const blob = `${error.message} ${JSON.stringify(error.detail ?? "")}`.toLowerCase();
  return error.code === "WRONG_REQUEST_PARAMETERS" || blob.includes("strategy");
}

export function isWrongTransactionsPeriod(error: unknown): boolean {
  return error instanceof EnableBankingError && error.code === "WRONG_TRANSACTIONS_PERIOD";
}

export function publicBankError(error: EnableBankingError): { message: string; status: number } {
  if (sessionTerminalStatus(error)) {
    return { message: "Yhteys vanhentui — yhdistä uudelleen.", status: 409 };
  }
  switch (error.code) {
    case "REDIRECT_URI_NOT_ALLOWED":
      return {
        message:
          "Ohjausosoite ei ole sallittu Enable Bankingissa. Tarkista ENABLEBANKING_REDIRECT_URL Control Panelissa.",
        status: 502,
      };
    case "WRONG_ASPSP_PROVIDED":
      return { message: "Pankkia ei löytynyt. Valitse pankki uudelleen.", status: 400 };
    case "EXPIRED_AUTHORIZATION_CODE":
    case "WRONG_AUTHORIZATION_CODE":
      return { message: "Pankin vahvistus vanheni. Yhdistä uudelleen.", status: 400 };
    case "ACCESS_DENIED":
      return { message: "Pankki ei sallinut yhteyttä.", status: 400 };
    case "ASPSP_RATE_LIMIT_EXCEEDED":
      return { message: "Pankki rajoitti pyyntöjä. Yritä myöhemmin uudelleen.", status: 429 };
    case "INVALID_RESPONSE":
      return { message: "Pankin vastausta ei voitu lukea. Yritä uudelleen.", status: 502 };
    case "STATE_MISMATCH":
      return {
        message: error.message || "Yhteyden vahvistus epäonnistui. Yritä yhdistää uudelleen.",
        status: error.status || 400,
      };
    default:
      break;
  }
  if (error.status === 401 || error.status === 403) {
    return {
      message: "Pankkiyhteyden tunnistautuminen epäonnistui. Tarkista sovelluksen avain ja APP_ID.",
      status: 502,
    };
  }
  if (error.status === 429) {
    return { message: "Pankki rajoitti pyyntöjä. Yritä myöhemmin uudelleen.", status: 429 };
  }
  if (error.status >= 400 && error.status < 500 && /[äöåÄÖÅ]/.test(error.message)) {
    return { message: error.message, status: error.status };
  }
  return { message: "Pankkiyhteys epäonnistui. Yritä uudelleen.", status: 502 };
}

export function findAspsp(
  aspsps: EbAspsp[],
  name: string,
  country: string
): EbAspsp | undefined {
  const wantedName = name.trim();
  const wantedCountry = country.trim().toUpperCase();
  return (
    aspsps.find((aspsp) => aspsp.name === wantedName && aspsp.country.toUpperCase() === wantedCountry) ||
    aspsps.find(
      (aspsp) =>
        aspsp.name.toLowerCase() === wantedName.toLowerCase() &&
        aspsp.country.toUpperCase() === wantedCountry
    )
  );
}

/**
 * `truncated` means the bank still had more to give when the pull stopped. The
 * rows returned are real, but the caller must not treat the account as caught
 * up: the next sync has to read the same window again.
 */
export interface PulledTransactions {
  transactions: EbTransaction[];
  truncated: boolean;
}

export async function collectAccountTransactions(
  fetcher: TransactionPageFetcher,
  params: {
    accountUid: string;
    firstSync: boolean;
    dateFrom?: string;
    /** The owner's "Mistä lähtien" choice for the first sync. */
    historyFrom?: string;
    psuHeaders?: Record<string, string>;
    now?: Date;
  }
): Promise<PulledTransactions> {
  const now = params.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  if (params.firstSync && params.historyFrom) {
    try {
      return await pullPages(fetcher, params, { dateFrom: params.historyFrom, dateTo: today });
    } catch (error) {
      if (isTerminalSessionError(error)) throw error;
      if (!isWrongTransactionsPeriod(error) && !shouldRetryWithoutStrategy(error)) throw error;
    }
  } else if (params.firstSync) {
    try {
      return await pullPages(fetcher, params, { strategy: "longest" });
    } catch (error) {
      if (!shouldRetryWithoutStrategy(error)) throw error;
    }
  } else if (params.dateFrom) {
    try {
      return await pullPages(fetcher, params, { dateFrom: params.dateFrom, dateTo: today });
    } catch (error) {
      if (isTerminalSessionError(error)) throw error;
      if (!isWrongTransactionsPeriod(error) && !shouldRetryWithoutStrategy(error)) throw error;
    }
  }

  let lastError: unknown;
  for (const days of FALLBACK_WINDOWS_DAYS) {
    let dateFrom = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    // Never reach further back than the owner asked for.
    if (params.firstSync && params.historyFrom && dateFrom < params.historyFrom) {
      dateFrom = params.historyFrom;
    }
    try {
      return await pullPages(fetcher, params, { dateFrom, dateTo: today });
    } catch (error) {
      lastError = error;
      if (isTerminalSessionError(error)) throw error;
      if (!isWrongTransactionsPeriod(error)) throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new EnableBankingError("Tapahtumia ei voitu hakea.", 502);
}

async function pullPages(
  fetcher: TransactionPageFetcher,
  params: {
    accountUid: string;
    psuHeaders?: Record<string, string>;
  },
  range: { dateFrom?: string; dateTo?: string; strategy?: "default" | "longest" }
): Promise<PulledTransactions> {
  const transactions: EbTransaction[] = [];
  const seenKeys = new Set<string>();
  let continuationKey: string | undefined;
  for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
    const result = await fetcher.getAccountTransactions({
      accountUid: params.accountUid,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      continuationKey,
      strategy: range.strategy,
      psuHeaders: params.psuHeaders,
    });
    transactions.push(...result.transactions);
    if (!result.continuationKey) return { transactions, truncated: false };
    // A key the bank has already sent would loop for ever: stop, and say so.
    if (seenKeys.has(result.continuationKey)) return { transactions, truncated: true };
    seenKeys.add(result.continuationKey);
    continuationKey = result.continuationKey;
  }
  return { transactions, truncated: true };
}

export class EnableBankingClient {
  constructor(private readonly config: EnableBankingConfig = loadEnableBankingConfig()) {}

  async listAspsps(country = "FI", psuType?: string): Promise<EbAspsp[]> {
    const query = new URLSearchParams({ country, service: "AIS" });
    if (psuType) query.set("psu_type", psuType);
    const body = await this.request<{ aspsps?: EbAspsp[] }>(`/aspsps?${query.toString()}`);
    return body.aspsps ?? [];
  }

  async startAuthorization(input: {
    aspspName: string;
    aspspCountry: string;
    psuType: "personal" | "business";
    state: string;
    validUntil: string;
    psuId: string;
  }): Promise<{ url: string }> {
    const body = await this.request<{ url?: string }>("/auth", {
      method: "POST",
      body: JSON.stringify({
        access: {
          balances: true,
          transactions: true,
          valid_until: input.validUntil,
        },
        aspsp: { name: input.aspspName, country: input.aspspCountry },
        state: input.state,
        redirect_url: this.config.redirectUrl,
        psu_type: input.psuType,
        language: "fi",
        psu_id: input.psuId,
      }),
    });
    return { url: assertHttpsRedirect(body.url) };
  }

  async authorizeSession(code: string): Promise<EbSession> {
    return this.request<EbSession>("/sessions", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  }

  async getAccountTransactions(
    query: TransactionQuery
  ): Promise<{ transactions: EbTransaction[]; continuationKey: string | null }> {
    const params = new URLSearchParams();
    if (query.dateFrom) params.set("date_from", query.dateFrom);
    if (query.dateTo) params.set("date_to", query.dateTo);
    if (query.continuationKey) params.set("continuation_key", query.continuationKey);
    if (query.strategy) params.set("strategy", query.strategy);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.request<{
      transactions?: EbTransaction[];
      continuation_key?: string | null;
    }>(`/accounts/${encodeURIComponent(query.accountUid)}/transactions${suffix}`, {
      psuHeaders: query.psuHeaders,
    });
    // A real page always carries the array, empty or not. Anything else is a
    // broken answer, and reading it as "no rows, no more pages" would end the
    // pull quietly and let the sync report success.
    const key = body.continuation_key;
    if (!Array.isArray(body.transactions) || (key != null && typeof key !== "string")) {
      throw invalidResponse();
    }
    return {
      transactions: body.transactions,
      continuationKey: key || null,
    };
  }

  async getAccountBalances(
    accountUid: string,
    psuHeaders?: Record<string, string>
  ): Promise<EbBalance[]> {
    const body = await this.request<{ balances?: EbBalance[] }>(
      `/accounts/${encodeURIComponent(accountUid)}/balances`,
      { psuHeaders }
    );
    return body.balances ?? [];
  }

  async getSession(sessionId: string): Promise<{ status?: string }> {
    return this.request<{ status?: string }>(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  async deleteSession(sessionId: string, psuHeaders?: Record<string, string>): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      psuHeaders,
    });
  }

  private async request<T>(
    path: string,
    init: RequestInit & { psuHeaders?: Record<string, string> } = {}
  ): Promise<T> {
    const { psuHeaders, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set(
      "Authorization",
      `Bearer ${signEnableBankingJwt(this.config.privateKeyPem, this.config.appId)}`
    );
    headers.set("Accept", "application/json");
    if (rest.body) headers.set("Content-Type", "application/json");
    if (psuHeaders) {
      for (const [name, value] of Object.entries(psuHeaders)) headers.set(name, value);
    }

    const response = await fetch(`${this.config.apiBase}${path}`, {
      ...rest,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    const json = text ? parseJson(text) : null;
    if (response.ok && (text ? json === null : response.status !== 204 && rest.method !== "DELETE")) {
      // Fail closed: a 200 whose body is truncated, HTML, empty or not an
      // object is a failed call, never an empty successful one.
      throw invalidResponse();
    }
    if (!response.ok) {
      const code = typeof json?.error === "string" ? json.error : undefined;
      const message =
        typeof json?.message === "string" && json.message.trim()
          ? json.message
          : "Enable Banking -pyyntö epäonnistui";
      throw new EnableBankingError(message, response.status, code, json?.detail);
    }
    return (json ?? {}) as T;
  }
}

function invalidResponse(): EnableBankingError {
  return new EnableBankingError("Pankin vastausta ei voitu lukea.", 502, "INVALID_RESPONSE");
}

function assertHttpsRedirect(url: string | undefined): string {
  if (!url) {
    throw new EnableBankingError("Pankki ei palauttanut ohjausosoitetta.", 502);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EnableBankingError("Pankin ohjausosoite on virheellinen.", 502);
  }
  if (parsed.protocol !== "https:") {
    throw new EnableBankingError("Pankin ohjausosoite ei ole suojattu.", 502);
  }
  return parsed.toString();
}

function parseJson(text: string): { message?: string; error?: string; detail?: unknown } | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object") return null;
    return value as { message?: string; error?: string; detail?: unknown };
  } catch {
    return null;
  }
}
