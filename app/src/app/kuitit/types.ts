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
  source: string;
  createdAt: string;
  linkedTransaction?: BankTxMatch | null;
  match: ReceiptMatchData;
}
