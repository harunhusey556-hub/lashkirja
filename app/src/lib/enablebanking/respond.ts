import { ZodError } from "zod";
import { noStoreJson } from "@/lib/http-security";
import { EnableBankingError, publicBankError } from "./client";
import { EnableBankingNotConfiguredError } from "./signing";
import { BANK_NOT_CONFIGURED_MESSAGE, logBankSetupGap } from "./public-status";

export function respondToBankError(error: unknown) {
  if (error instanceof ZodError) {
    return noStoreJson({ error: "Tarkista pankin tiedot." }, { status: 400 });
  }
  if (error instanceof EnableBankingNotConfiguredError) {
    // The error text can name settings; the client gets plain Finnish (L5).
    // Logged once per distinct reason, not on every request.
    logBankSetupGap({ enabled: true, ready: false, message: error.message });
    return noStoreJson({ error: BANK_NOT_CONFIGURED_MESSAGE }, { status: 503 });
  }
  if (error instanceof EnableBankingError) {
    if (error.code === "NOT_FOUND") {
      return noStoreJson({ error: error.message }, { status: 404 });
    }
    if (
      error.code === "NO_ACCOUNTS_ADDED" ||
      error.code === "PSU_HEADER_NOT_PROVIDED" ||
      error.code === "REVOKE_FAILED" ||
      error.code === "INVALID_HISTORY_FROM"
    ) {
      return noStoreJson({ error: error.message }, { status: error.status });
    }
    const mapped = publicBankError(error);
    // The app itself answered, with a sentence of its own. A 502/503/504 would be
    // read by the client as a dead gateway ("Palvelin ei vastannut hetkeen,
    // tarkista onnistuiko toiminto") and replace that sentence.
    const status = mapped.status >= 502 && mapped.status <= 504 ? 500 : mapped.status;
    return noStoreJson({ error: mapped.message }, { status });
  }
  console.error("Bank route failed", error instanceof Error ? error.name : "unknown");
  return noStoreJson({ error: "Pankkiyhteys epäonnistui. Yritä uudelleen." }, { status: 500 });
}
