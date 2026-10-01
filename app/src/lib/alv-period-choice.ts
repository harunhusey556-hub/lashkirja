/**
 * Which VAT period the ALV page opens on, and which ones it offers (F13).
 *
 * The profile's ALV-verokausi (month, quarter, year) decides the period a
 * return is due for. Koti and Kirjanpito already show that return through
 * `nextVatDue`; the ALV page now opens on the same one, in the same unit, and a
 * yearly filer can see and file the year. An explicit `?period=` link, and a
 * choice the owner made while the setting was the same, win over the default.
 */
import { MONTHS } from "./finnish-months";
import { nextVatDue, vatPeriodKindOf, type VatPeriod, type VatPeriodKind } from "./vat-deadline";

export const ALV_PERIOD_KEY = /^\d{4}(?:-(?:(?:0[1-9]|1[0-2])|Q[1-4]))?$/;

export function alvKeyKind(key: string): VatPeriodKind {
  if (/-Q[1-4]$/.test(key)) return "quarter";
  return key.length === 4 ? "year" : "month";
}

/** "2026-08" / "2026-Q3" / "2026" as the shared VatPeriod. */
export function periodOfKey(key: string): VatPeriod {
  const year = Number(key.slice(0, 4));
  const quarter = /-Q([1-4])$/.exec(key);
  if (quarter) return { kind: "quarter", year, quarter: Number(quarter[1]) };
  if (key.length === 4) return { kind: "year", year };
  return { kind: "month", year, month: Number(key.slice(5, 7)) };
}

/** A period the owner picked, with the ALV-verokausi setting it was picked under. */
export interface AlvChoice {
  key: string;
  kind: VatPeriodKind;
}

/**
 * The period to show: a link's period, else the owner's own choice (only while
 * the setting is still the one it was made under), else the return that is due.
 */
export function resolveAlvPeriod(input: {
  link: string | null;
  choice: AlvChoice | null;
  vatPeriod: string | null | undefined;
  now: Date;
}): string {
  if (input.link && ALV_PERIOD_KEY.test(input.link)) return input.link;
  const kind = vatPeriodKindOf(input.vatPeriod);
  if (input.choice && input.choice.kind === kind && ALV_PERIOD_KEY.test(input.choice.key)) return input.choice.key;
  return nextVatDue(input.now, kind).key;
}

/** The period to show when the owner switches to another unit: the return that is due in that unit. */
export function alvKeyForKind(kind: VatPeriodKind, now: Date): string {
  return nextVatDue(now, kind).key;
}

export interface AlvPeriodOption {
  value: string;
  label: string;
}

/**
 * The periods of one unit the select offers: the current and the previous year
 * (a return for December is filed in February), plus the shown one, so the
 * select never goes blank on a period it does not list.
 */
export function alvPeriodOptions(kind: VatPeriodKind, nowYear: number, selected: string): AlvPeriodOption[] {
  const options: AlvPeriodOption[] = [];
  for (const year of [nowYear - 1, nowYear]) {
    if (kind === "month") {
      MONTHS.forEach((name, index) =>
        options.push({ value: `${year}-${String(index + 1).padStart(2, "0")}`, label: `${name} ${year}` })
      );
    } else if (kind === "quarter") {
      for (let quarter = 1; quarter <= 4; quarter += 1) {
        options.push({ value: `${year}-Q${quarter}`, label: `Q${quarter} / ${year}` });
      }
    } else {
      options.push({ value: String(year), label: String(year) });
    }
  }
  if (alvKeyKind(selected) === kind && !options.some((option) => option.value === selected)) {
    options.push({ value: selected, label: alvPeriodLabel(selected) });
    options.sort((a, b) => a.value.localeCompare(b.value));
  }
  return options;
}

export function alvPeriodLabel(key: string): string {
  const period = periodOfKey(key);
  if (period.kind === "month") return `${MONTHS[period.month! - 1]} ${period.year}`;
  if (period.kind === "quarter") return `Q${period.quarter} / ${period.year}`;
  return String(period.year);
}
