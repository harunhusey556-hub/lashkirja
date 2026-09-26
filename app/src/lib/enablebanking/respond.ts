import { ZodError } from "zod";
import { noStoreJson } from "@/lib/http-security";
import { EnableBankingError, publicBankError } from "./client";
import { EnableBankingNotConfiguredError } from "./signing";

export function respondToBankError(error: unknown) {
  if (error instanceof ZodError) {
    return noStoreJson({ error: "Tarkista pankin tiedot." }, { status: 400 });
  }
  if (error instanceof EnableBankingNotConfiguredError) {
    return noStoreJson({ error: error.message }, { status: 503 });
  }
  if (error instanceof EnableBankingError) {
    if (error.code === "NOT_FOUND") {
      return noStoreJson({ error: error.message }, { status: 404 });
    }
    if (error.code === "NO_ACCOUNTS_ADDED" || error.code === "PSU_HEADER_NOT_PROVIDED") {
      return noStoreJson({ error: error.message }, { status: error.status });
    }
    const mapped = publicBankError(error);
    return noStoreJson({ error: mapped.message }, { status: mapped.status });
  }
  console.error("Bank route failed", error instanceof Error ? error.name : "unknown");
  return noStoreJson({ error: "Pankkiyhteys epäonnistui. Yritä uudelleen." }, { status: 500 });
}
