const CLOUD_TIMEOUT_MS = 30_000;

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
  ghToken: string
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
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
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
