import { prisma } from "../db";
import { decrypt, encrypt } from "../encryption";
import {
  EnableBankingClient,
  EnableBankingError,
  findAspsp,
  type PsuContext,
  buildPsuHeaders,
  parseRequiredPsuHeaders,
} from "./client";
import {
  authStateMatches,
  consentValidUntil,
  createAuthState,
  hashAuthState,
  isPendingStateFresh,
  psuIdForUser,
} from "./consent";
import { describeSessionAccounts, sessionAccountsForStorage, toPublicConnection, type EbSessionAccount, type PublicBankConnection } from "./mapping";
import { CONSENT_REVOKED_MESSAGE } from "../bank-consent-copy";

const connectionInclude = { accounts: { orderBy: { iban: "asc" as const } } };

/**
 * "revoked" is the owner's own Katkaise and, with nothing else set, a hidden
 * tombstone. It is also where an attempt that never became a connection goes,
 * and a connection that a newer one replaced: neither is something the owner
 * has to confirm again. A bank that ends a consent is "expired" (it must be
 * confirmed again) and stays visible.
 */
const RETIRED = { status: "revoked", sessionIdEnc: null, authStateHash: null, lastError: null } as const;

export async function listBankConnections(userId: string): Promise<PublicBankConnection[]> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const authorizingCutoff = new Date(Date.now() - 15 * 60 * 1000);
  await prisma.bankConnection.updateMany({
    where: { userId, status: "pending", createdAt: { lt: cutoff } },
    data: RETIRED,
  });
  await prisma.bankConnection.updateMany({
    where: { userId, status: "authorizing", updatedAt: { lt: authorizingCutoff } },
    data: RETIRED,
  });
  // Earlier versions kept a failed attempt (no session was ever made) as an
  // "error" card, and hid a consent the bank had withdrawn. A withdrawn consent
  // is told as such; the failed attempts are gone.
  await prisma.bankConnection.updateMany({
    where: { userId, status: "error", sessionIdEnc: null },
    data: RETIRED,
  });
  await prisma.bankConnection.updateMany({
    where: { userId, status: "revoked", lastError: { not: null } },
    data: { status: "expired", lastError: CONSENT_REVOKED_MESSAGE },
  });
  const rows = await prisma.bankConnection.findMany({
    where: { userId, status: { not: "revoked" } },
    include: connectionInclude,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toPublicConnection);
}

export async function startBankConsent(
  userId: string,
  input: {
    aspspName: string;
    aspspCountry: string;
    psuType: "personal" | "business";
    client?: "web" | "app";
    historyFrom?: string;
  },
  ebClient = new EnableBankingClient()
): Promise<{ url: string; connectionId: string }> {
  const aspsps = await ebClient.listAspsps(input.aspspCountry, input.psuType);
  const aspsp = findAspsp(aspsps, input.aspspName, input.aspspCountry);
  if (!aspsp) {
    throw new EnableBankingError("Pankkia ei löytynyt. Valitse pankki uudelleen.", 400, "WRONG_ASPSP_PROVIDED");
  }
  if (aspsp.psu_types && !aspsp.psu_types.includes(input.psuType)) {
    throw new EnableBankingError(
      "Pankki ei tue valittua asiakastyyppiä. Valitse henkilö- tai yritystili.",
      400,
      "WRONG_REQUEST_PARAMETERS"
    );
  }

  await prisma.bankConnection.updateMany({
    where: {
      userId,
      aspspName: aspsp.name,
      aspspCountry: aspsp.country,
      psuType: input.psuType,
      status: { in: ["pending", "authorizing"] },
    },
    data: RETIRED,
  });

  const state = createAuthState(input.client);
  const connection = await prisma.bankConnection.create({
    data: {
      userId,
      aspspName: aspsp.name,
      aspspCountry: aspsp.country,
      aspspLogo: aspsp.logo || null,
      psuType: input.psuType,
      status: "pending",
      authStateHash: hashAuthState(state),
      requiredPsuHeaders: JSON.stringify(aspsp.required_psu_headers ?? []),
      historyFrom: input.historyFrom ?? null,
    },
  });

  try {
    const started = await ebClient.startAuthorization({
      aspspName: aspsp.name,
      aspspCountry: aspsp.country,
      psuType: input.psuType,
      state,
      validUntil: consentValidUntil(aspsp.maximum_consent_validity ?? 0),
      psuId: psuIdForUser(userId),
    });
    return { url: started.url, connectionId: connection.id };
  } catch (error) {
    // No session was made: the attempt is not a connection, so nothing is left
    // that asks the owner to confirm it again. The caller answers with the reason.
    await prisma.bankConnection.update({ where: { id: connection.id }, data: RETIRED });
    throw error;
  }
}

