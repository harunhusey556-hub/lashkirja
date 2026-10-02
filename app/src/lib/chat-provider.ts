import {
  askCopilot,
  askCopilotStream,
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
