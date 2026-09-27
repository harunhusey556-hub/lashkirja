import { copilotRequestMessages, type ContextTurn } from "./chat-turn";

const CLOUD_TIMEOUT_MS = 30_000;

export type CopilotTurn = ContextTurn;
export { copilotRequestMessages };

export const COPILOT_HEADERS = {
  "Accept-Encoding": "identity",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "User-Agent": "GitHubCopilotChat/0.35.0",
};

let copilotSession: { token: string; expiresAt: number; baseUrl: string } | null = null;

export async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = CLOUD_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function deriveCopilotBaseUrl(token: string): string {
  const proxyEp = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)?.[1]?.trim();
  if (proxyEp) {
    const host = proxyEp.replace(/^proxy\./i, "api.");
    return `https://${host}`;
  }
  return "https://api.individual.githubcopilot.com";
}

export async function getCopilotSessionToken(ghToken: string): Promise<{ token: string; baseUrl: string }> {
  if (copilotSession && Date.now() < copilotSession.expiresAt - 60_000) {
    return { token: copilotSession.token, baseUrl: copilotSession.baseUrl };
  }
  const res = await fetchWithTimeout("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      "Copilot-Integration-Id": "vscode-chat",
      "X-Github-Api-Version": "2025-04-01",
      Accept: "application/json",
      ...COPILOT_HEADERS,
    },
  });
  if (!res.ok) {
    throw new Error(`Copilot token exchange failed: ${res.status}`);
  }
  const data = await res.json();
  const sessionToken = data.token as string;
  const expiresAt = (data.expires_at ?? Math.floor(Date.now() / 1000) + 600) * 1000;
  const baseUrl = deriveCopilotBaseUrl(sessionToken);
  copilotSession = { token: sessionToken, expiresAt, baseUrl };
  return { token: sessionToken, baseUrl };
}

export async function askCopilot(
  systemPrompt: string,
  userPrompt: string,
  ghToken: string,
  prior: CopilotTurn[] = []
): Promise<string> {
  const model = process.env.COPILOT_MODEL || "gpt-4o";
  const session = await getCopilotSessionToken(ghToken);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.token}`,
    "Copilot-Integration-Id": "vscode-chat",
    "Openai-Organization": "github-copilot",
    ...COPILOT_HEADERS,
  };

  const response = await fetchWithTimeout(
    `${session.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: copilotRequestMessages(systemPrompt, userPrompt, prior),
        max_tokens: 1500,
        temperature: 0.7,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Copilot API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

/**
 * Token stream from the provider. Yields content deltas as they arrive.
 * Throws if the HTTP call fails before any token. The caller decides what
 * an incomplete stream means; this function does not invent a finished reply.
 */
export async function* askCopilotStream(
  systemPrompt: string,
  userPrompt: string,
  ghToken: string,
  signal?: AbortSignal,
  prior: CopilotTurn[] = []
): AsyncGenerator<string> {
  const model = process.env.COPILOT_MODEL || "gpt-4o";
  const session = await getCopilotSessionToken(ghToken);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.token}`,
    "Copilot-Integration-Id": "vscode-chat",
    "Openai-Organization": "github-copilot",
    ...COPILOT_HEADERS,
  };
  const response = await fetch(`${session.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages: copilotRequestMessages(systemPrompt, userPrompt, prior),
      max_tokens: 1500,
      temperature: 0.4,
      stream: true,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Copilot stream failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const event = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      };
      const delta = event.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}