export async function completeBankConsent(
  userId: string,
  code: string,
  state: string,
  client = new EnableBankingClient()
): Promise<PublicBankConnection> {
  const hash = hashAuthState(state);
  const pending = await prisma.bankConnection.findFirst({
    where: { userId, authStateHash: hash },
    include: connectionInclude,
  });
  if (!pending || !authStateMatches(pending.authStateHash, state)) {
    throw new EnableBankingError(
      "Yhteyden vahvistus epäonnistui. Yritä yhdistää uudelleen.",
      400,
      "STATE_MISMATCH"
    );
  }
  if (pending.status === "active") return toPublicConnection(pending);
  if (pending.status === "authorizing") {
    const settled = await waitUntilSettled(pending.id);
    if (settled?.status === "active") return toPublicConnection(settled);
    throw new EnableBankingError(
      settled?.lastError || "Yhteyden vahvistus epäonnistui. Yritä yhdistää uudelleen.",
      409,
      "STATE_MISMATCH"
    );
  }
  if (pending.status !== "pending" || !isPendingStateFresh(pending.createdAt)) {
    throw new EnableBankingError("Yhdistäminen vanheni. Yritä uudelleen.", 400, "STATE_MISMATCH");
  }

  const claimed = await prisma.bankConnection.updateMany({
    where: { id: pending.id, userId, status: "pending" },
    data: { status: "authorizing", lastError: null },
  });
  if (claimed.count === 0) {
    const settled = await waitUntilSettled(pending.id);
    if (settled?.status === "active") return toPublicConnection(settled);
    throw new EnableBankingError(
      settled?.lastError || "Yhteyden vahvistus epäonnistui. Yritä yhdistää uudelleen.",
      409,
      "STATE_MISMATCH"
    );
  }

  try {
    const session = await client.authorizeSession(code);
    if (!session.session_id) {
      throw new EnableBankingError("Pankki ei palauttanut istuntoa.", 502);
    }
    let sessionAccounts = session.accounts ?? [];
    if (sessionAccounts.length === 0) {
      // Holvi (2026-10-09) authorizes with an empty account list; the session itself names the
      // accounts, and each one's details carry the IBAN.
      sessionAccounts = await accountsFromSession(client, session.session_id);
    }
    const accounts = sessionAccountsForStorage(sessionAccounts, userId, pending.id);
    if (accounts.length === 0) {
      console.warn(
        `Bank consent ${pending.aspspName}: no account with an IBAN. accounts=${describeSessionAccounts(sessionAccounts)}`
      );
      throw new EnableBankingError(
        "Pankki ei palauttanut IBAN-tiliä. Yhdistä uudelleen ja valitse tili.",
        422,
        "NO_ACCOUNTS_ADDED"
      );
    }
    const validUntil = session.access?.valid_until ? new Date(session.access.valid_until) : null;
    await prisma.$transaction(async (db) => {
      // A reconnect replaces what it renews: the earlier connection of the same
      // bank that stopped working is retired, and the accounts the owner had
      // chosen stay chosen. Done only now that the new session is really there,
      // so a reconnect that fails leaves the old card to try again.
      const earlier = await db.bankConnection.findMany({
        where: {
          userId,
          id: { not: pending.id },
          aspspName: pending.aspspName,
          aspspCountry: pending.aspspCountry,
          psuType: pending.psuType,
          status: { in: ["expired", "error"] },
        },
        include: { accounts: true },
      });
      const chosen = new Set(earlier.flatMap((old) => old.accounts.filter((a) => a.inScope).map((a) => a.iban)));
      await db.connectedAccount.createMany({
        data: accounts.map((account) => ({ ...account, inScope: chosen.has(account.iban) })),
      });
      if (earlier.length > 0) {
        await db.bankConnection.updateMany({ where: { id: { in: earlier.map((old) => old.id) } }, data: RETIRED });
      }
      await db.bankConnection.update({
        where: { id: pending.id },
        data: {
          status: "active",
          sessionIdEnc: encrypt(session.session_id),
          validUntil: validUntil && Number.isFinite(validUntil.getTime()) ? validUntil : null,
          lastError: null,
        },
      });
    });
    const ready = await prisma.bankConnection.findUniqueOrThrow({
      where: { id: pending.id },
      include: connectionInclude,
    });
    return toPublicConnection(ready);
  } catch (error) {
    // Nothing was connected: the attempt leaves no card behind (the caller
    // answers with the reason), and an earlier expired connection stays.
    await prisma.bankConnection.update({ where: { id: pending.id }, data: RETIRED });
    throw error;
  }
}

