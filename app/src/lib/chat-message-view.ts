import { displayChatContent } from "./chat-legacy";
import type { ChatSource } from "./chat-turn";

/** Proposal kinds a reply can carry: a receipt-to-bank-row match, and the tools' confirmed actions. */
const PROPOSAL_TYPES = new Set(["match_proposal", "invoice_draft", "receipt_update"]);

function parseSources(raw: string | null): ChatSource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ChatSource[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** One stored chat row as every chat endpoint returns it (GET history, POST, PATCH, receipt). */
export function mapMessage(message: {
  id: string;
  role: string;
  content: string;
  clientId?: string | null;
  proposalData: string | null;
  sources?: string | null;
  status?: string;
  replyToId?: string | null;
  conversationId?: string;
  createdAt: Date;
}) {
  const raw = message.proposalData ? (JSON.parse(message.proposalData) as Record<string, unknown>) : null;
  // A client that does not know a type leaves the card out (the native app ignores unknown types).
  const proposal = raw && typeof raw.type === "string" && PROPOSAL_TYPES.has(raw.type) ? raw : null;
  return {
    id: message.id,
    role: message.role,
    // Old replies can still start with the pre-OWN-09 "Rajattu tila" notice.
    content: displayChatContent(message.role, message.content),
    clientId: message.clientId ?? null,
    proposal,
    limited: Boolean(raw?.limited),
    sources: parseSources(message.sources ?? null),
    status: message.status ?? "complete",
    replyToId: message.replyToId ?? null,
    conversationId: message.conversationId ?? null,
    createdAt: message.createdAt,
  };
}
