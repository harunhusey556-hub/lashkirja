import { displayChatContent } from "./chat-legacy";
import type { ChatSource } from "./chat-turn";

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
  const proposal = raw && raw.type === "match_proposal" ? raw : null;
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
