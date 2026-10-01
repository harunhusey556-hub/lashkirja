/**
 * OWN-18: Koti's "Pankkitilit" row, from the dashboard's `bank` block (which
 * reads lib/bank-position.ts: ledger accounts plus the accounts of a bank
 * consent). Pure, so every state's words are unit tested.
 */
import { formatEur } from "./format";

export type KotiBankState = "none" | "connected" | "reconnect" | "unscoped";

export interface KotiBank {
  totalBalance: number;
  accountCount: number;
  needsAttention: number;
  /** Absent in a dashboard cached before OWN-18. */
  state?: KotiBankState;
  hasBalance?: boolean;
  reconnectBank?: string | null;
}

export interface KotiBankRow {
  amount?: string;
  secondary: string;
  /** The secondary line is a warning (a consent to renew). */
  warn: boolean;
  pill: { label: string; ariaLabel: string } | null;
  ariaLabel: string;
}

export const KOTI_BANK_COPY = {
  none: "Ei yhdistettyä tiliä",
  reconnect: "Yhteys vanhentunut — yhdistä uudelleen",
  unscoped: "Valitse kirjanpitoon kuuluvat tilit",
  noBalance: "saldo ei vielä haettu",
} as const;

function accounts(count: number): string {
  return `${count} ${count === 1 ? "tili" : "tiliä"}`;
}

export function kotiBankState(bank: KotiBank | null | undefined): KotiBankState {
  if (!bank) return "none";
  if (bank.state) return bank.state;
  return bank.accountCount > 0 ? "connected" : "none";
}

export function kotiBankRow(bank: KotiBank | null | undefined): KotiBankRow {
  const state = kotiBankState(bank);
  const count = bank?.accountCount ?? 0;
  // An old cache has no hasBalance: its total was always a real figure then.
  const hasBalance = count > 0 && (bank?.hasBalance ?? true);
  const amount = hasBalance && bank ? formatEur(bank.totalBalance) : undefined;

  if (state === "reconnect") {
    return {
      amount,
      secondary: KOTI_BANK_COPY.reconnect,
      warn: true,
      pill: { label: "Yhdistä", ariaLabel: "Yhdistä pankki uudelleen" },
      ariaLabel: ["Pankkitilit", amount, KOTI_BANK_COPY.reconnect].filter(Boolean).join(", "),
    };
  }
  if (state === "unscoped") {
    return {
      secondary: KOTI_BANK_COPY.unscoped,
      warn: false,
      pill: { label: "Valitse", ariaLabel: "Valitse kirjanpitoon kuuluvat tilit" },
      ariaLabel: `Pankkitilit, ${KOTI_BANK_COPY.unscoped}`,
    };
  }
  if (state === "connected" && count > 0) {
    const secondary = hasBalance ? accounts(count) : `${accounts(count)} · ${KOTI_BANK_COPY.noBalance}`;
    return {
      amount,
      secondary,
      warn: false,
      pill: null,
      ariaLabel: ["Pankkitilit", amount, secondary].filter(Boolean).join(", "),
    };
  }
  return {
    secondary: KOTI_BANK_COPY.none,
    warn: false,
    pill: { label: "Yhdistä", ariaLabel: "Yhdistä pankki" },
    ariaLabel: "Pankkitilit, ei yhdistettyä tiliä",
  };
}
