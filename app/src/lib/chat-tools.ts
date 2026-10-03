/**
 * One chat turn's tools: the registry the model can call, owner-scoped to the
 * signed-in user, and a ledger of what they returned. The ledger is what the
 * honesty guard may let through (every euro figure, record id and link a tool
 * produced on this turn) and the one proposal the turn may carry.
 *
 * Hook for the honesty guard (chat-honesty.ts): `toolHonesty(session)` gives
 * the plain allowed lists; `session.figures()` gives each figure with the tool,
 * period and record it came from, for a guard that ties a figure to its source.
 */
import { READ_TOOLS, type ChatTool, type ToolContext } from "./chat-tools-read";
import { PROPOSAL_TOOLS, type ChatActionProposal } from "./chat-tools-propose";
import { MATCH_TOOLS } from "./chat-tools-match";
import type { ChatMatchProposal } from "./chat-match-proposal";
import { ToolInputError } from "./chat-tools-shared";
import type { ChatToolDefinition, ChatToolRunner } from "./chat-provider";

export const CHAT_TOOLS: ChatTool[] = [...READ_TOOLS, ...PROPOSAL_TOOLS, ...MATCH_TOOLS];

/** What one reply may carry for the owner to confirm. */
export type ChatToolProposal = ChatActionProposal | ChatMatchProposal;

/** One exact euro figure a tool returned ("1234.56", unsigned as replies cite it). */
export interface ToolFigure {
  amount: string;
  tool: string;
  /** The tool's period ("2026-09", "2026-Q3", "2026-07..2026-09"), when it had one. */
  period: string | null;
  /** The record the figure belongs to, when it sits on one (an invoice, a receipt). */
  recordId: string | null;
}

export interface ChatToolCallLog {
  name: string;
  ok: boolean;
}

export interface ChatToolSession extends ChatToolRunner {
  figures(): ToolFigure[];
  recordIds(): string[];
  hrefs(): string[];
  /** The proposal a propose_* or review_matches tool made on this turn (at most one), to store on the reply. */
  proposal(): ChatToolProposal | null;
  calls(): ChatToolCallLog[];
}

const MONEY = /^-?\d+\.\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULT_MAX_CHARS = 24_000;

function periodOf(result: Record<string, unknown>): string | null {
  const period = result.period;
  if (typeof period === "string") return period;
  if (period && typeof period === "object" && typeof (period as { key?: unknown }).key === "string") return (period as { key: string }).key;
  if (typeof result.month === "string") return result.month;
  return null;
}

/** Every money string, id and link in a tool result, each figure with the record it sits on. */
function harvest(
  value: unknown,
  tool: string,
  period: string | null,
  recordId: string | null,
  out: { figures: ToolFigure[]; ids: Set<string>; hrefs: Set<string> },
  key = ""
): void {
  if (typeof value === "string") {
    if (MONEY.test(value)) out.figures.push({ amount: value.replace(/^-/, ""), tool, period, recordId });
    else if (UUID.test(value) && (key === "id" || key.endsWith("Id"))) out.ids.add(value);
    else if (key === "href" && value.startsWith("/") && !value.startsWith("//")) out.hrefs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvest(item, tool, period, recordId, out);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const own = typeof record.id === "string" && UUID.test(record.id) ? record.id : recordId;
    for (const [childKey, child] of Object.entries(record)) harvest(child, tool, period, own, out, childKey);
  }
}

