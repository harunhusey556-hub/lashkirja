/** Pure chat-turn rules: limits, history cursor, context window, stream status. */

export const CHAT_MESSAGE_MAX = 4000;
export const CHAT_CONTEXT_LIMIT = 12;
export const CHAT_PAGE_SIZE = 50;
export const CHAT_POST_LIMIT = 20;
export const CHAT_POST_WINDOW_MS = 60_000;
export const CHAT_OWNER_STALE_MS = 45_000;
export const CHAT_PROVIDER_TIMEOUT_MS = 30_000;
export const DEFAULT_CONVERSATION_TITLE = "Uusi keskustelu";

export type ChatTurnStatus = "streaming" | "complete" | "cancelled" | "failed" | "incomplete";

export type StreamEndReason =
  | "complete"
  | "stop"
  | "disconnect"
  | "timeout"
  | "background"
  | "provider_error";

export interface ChatSource {
  kind?: "action";
  label: string;
  href: string;
}

export interface ContextTurn {
  role: "user" | "assistant";
  content: string;
}

export function messageTooLong(text: string): boolean {
  return text.length > CHAT_MESSAGE_MAX;
}

export function titleFromMessage(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return DEFAULT_CONVERSATION_TITLE;
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

/** Page older than this row. Same createdAt is ordered by id, so none are skipped. */
export function historyCursorWhere(createdAt: Date, id: string) {
  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { AND: [{ createdAt }, { id: { lt: id } }] },
    ],
  };
}

export function boundContext(turns: ContextTurn[], limit = CHAT_CONTEXT_LIMIT): ContextTurn[] {
  return turns.filter((turn) => turn.content.trim().length > 0).slice(-limit);
}

export function copilotRequestMessages(
  systemPrompt: string,
  userPrompt: string,
  prior: ContextTurn[]
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const turns = boundContext([...prior, { role: "user", content: userPrompt }]);
  return [{ role: "system", content: systemPrompt }, ...turns];
}

export function ownerIsFresh(heartbeat: Date | null | undefined, now: Date, staleMs = CHAT_OWNER_STALE_MS): boolean {
  if (!heartbeat) return false;
  return now.getTime() - heartbeat.getTime() < staleMs;
}

/**
 * How a stream ends. Stop, disconnect, and backgrounding finish the server
 * job with an explicit status. A timeout or provider error does too.
 */
export function settleChatStream(input: {
  reason: StreamEndReason;
  collected: string;
}): { status: ChatTurnStatus; content: string } {
  const text = input.collected;
  const hasText = text.trim().length > 0;
  if (input.reason === "complete") {
    return hasText
      ? { status: "complete", content: text }
      : { status: "failed", content: "Vastaus jäi tyhjäksi." };
  }
  if (input.reason === "timeout") {
    return hasText
      ? { status: "incomplete", content: text }
      : { status: "failed", content: "Vastaus aikakatkaistiin." };
  }
  if (input.reason === "provider_error") {
    return hasText
      ? { status: "incomplete", content: text }
      : { status: "failed", content: "Vastaus epäonnistui." };
  }
  return hasText
    ? { status: "incomplete", content: text }
    : { status: "cancelled", content: "Vastaus keskeytettiin." };
}

export function streamEndReason(input: {
  signal: AbortSignal;
  timedOut: boolean;
  threw: boolean;
}): StreamEndReason {
  if (input.timedOut) return "timeout";
  if (input.signal.aborted) {
    const reason = input.signal.reason;
    if (reason === "disconnect") return "disconnect";
    if (reason === "background") return "background";
    return "stop";
  }
  if (input.threw) return "provider_error";
  return "complete";
}