/** The session's accounts read one by one: GET /sessions/{id} lists their uids, /details the rest. */
async function accountsFromSession(client: EnableBankingClient, sessionId: string): Promise<EbSessionAccount[]> {
  const uids = ((await client.getSession(sessionId)).accounts ?? []).filter((uid) => typeof uid === "string" && uid.trim());
  console.warn(`Bank consent: authorize listed no accounts; the session lists ${uids.length}`);
  const accounts: EbSessionAccount[] = [];
  for (const uid of uids.slice(0, 20)) {
    const details = await client.getAccountDetails(uid);
    accounts.push({ ...details, uid: details.uid?.trim() || uid });
  }
  return accounts;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a real calendar day written "YYYY-MM-DD". */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** "13 kuukauden", or days for a limit shorter than two months. */
function historyLimitText(days: number): string {
  const months = Math.round(days / 30.44);
  return months >= 2 ? `${months} kuukauden` : `${days} päivän`;
}

/**
 * Why the bank cannot give history from `day`, in one Finnish sentence, or
 * null when it can (as far as is known). Today counts in UTC, as the sync does.
 */
export function historyFromProblem(day: string, limitDays: number | null, now = new Date()): string | null {
  if (!isCalendarDay(day)) return "Tarkista alkupäivä.";
  const today = now.toISOString().slice(0, 10);
  if (day > today) return "Alkupäivä ei voi olla tulevaisuudessa.";
  if (limitDays != null && limitDays > 0) {
    const oldest = new Date(now.getTime() - limitDays * DAY_MS).toISOString().slice(0, 10);
    if (day < oldest) return `Pankki antaa tapahtumat enintään ${historyLimitText(limitDays)} ajalta.`;
  }
  return null;
}

/**
 * The owner's choices on a connection: which accounts are in the books and
 * from which day history is fetched. Everything is checked before anything is
 * written, so a refused day leaves the account choices as they were too.
 *
 * An earlier day than before is fetched by the next sync (only the window the
 * accounts still lack). A later day deletes nothing; it only moves where an
 * account added later starts.
 */
export async function updateBankConnection(
  userId: string,
  connectionId: string,
  input: { accounts?: Array<{ id: string; inScope: boolean }>; historyFrom?: string }
): Promise<PublicBankConnection> {
  const connection = await prisma.bankConnection.findFirst({
    where: { id: connectionId, userId },
    include: connectionInclude,
  });
  if (!connection || connection.status === "revoked") {
    throw new EnableBankingError("Pankkiyhteyttä ei löytynyt.", 404, "NOT_FOUND");
  }
  const accounts = input.accounts ?? [];
  const allowed = new Set(connection.accounts.map((account) => account.id));
  if (accounts.some((account) => !allowed.has(account.id))) {
    throw new EnableBankingError("Tiliä ei löytynyt tältä yhteydeltä.", 404, "NOT_FOUND");
  }
  if (input.historyFrom !== undefined) {
    const problem = historyFromProblem(input.historyFrom, connection.historyLimitDays);
    if (problem) throw new EnableBankingError(problem, 400, "INVALID_HISTORY_FROM");
  }
  await prisma.$transaction([
    ...accounts.map((account) =>
      prisma.connectedAccount.update({
        where: { id: account.id },
        data: { inScope: account.inScope },
      })
    ),
    ...(input.historyFrom !== undefined
      ? [prisma.bankConnection.update({ where: { id: connection.id }, data: { historyFrom: input.historyFrom } })]
      : []),
  ]);
  const fresh = await prisma.bankConnection.findUniqueOrThrow({
    where: { id: connection.id },
    include: connectionInclude,
  });
  return toPublicConnection(fresh);
}

export async function revokeBankConnection(
  userId: string,
  connectionId: string,
  context: PsuContext | null,
  client?: EnableBankingClient
): Promise<void> {
  const connection = await prisma.bankConnection.findFirst({
    where: { id: connectionId, userId },
  });
  if (!connection) {
    throw new EnableBankingError("Pankkiyhteyttä ei löytynyt.", 404, "NOT_FOUND");
  }
  if (connection.sessionIdEnc && connection.status !== "revoked") {
    try {
      const headers = attendedHeaders(connection.requiredPsuHeaders, context);
      const api = client ?? new EnableBankingClient();
      await api.deleteSession(decrypt(connection.sessionIdEnc), headers);
    } catch (error) {
      // Only a session the bank no longer holds counts as closed. Anything else
      // (the bank did not answer, refused, is not reachable from here) is not
      // proof, so the connection stays as it is, with its session, and the
      // owner is told it was not disconnected and can try again.
      const closedAlready =
        error instanceof EnableBankingError &&
        (error.status === 404 ||
          error.code === "SESSION_DOES_NOT_EXIST" ||
          error.code === "CLOSED_SESSION" ||
          error.code === "REVOKED_SESSION" ||
          error.code === "EXPIRED_SESSION");
      if (!closedAlready) {
        if (error instanceof EnableBankingError && error.code === "PSU_HEADER_NOT_PROVIDED") throw error;
        console.error("Enable Banking session delete failed", {
          connectionId: connection.id,
          code: error instanceof EnableBankingError ? error.code : "unknown",
          status: error instanceof EnableBankingError ? error.status : undefined,
        });
        throw new EnableBankingError(
          "Pankkia ei tavoitettu, joten yhteyttä ei katkaistu. Yritä hetken päästä uudelleen.",
          424,
          "REVOKE_FAILED"
        );
      }
    }
  }
  await prisma.bankConnection.update({
    where: { id: connection.id },
    data: {
      status: "revoked",
      sessionIdEnc: null,
      authStateHash: null,
      lastError: null,
    },
  });
}

export function attendedHeaders(
  requiredPsuHeaders: string | null,
  context: PsuContext | null
): Record<string, string> | undefined {
  if (!context) return undefined;
  const required = parseRequiredPsuHeaders(requiredPsuHeaders);
  const built = buildPsuHeaders(required, context);
  if ("missing" in built) {
    throw new EnableBankingError(
      "Pankki vaatii lisätietoja selaimesta. Avaa synkronointi kirjautuneena.",
      422,
      "PSU_HEADER_NOT_PROVIDED"
    );
  }
  return Object.keys(built.headers).length > 0 ? built.headers : undefined;
}


async function waitUntilSettled(id: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = await prisma.bankConnection.findUnique({
      where: { id },
      include: connectionInclude,
    });
    if (!row) return null;
    if (row.status === "active" || row.status === "error" || row.status === "revoked" || row.status === "expired") {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return prisma.bankConnection.findUnique({ where: { id }, include: connectionInclude });
}
