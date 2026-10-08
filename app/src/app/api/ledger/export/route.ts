import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { ledgerYear, ledgerYearSchema } from "@/lib/ledger/period";
import { ACCOUNTS_BY_CODE } from "@/lib/ledger/chart";

/**
 * GET /api/ledger/export?year=2026&report=paivakirja|saldoluettelo — CSV for the
 * accountant: semicolon-separated, decimal comma and a BOM, so Excel in Finnish
 * opens it as columns.
 */

const reportSchema = z.enum(["paivakirja", "saldoluettelo"]);

const euros = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
const cell = (value: string | number) => {
  const text = String(value);
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const row = (cells: Array<string | number>) => cells.map(cell).join(";");

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const params = req.nextUrl.searchParams;
  const year = ledgerYearSchema.parse(params.get("year") ?? new Date().getUTCFullYear());
  const report = reportSchema.parse(params.get("report") ?? "paivakirja");
  const books = await ledgerYear(session.userId!, year);

  const lines: string[] = [];
  if (report === "paivakirja") {
    lines.push(row(["Tosite", "Päivä", "Selite", "Tili", "Tilin nimi", "Debet", "Kredit", "Lähde"]));
    for (const entry of books.journal) {
      for (const line of entry.lines) {
        lines.push(
          row([
            entry.voucher,
            entry.date,
            entry.description,
            line.account,
            ACCOUNTS_BY_CODE.get(line.account)?.name ?? "",
            line.debitCents ? euros(line.debitCents) : "",
            line.creditCents ? euros(line.creditCents) : "",
            entry.id,
          ])
        );
      }
    }
  } else {
    lines.push(row(["Tili", "Tilin nimi", "Debet", "Kredit", "Saldo"]));
    for (const account of books.trialBalance) {
      lines.push(row([account.code, account.name, euros(account.debitCents), euros(account.creditCents), euros(account.balanceCents)]));
    }
  }

  return new NextResponse(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${report}-${year}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
