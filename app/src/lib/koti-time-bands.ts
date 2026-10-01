/**
 * Which period each Koti overview card belongs to.
 *
 * The month header picks one month. A VAT deadline and an open previous
 * month are other periods, so they sit in their own bands above it — never
 * as rows inside that month's card. Order among past bands follows the
 * deadline, not the fetch: a due date this month (or already passed) comes
 * before an open previous month, and a later deadline comes after it.
 * Filing state only softens the caption. It does not move the card, so the
 * layout does not jump when the ALV figures arrive.
 */

import { MONTHS } from "./finnish-months";

export interface KotiVatBandInput {
  /** "2026-08", "2026-Q3" or "2026". */
  periodKey: string;
  /** Statutory due date, YYYY-MM-DD. */
  dueIso: string;
  /**
   * True once the return is filed and nothing remains to pay, or the payment
   * is recorded. Null while the figures are still loading.
   */
  settled: boolean | null;
}

export interface KotiTimeBandInput {
  /** The month the header shows, YYYY-MM. */
  selectedMonth: string;
  /** The month shown is the current one. A past month keeps its own close link. */
  atCurrent: boolean;
  /** Today in Helsinki, YYYY-MM-DD. */
  today: string;
  /** Last month, until it is closed. Ignored when the header is on a past month. */
  previousMonth: { month: string; open: number } | null;
  vat: KotiVatBandInput | null;
}

export interface KotiPreviousClose {
  month: string;
  monthName: string;
  /** "28 asiaa kesken" or "Valmis suljettavaksi". The month name is the caption. */
  title: string;
}

export interface KotiTimeBand {
  id: string;
  /** Null when the page title already names the only card. */
  caption: string | null;
  captionTone: "default" | "warning";
  /** The shared ALV row. */
  vat: boolean;
  /** The open previous month, until it is closed. */
  previousClose: KotiPreviousClose | null;
  /** The month the header shows: headline, progress and tiliote live here. */
  selected: boolean;
  /** A past month being viewed: its own "Kuukauden sulkeminen" link. */
  selectedClose: boolean;
  /** VAT and previous-close rows, most urgent first. Empty on the selected month. */
  rows: Array<"vat" | "close">;
}

function monthName(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  return MONTHS[index] || month;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** 0 overdue, 10 due this month, 30 due later. */
function vatRank(dueIso: string, today: string): number {
  if (dueIso < today) return 0;
  if (dueIso.slice(0, 7) === today.slice(0, 7)) return 10;
  return 30;
}

function vatCaption(
  dueIso: string,
  today: string,
  settled: boolean | null
): { caption: string; captionTone: "default" | "warning" } {
  if (settled === true) return { caption: "ALV-ilmoitus", captionTone: "default" };
  if (dueIso < today) return { caption: "ALV myöhässä", captionTone: "warning" };
  if (dueIso.slice(0, 7) === today.slice(0, 7)) return { caption: "ALV erääntyy", captionTone: "default" };
  return { caption: "ALV-ilmoitus", captionTone: "default" };
}

/** A calendar month shares a band with that month's close. A quarter or a year does not. */
function vatGroupId(periodKey: string): string {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey) ? `month:${periodKey}` : `vat:${periodKey}`;
}

interface Piece {
  kind: "vat" | "close";
  groupId: string;
  rank: number;
  caption: string;
  captionTone: "default" | "warning";
  close?: KotiPreviousClose;
}

export function kotiTimeBands(input: KotiTimeBandInput): KotiTimeBand[] {
  const pieces: Piece[] = [];
  const previous = input.atCurrent ? input.previousMonth : null;

  if (previous) {
    const name = monthName(previous.month);
    pieces.push({
      kind: "close",
      groupId: `month:${previous.month}`,
      rank: previous.open > 0 ? 20 : 40,
      caption: name,
      captionTone: "default",
      close: {
        month: previous.month,
        monthName: name,
        title: previous.open > 0 ? `${plural(previous.open, "asia", "asiaa")} kesken` : "Valmis suljettavaksi",
      },
    });
  }

  const vatOnSelected = Boolean(input.vat && input.vat.periodKey === input.selectedMonth);
  if (input.vat && !vatOnSelected) {
    const words = vatCaption(input.vat.dueIso, input.today, input.vat.settled);
    pieces.push({
      kind: "vat",
      groupId: vatGroupId(input.vat.periodKey),
      rank: vatRank(input.vat.dueIso, input.today),
      caption: words.caption,
      captionTone: words.captionTone,
    });
  }

  const groups = new Map<string, Piece[]>();
  for (const piece of pieces) {
    const list = groups.get(piece.groupId) ?? [];
    list.push(piece);
    groups.set(piece.groupId, list);
  }

  const past = [...groups.entries()]
    .map(([id, list]) => {
      list.sort((a, b) => a.rank - b.rank || (a.kind === "close" ? -1 : 1));
      const close = list.find((piece) => piece.kind === "close");
      const lead = close ?? list[0];
      const band: KotiTimeBand = {
        id,
        caption: lead.caption,
        captionTone: close ? "default" : lead.captionTone,
        vat: list.some((piece) => piece.kind === "vat"),
        previousClose: close?.close ?? null,
        selected: false,
        selectedClose: false,
        rows: list.map((piece) => (piece.kind === "vat" ? "vat" : "close") as "vat" | "close"),
      };
      return { rank: Math.min(...list.map((piece) => piece.rank)), band };
    })
    .sort((a, b) => a.rank - b.rank || a.band.id.localeCompare(b.band.id))
    .map((item) => item.band);

  past.push({
    id: `selected:${input.selectedMonth}`,
    caption: past.length === 0 ? null : input.atCurrent ? "Tässä kuussa" : monthName(input.selectedMonth),
    captionTone: "default",
    vat: vatOnSelected,
    previousClose: null,
    selected: true,
    selectedClose: !input.atCurrent,
    rows: [],
  });

  return past;
}
