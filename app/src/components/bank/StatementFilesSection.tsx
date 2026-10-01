"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { Button, controlClass } from "@/components/ui";
import { ListRow, Section, StatusTag } from "@/components/ds";
import { formatEurSigned } from "@/lib/format";
import { statementTitle } from "@/lib/display-titles";
import { formatMonth, type StatementData } from "@/lib/statement-client";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { showToast } from "@/lib/toast";
import { detailHref } from "@/lib/routes";
import { useStatementUpload } from "./useStatementUpload";
import { tintedButtonClass } from "@/components/control-styles";

const RECENT_LIMIT = 6;

/**
 * Tiliote files, for the owner who imports files or needs to open one:
 * the import button and the files, newest month first. Everyday bank work
 * happens on the Pankki screen's row list, not here.
 */
export function StatementFilesSection() {
  const router = useRouter();
  const [statements, setStatements] = useState<StatementData[] | null>(
    () => readPageCache<StatementData[]>("statements") ?? null
  );
  const [showAll, setShowAll] = useState(false);
  const uploader = useStatementUpload({
    onUploaded: ({ statementId, notice }) => {
      if (notice) showToast({ tone: "info", text: notice });
      if (statementId) router.push(detailHref("statement", statementId));
    },
  });

  useEffect(() => {
    const controller = new AbortController();
    apiFetch("/api/statements", { signal: controller.signal })
      .then((res) => readJson<{ statements?: StatementData[] }>(res, ""))
      .then((data) => {
        if (controller.signal.aborted) return;
        writePageCache("statements", data.statements || []);
        setStatements(data.statements || []);
      })
      .catch((error: unknown) => {
        if (isUnauthorized(error)) redirectToLogin();
      });
    return () => controller.abort();
  }, []);

  const list = statements ?? [];
  const visible = showAll ? list : list.slice(0, RECENT_LIMIT);

  return (
    <div id="tiliotteet" className="scroll-mt-4">
    <Section title="Tiliotteet">
      <div className="space-y-3 px-4 py-4">
        <p className="text-caption text-ink-2">
          Tuo tiliote tiedostona (PDF, XML, XLSX tai CSV), jos pankkia ei ole yhdistetty tai tarvitset vanhempia
          tapahtumia.
        </p>
        {uploader.accounts.length > 0 && (
          <div>
            <label htmlFor="statement-target-account" className="mb-1.5 block text-caption font-normal text-ink-2">
              Pankkitili
            </label>
            <select
              id="statement-target-account"
              value={uploader.targetAccountId}
              onChange={(e) => uploader.setTargetAccountId(e.target.value)}
              className={controlClass}
            >
              <option value="">Tunnista automaattisesti</option>
              {uploader.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                  {account.bankName ? ` · ${account.bankName}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          busy={uploader.uploading}
          busyLabel="Käsitellään…"
          onClick={() => void uploader.pick()}
        >
          Tuo tiliote
        </Button>
        {uploader.input}
        {uploader.message && (
          <p
            className={`text-caption ${uploader.message.tone === "error" ? "text-danger" : "text-ink-2"}`}
            role={uploader.message.tone === "error" ? "alert" : "status"}
          >
            {uploader.message.text}
          </p>
        )}
      </div>
      {visible.map((statement) => {
        const secondary = [
          formatMonth(statement.periodMonth),
          statement.bankAccount?.name,
          `${statement.totals.txCount} tapahtumaa`,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <ListRow
            key={statement.id}
            href={detailHref("statement", statement.id)}
            title={statementTitle(statement)}
            secondary={secondary}
            amount={formatEurSigned(statement.totals.net)}
            amountTone={statement.totals.net >= 0 ? "positive" : "default"}
            trailing={statement.fileType === "enablebanking" ? <StatusTag tone="neutral">Pankki</StatusTag> : undefined}
          />
        );
      })}
      {list.length > RECENT_LIMIT && (
        <div className="px-4 py-3">
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            className={tintedButtonClass("accent", "w-full")}
          >
            {showAll ? "Näytä vähemmän" : `Näytä kaikki (${list.length})`}
          </button>
        </div>
      )}
    </Section>
    </div>
  );
}
