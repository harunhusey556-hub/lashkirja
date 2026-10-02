import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askChat, chatProviderConfigured, streamChat } from "./chat-provider";
import { copilotPaused, resetCopilotPauseForTests } from "./copilot";

function sseBody(...deltas: string[]): ReadableStream<Uint8Array> {
  const text = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text).body!;
}

const copilotToken = () => new Response(JSON.stringify({ token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600 }));

async function collect(stream: AsyncGenerator<string>) {
  let out = "";
  for await (const d of stream) out += d;
  return out;
}

beforeEach(() => {
  resetCopilotPauseForTests();
  vi.stubEnv("COPILOT_GITHUB_TOKEN", "gh");
  vi.stubEnv("LLM_API_KEY", "key");
  vi.stubEnv("LLM_BASE_URL", "https://llm.example/v1/");
  vi.stubEnv("LLM_CHAT_MODEL", "chat-model");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat provider chain", () => {
  it("falls back to the LLM when Copilot's quota is spent, and then skips Copilot", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("copilot_internal")) return copilotToken();
      if (url.includes("githubcopilot")) return new Response("quota", { status: 402 });
      return new Response(sseBody("Hei", " maailma"));
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await collect(streamChat("sys", "kysymys"))).toBe("Hei maailma");
    expect(copilotPaused()).toBe(true);
    const llmCall = fetchMock.mock.calls.find(([url]) => url === "https://llm.example/v1/chat/completions");
    expect(JSON.parse(llmCall![1]!.body as string).model).toBe("chat-model");

    fetchMock.mockClear();
    expect(await collect(streamChat("sys", "toinen"))).toBe("Hei maailma");
    expect(fetchMock.mock.calls.some(([url]) => url.includes("copilot"))).toBe(false);
  });

  it("does not pause Copilot for an outage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("copilot_internal")) return copilotToken();
        if (url.includes("githubcopilot")) return new Response("down", { status: 500 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "vastaus" } }] }));
      })
    );
    expect(await askChat("sys", "kysymys")).toBe("vastaus");
    expect(copilotPaused()).toBe(false);
  });

  it("never switches models after a token is out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("copilot_internal")) return copilotToken();
        // One token, then the connection drops on the next read.
        let pulls = 0;
        const broken = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls++ === 0) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Osa" } }] })}\n\n`));
            } else {
              controller.error(new Error("connection reset"));
            }
          },
        });
        return new Response(broken);
      })
    );
    const seen: string[] = [];
    await expect(async () => {
      for await (const d of streamChat("sys", "kysymys")) seen.push(d);
    }).rejects.toThrow("connection reset");
    expect(seen).toEqual(["Osa"]);
  });

  it("counts only a configured provider", () => {
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
    vi.stubEnv("LLM_API_KEY", "");
    expect(chatProviderConfigured()).toBe(false);
    vi.stubEnv("LLM_API_KEY", "key");
    expect(chatProviderConfigured()).toBe(true);
  });
});