export function createChatToolSession(userId: string, now: Date = new Date(), tools: ChatTool[] = CHAT_TOOLS): ChatToolSession {
  const ctx: ToolContext = { userId, now };
  const byName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
  const ledger = { figures: [] as ToolFigure[], ids: new Set<string>(), hrefs: new Set<string>() };
  const log: ChatToolCallLog[] = [];
  let proposal: ChatToolProposal | null = null;

  async function run(name: string, argumentsJson: string): Promise<string> {
    const tool = byName.get(name);
    const fail = (error: string) => {
      log.push({ name, ok: false });
      return JSON.stringify({ ok: false, error });
    };
    if (!tool) return fail(`Unknown tool '${name}'.`);
    let args: unknown;
    try {
      args = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
    } catch {
      return fail("Arguments are not valid JSON.");
    }
    let result: Record<string, unknown>;
    try {
      result = await tool.run(ctx, args);
    } catch (error) {
      if (error instanceof ToolInputError) return fail(error.message);
      console.error(`Chat tool ${name} failed:`, error instanceof Error ? error.message : error);
      return fail("The tool failed on the server. Tell the user the figure could not be read now.");
    }
    if (result.ok === true && result.proposal && typeof result.proposal === "object") {
      if (proposal) return fail("One proposal per reply: this reply already carries one. Ask the user to confirm it first.");
      proposal = result.proposal as ChatToolProposal;
    }
    const text = JSON.stringify(result);
    if (text.length > RESULT_MAX_CHARS) return fail("The result is too large. Ask again with a smaller limit or a narrower period.");
    if (result.ok === true) harvest(result, name, periodOf(result), null, ledger);
    log.push({ name, ok: result.ok === true });
    return text;
  }

  return {
    definitions: tools.map((tool) => tool.definition) as ChatToolDefinition[],
    run,
    figures: () => [...ledger.figures],
    recordIds: () => [...ledger.ids],
    hrefs: () => [...ledger.hrefs],
    proposal: () => proposal,
    calls: () => [...log],
  };
}

/** What the honesty guard may allow because a tool returned it on this turn. */
export function toolHonesty(session: Pick<ChatToolSession, "figures" | "recordIds" | "hrefs">): {
  allowedAmounts: string[];
  allowedRecordIds: string[];
  allowedHrefs: string[];
} {
  return {
    allowedAmounts: [...new Set(session.figures().map((figure) => figure.amount))],
    allowedRecordIds: session.recordIds(),
    allowedHrefs: session.hrefs(),
  };
}

/** The system prompt's paragraph on the tools. */
export const CHAT_TOOL_RULES = [
  "You have tools that read this user's books on the server. For any figure, list or status (invoices, receipts, purchase invoices, results, VAT, bank balances, cash outlook, open tasks) call a tool and quote only what it returned; never compute a total yourself and never guess. The context above is a short preview; tools are complete.",
  "Resolve relative periods from observedAt (Europe/Helsinki): 'last month' is the previous calendar month, 'last three months' is from/to covering the three months before the current one unless the user includes this month.",
  "Totals in a tool result cover every match; items are one page. If nextCursor is set and the user needs more rows, call again with it.",
  "Tool amounts are exact euros like \"1234.50\"; write them in Finnish form (1 234,50 €) when replying in Finnish.",
  "To match bank rows with receipts or sales invoices, call review_matches and suggest only what it returns as passed, with its Finnish reasons; it shows the best receipt match as a card to confirm. Never suggest a match yourself.",
  "To create a draft invoice or fix a receipt, call propose_invoice_draft or propose_receipt_update. They only show the user a card to confirm; nothing is written until the user taps Hyväksy. Never say an invoice was created or a receipt changed. If a tool returns ok:false, tell the user what is missing.",
].join("\n");

/**
 * `base` plus whatever the turn's tools return, read when the guard reads it
 * (after the reply is complete), not when the turn is prepared.
 */
export function withToolHonesty<T extends {
  allowedAmounts: readonly string[];
  allowedRecordIds: readonly string[];
  allowedHrefs: readonly string[];
}>(base: T, session: Pick<ChatToolSession, "figures" | "recordIds" | "hrefs">): T {
  return {
    ...base,
    get allowedAmounts() {
      return [...base.allowedAmounts, ...toolHonesty(session).allowedAmounts];
    },
    get allowedRecordIds() {
      return [...base.allowedRecordIds, ...session.recordIds()];
    },
    get allowedHrefs() {
      return [...base.allowedHrefs, ...session.hrefs()];
    },
  };
}
