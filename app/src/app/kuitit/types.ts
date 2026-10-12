import type { BankTxMatch, ReceiptMatchData } from "@/components/ReceiptMatchPanel";

export interface SavedReceipt {
  id: string;
  vendor: string | null;
  date: string | null;
  totalAmount: number | null;
  category: string | null;
  type: string;
  reference: string | null;
  invoiceNumber: string | null;
  fileName: string;
  /** Set by a list answer that omits the file name (narrow select). */
  hasFile?: boolean;
  hasThumbnail?: boolean;
  /** The paged list's `?w=160` thumbnail; null when no file is stored. */
  thumbnailUrl?: string | null;
  /** The paged list's match state; that row omits `match`. */
  matchStatus?: "linked" | "suggested" | "unlinked";
  currency?: string | null;
  source: string;
  createdAt: string;
  linkedTransaction?: BankTxMatch | null;
  /** Absent on a paged (narrow) list row; the full receipt always has it. */
  match?: ReceiptMatchData;
}
