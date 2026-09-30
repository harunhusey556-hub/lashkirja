"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { readPageCache } from "@/lib/page-cache";
import { chooseDocuments, isNativeShell } from "@/lib/native-pick";
import { STATEMENT_FILE_TYPES } from "@/lib/pending-capture";

export interface BankAccountOption {
  id: string;
  name: string;
  bankName: string | null;
  isDefault: boolean;
}

export interface UploadResult {
  count: number;
  statementId: string | null;
}

/**
 * Importing a tiliote file: the account picker's options, the native or web
 * file picker, and the upload itself. Shared by the Pankki screen (the Lisää
 * sheet hand-off) and Pankkiyhteys ja tilit (the import section).
 */
export function useStatementUpload({ onUploaded }: { onUploaded: (result: UploadResult) => void }) {
  const [accounts, setAccounts] = useState<BankAccountOption[]>(
    () => readPageCache<{ accounts?: BankAccountOption[] }>("bank-overview")?.accounts ?? []
  );
  const [targetAccountId, setTargetAccountId] = useState(
    () =>
      (readPageCache<{ accounts?: BankAccountOption[] }>("bank-overview")?.accounts ?? []).find((a) => a.isDefault)?.id ||
      ""
  );
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/bank-accounts", { credentials: "include" })
      .then((res) => readJson<{ accounts?: BankAccountOption[] }>(res, ""))
      .then((data) => {
        if (cancelled) return;
        const list = data.accounts || [];
        setAccounts(list);
        // Keep what is already picked; only fill the default in when empty.
        setTargetAccountId((current) =>
          current && list.some((a) => a.id === current) ? current : list.find((a) => a.isDefault)?.id || ""
        );
      })
      // The picker is a convenience; the upload still works without it.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function upload(file: File) {
    setUploading(true);
    setMessage({ tone: "info", text: "Käsitellään tiliotetta…" });
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (targetAccountId) fd.append("bankAccountId", targetAccountId);
      const res = await apiFetch("/api/statements", { method: "POST", body: fd, timeoutMs: 120_000 });
      const data = await readJson<{ count: number; statement?: { id?: string } }>(res, "Tiliotteen käsittely epäonnistui");
      setMessage(null);
      onUploaded({ count: data.count, statementId: data.statement?.id ?? null });
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setMessage({ tone: "error", text: errorMessage(error, "Tiliotteen tuonti epäonnistui. Yritä uudelleen.") });
    } finally {
      setUploading(false);
    }
  }

  async function pick() {
    if (!isNativeShell()) {
      inputRef.current?.click();
      return;
    }
    const picked = await chooseDocuments(STATEMENT_FILE_TYPES);
    if (picked.kind === "unavailable") {
      inputRef.current?.click();
      return;
    }
    if (picked.kind === "denied") {
      setMessage({ tone: "error", text: picked.message });
      return;
    }
    const file = picked.kind === "files" ? picked.files[0] : null;
    if (file) void upload(file);
  }

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept=".pdf,.xml,.xlsx,.xls,.csv"
      aria-label="Valitse tiliote"
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void upload(f);
        e.currentTarget.value = "";
      }}
    />
  );

  return { accounts, targetAccountId, setTargetAccountId, uploading, message, upload, pick, input };
}
