import { prisma } from "../db";
import { decrypt, encrypt } from "../encryption";
import {
  EnableBankingClient,
  EnableBankingError,
  findAspsp,
  publicBankError,
  type PsuContext,
  buildPsuHeaders,
  parseRequiredPsuHeaders,
} from "./client";
import { EnableBankingNotConfiguredError } from "./signing";
import {
  authStateMatches,
  consentValidUntil,
  createAuthState,
  hashAuthState,
  isPendingStateFresh,
  psuIdForUser,
} from "./consent";
import { sessionAccountsForStorage, toPublicConnection, type PublicBankConnection } from "./mapping";

const connectionInclude = { accounts: { orderBy: { iban: "asc" as const } } };

export async function listBankConnections(userId: string): Promise<PublicBankConnection[]> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const authorizingCutoff = new Date(Date.now() - 15 * 60 * 1000);
  await prisma.bankConnection.updateMany({
    where: { userId, status: "pending", createdAt: { lt: cutoff } },
    data: { status: "error", lastError: "Yhdistäminen vanheni. Yritä uudelleen." },
  });
  await prisma.bankConnection.updateMany({
    where: { userId, status: "authorizing", updatedAt: { lt: authorizingCutoff } },
    data: { status: "error", lastError: "Yhdistäminen keskeytyi. Yritä uudelleen." },
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
  input: { aspspName: string; aspspCountry: string; psuType: "personal" | "business" },
  client = new EnableBankingClient()
): Promise<{ url: string; connectionId: string }> {
  const aspsps = await client.listAspsps(input.aspspCountry, input.psuType);
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
    data: { status: "error", lastError: "Yhdistäminen korvattiin uudella yrityksellä." },
  });

  const state = createAuthState();
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
    },
  });

  try {
    const started = await client.startAuthorization({
      aspspName: aspsp.name,
      aspspCountry: aspsp.country,
      psuType: input.psuType,
      state,
      validUntil: consentValidUntil(aspsp.maximum_consent_validity ?? 0),
      psuId: psuIdForUser(userId),
    });
    return { url: started.url, connectionId: connection.id };
  } catch (error) {
    const message = error instanceof EnableBankingError ? publicBankError(error).message : "Pankkiyhteys epäonnistui. Yritä uudelleen.";
    await prisma.bankConnection.update({
      where: { id: connection.id },
      data: { status: "error", lastError: message },
    });
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
    const accounts = sessionAccountsForStorage(session.accounts ?? [], userId, pending.id);
    if (accounts.length === 0) {
      throw new EnableBankingError(
        "Pankki ei palauttanut IBAN-tiliä. Yhdistä uudelleen ja valitse tili.",
        422,
        "NO_ACCOUNTS_ADDED"
      );
    }
    const validUntil = session.access?.valid_until ? new Date(session.access.valid_until) : null;
    await prisma.$transaction(async (db) => {
      await db.connectedAccount.createMany({ data: accounts });
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
    const message =
      error instanceof EnableBankingError
        ? error.code === "NO_ACCOUNTS_ADDED"
          ? error.message
          : publicBankError(error).message
        : "Pankkiyhteys epäonnistui. Yritä uudelleen.";
    await prisma.bankConnection.update({
      where: { id: pending.id },
      data: { status: "error", lastError: message },
    });
    throw error;
  }
}

export async function setAccountScope(
  userId: string,
  connectionId: string,
  accounts: Array<{ id: string; inScope: boolean }>
): Promise<PublicBankConnection> {
  const connection = await prisma.bankConnection.findFirst({
    where: { id: connectionId, userId },
    include: connectionInclude,
  });
  if (!connection || connection.status === "revoked") {
    throw new EnableBankingError("Pankkiyhteyttä ei löytynyt.", 404, "NOT_FOUND");
  }
  const allowed = new Set(connection.accounts.map((account) => account.id));
  if (accounts.some((account) => !allowed.has(account.id))) {
    throw new EnableBankingError("Tiliä ei löytynyt tältä yhteydeltä.", 404, "NOT_FOUND");
  }
  await prisma.$transaction(
    accounts.map((account) =>
      prisma.connectedAccount.update({
        where: { id: account.id },
        data: { inScope: account.inScope },
      })
    )
  );
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
      const terminal =
        error instanceof EnableBankingNotConfiguredError ||
        (error instanceof EnableBankingError &&
          (error.status === 404 ||
            error.code === "SESSION_DOES_NOT_EXIST" ||
            error.code === "CLOSED_SESSION" ||
            error.code === "REVOKED_SESSION" ||
            error.code === "EXPIRED_SESSION" ||
            error.code === "PSU_HEADER_NOT_PROVIDED"));
      if (!terminal) {
        console.error("Enable Banking session delete failed", {
          connectionId: connection.id,
          code: error instanceof EnableBankingError ? error.code : "unknown",
          status: error instanceof EnableBankingError ? error.status : undefined,
        });
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
