import { NextRequest } from "next/server";
import { handleReceiptInboxUpload } from "@/lib/receipt-inbox";

export async function POST(req: NextRequest) {
  return handleReceiptInboxUpload(req);
}
