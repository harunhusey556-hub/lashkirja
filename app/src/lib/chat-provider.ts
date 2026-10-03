import {
  askCopilot,
  askCopilotStream,
  copilotCompletion,
  copilotPaused,
  copilotRequestMessages,
  fetchWithTimeout,
  noteCopilotFailure,
  ProviderHttpError,
  readChatCompletionStream,
  type CopilotTurn,
} from "./copilot";

/**
 * The assistant's language model, as an ordered chain: Copilot first (free
 * while its quota lasts), then any OpenAI-compatible endpoint set by
 * LLM_BASE_URL / LLM_API_KEY (Gemini, Claude, OpenRouter, a local Ollama...).
 * A provider that fails before its first token hands the turn to the next
 * one, so Copilot running out of quota no longer silences the assistant.
 */

type ChatProvider = {
  id: "copilot" | "llm";
  ask: (system: string, user: string, prior: CopilotTurn[]) => Promise<string>;
  stream: (system: string, user: string, signal: AbortSignal | undefined, prior: CopilotTurn[]) => AsyncGenerator<string>;
  /** One raw `chat/completions` call with a caller-built body (tool loop). Throws ProviderHttpError on HTTP errors. */
  raw: (body: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<Response>;
};

function llmConfig() {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    // The chat may want a stronger model than receipt extraction (LLM_MODEL).
    model: process.env.LLM_CHAT_MODEL?.trim() || process.env.LLM_MODEL?.trim() || "gpt-4o-mini",
  };
}

function llmRequest(config: NonNullable<ReturnType<typeof llmConfig>>, system: string, user: string, prior: CopilotTurn[], stream: boolean) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: copilotRequestMessages(system, user, prior),
      max_tokens: 1500,
      temperature: 0.4,
      stream,
    }),
  } satisfies RequestInit;
}

function chatProviders(): ChatProvider[] {
  const providers: ChatProvider[] = [];
  const token = process.env.COPILOT_GITHUB_TOKEN?.trim();
  if (token && !copilotPaused()) {
    providers.push({
      id: "copilot",
      ask: (system, user, prior) => askCopilot(system, user, token, prior),
      stream: (system, user, signal, prior) => askCopilotStream(system, user, token, signal, prior),
      raw: (body, signal) => copilotCompletion(token, body, signal),
    });
  }
  const config = llmConfig();
  if (config) {
    providers.push({
      id: "llm",
      async ask(system, user, prior) {
        const response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, llmRequest(config, system, user, prior, false));
        if (!response.ok) throw new ProviderHttpError(`LLM API error: ${response.status}`, response.status);
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "";
      },
      async *stream(system, user, signal, prior) {
        const response = await fetch(`${config.baseUrl}/chat/completions`, { ...llmRequest(config, system, user, prior, true), signal });
        if (!response.ok || !response.body) throw new ProviderHttpError(`LLM stream failed: ${response.status}`, response.status);
        yield* readChatCompletionStream(response.body);
      },
      async raw(body, signal) {
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, ...body }),
          signal,
        });
        if (!response.ok) throw new ProviderHttpError(`LLM API error: ${response.status}`, response.status);
        return response;
      },
    });
  }
  return providers;
}

/** Some model is configured, so free-form questions can be answered. */
export function chatProviderConfigured(): boolean {
  return Boolean(process.env.COPILOT_GITHUB_TOKEN?.trim() || llmConfig());
}

function noteFailure(provider: ChatProvider, error: unknown) {
  if (provider.id === "copilot") noteCopilotFailure(error);
  console.warn(`Chat provider ${provider.id} failed:`, error instanceof Error ? error.message : "UnknownError");
}

export async function askChat(system: string, user: string, prior: CopilotTurn[] = []): Promise<string> {
  const providers = chatProviders();
  if (providers.length === 0) throw new Error("provider missing");
  let lastError: unknown;
  for (const provider of providers) {
    try {
      const reply = await provider.ask(system, user, prior);
      if (reply.trim()) return reply;
      lastError = new Error(`${provider.id} returned an empty reply`);
    } catch (error) {
      noteFailure(provider, error);
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Streams one reply. Falls through to the next provider only while nothing
 * has been shown yet: once a token is out, a failure ends the turn as
 * incomplete rather than restarting it with another model's words.
 */
export async function* streamChat(
  system: string,
  user: string,
  signal?: AbortSignal,
  prior: CopilotTurn[] = []
): AsyncGenerator<string> {
  const providers = chatProviders();
  if (providers.length === 0) throw new Error("provider missing");
  let lastError: unknown;
  for (const provider of providers) {
    let started = false;
    try {
      for await (const delta of provider.stream(system, user, signal, prior)) {
        started = true;
        yield delta;
      }
      return;
    } catch (error) {
      noteFailure(provider, error);
      if (started || signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ */
/* Function calling: a bounded loop of tool rounds, then the answer.   */
/* ------------------------------------------------------------------ */

/** An OpenAI-style function tool as sent in `tools`. */
export interface ChatToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** What the loop needs from the tools: their definitions and a way to run one call. */
export interface ChatToolRunner {
  definitions: ChatToolDefinition[];
  /** Runs one call; returns the JSON text the model reads. Never throws for a bad call. */
  run: (name: string, argumentsJson: string) => Promise<string>;
}

interface WireToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  [key: string]: unknown;
}

type WireMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
};

/**
 * Limits of one turn's tool use. The whole turn, final answer included, runs
 * inside the chat turn's own timeout (CHAT_PROVIDER_TIMEOUT_MS, 30 s), so the
 * tool phase gets at most `budgetMs` of it and each round `roundTimeoutMs`.
 */
export const CHAT_TOOL_LIMITS = {
  maxRounds: 4,
  maxCallsPerRound: 6,
  roundTimeoutMs: 10_000,
  budgetMs: 15_000,
};

/** HTTP answers that mean "this endpoint or model does not take tools": fall back to the plain turn. */
const TOOLS_UNSUPPORTED = new Set([400, 404, 405, 415, 422, 501]);

function roundSignal(outer: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/**
 * Streams one reply with the tools available. Each round is a non-streamed
 * completion; the model's tool calls are run on the server (owner-scoped by
 * the runner) and their results go back to it. When the model answers in
 * text, that text is the reply. After `maxRounds`, or once the tool budget
 * is spent, the answer is streamed with tool_choice "none". A provider that
 * refuses tools gets the plain prepared-context turn (today's behaviour).
 * As in streamChat, another provider is tried only while nothing is shown.
 */
export async function* streamChatWithTools(
  system: string,
  user: string,
  signal: AbortSignal | undefined,
  prior: CopilotTurn[],
  tools: ChatToolRunner,
  limits: typeof CHAT_TOOL_LIMITS = CHAT_TOOL_LIMITS
): AsyncGenerator<string> {
  const providers = chatProviders();
  if (providers.length === 0) throw new Error("provider missing");
  let lastError: unknown;
  for (const provider of providers) {
    let started = false;
    try {
      const messages: WireMessage[] = copilotRequestMessages(system, user, prior);
      const deadline = Date.now() + limits.budgetMs;
      let toolsUnsupported = false;
      let usedTools = false;
      let answer: string | null = null;
      for (let round = 0; round < limits.maxRounds; round += 1) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        let reply: WireMessage | undefined;
        try {
          const response = await provider.raw(
            { messages, tools: tools.definitions, tool_choice: "auto", max_tokens: 1500, temperature: 0.2, stream: false },
            roundSignal(signal, Math.min(limits.roundTimeoutMs, left))
          );
          const data = (await response.json()) as { choices?: Array<{ message?: WireMessage }> };
          reply = data.choices?.[0]?.message;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof ProviderHttpError) {
            if (round === 0 && TOOLS_UNSUPPORTED.has(error.status)) {
              toolsUnsupported = true;
              break;
            }
            // Quota or outage: the next provider takes the turn.
            throw error;
          }
          // A round that timed out or returned garbage: answer with what is known.
          break;
        }
        const calls = (reply?.tool_calls ?? []).filter((call) => call && typeof call.id === "string");
        if (calls.length === 0) {
          answer = typeof reply?.content === "string" ? reply.content : "";
          break;
        }
        usedTools = true;
        // Echoed as returned: some providers (Gemini) carry a signature in the call that must come back.
        messages.push({ ...reply!, role: "assistant", content: reply?.content ?? null, tool_calls: calls });
        for (const [index, call] of calls.entries()) {
          const content =
            index < limits.maxCallsPerRound
              ? await tools.run(call.function?.name ?? "", call.function?.arguments ?? "{}")
              : JSON.stringify({ ok: false, error: "Too many tool calls in one round; ask again with fewer." });
          messages.push({ role: "tool", tool_call_id: call.id, content });
        }
      }

      if (toolsUnsupported) {
        for await (const delta of provider.stream(system, user, signal, prior)) {
          started = true;
          yield delta;
        }
        return;
      }
      if (answer && answer.trim()) {
        started = true;
        yield answer;
        return;
      }
      // Rounds or budget spent (or an empty answer): the answer is streamed, no more tools.
      const response = await provider.raw(
        usedTools
          ? { messages, tools: tools.definitions, tool_choice: "none", max_tokens: 1500, temperature: 0.4, stream: true }
          : { messages, max_tokens: 1500, temperature: 0.4, stream: true },
        signal
      );
      if (!response.body) throw new ProviderHttpError("Stream body missing", 502);
      for await (const delta of readChatCompletionStream(response.body)) {
        started = true;
        yield delta;
      }
      return;
    } catch (error) {
      noteFailure(provider, error);
      if (started || signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
