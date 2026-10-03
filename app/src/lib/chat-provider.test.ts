import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askChat, askReasoned, chatProviderConfigured, reasoningEffortFor, streamChat } from "./chat-provider";
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

describe("reasoning (thinking) for the match review", () => {
  it("is sent only to models that take it, and can be forced or turned off", () => {
    expect(reasoningEffortFor("gemini-2.5-flash", {})).toBe("medium");
    expect(reasoningEffortFor("gemini-3.1-flash-lite", {})).toBe("medium");
    expect(reasoningEffortFor("models/gemini-3-pro", {})).toBe("medium");
    expect(reasoningEffortFor("o4-mini", {})).toBe("medium");
    expect(reasoningEffortFor("gpt-4o", {})).toBeNull();
    expect(reasoningEffortFor("gemini-2.0-flash", {})).toBeNull();
    expect(reasoningEffortFor("llama3", { LLM_REASONING_EFFORT: "high" })).toBe("high");
    expect(reasoningEffortFor("gemini-2.5-pro", { LLM_REASONING_EFFORT: "off" })).toBeNull();
    expect(reasoningEffortFor("gemini-2.5-pro", { LLM_REASONING_EFFORT: "low" })).toBe("low");
  });

  it("asks the thinking model first with reasoning_effort, and falls back silently when refused", async () => {
    vi.stubEnv("LLM_CHAT_MODEL", "gemini-2.5-flash");
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("copilot")) throw new Error("copilot must not be asked first");
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (body.reasoning_effort) return new Response("unknown field reasoning_effort", { status: 400 });
        return new Response(JSON.stringify({ model: "gemini-2.5-flash", choices: [{ message: { content: '{"match":null}' } }] }));
      })
    );
    const answer = await askReasoned("sys", "data");
    expect(answer).toEqual({ text: '{"match":null}', model: "gemini-2.5-flash", reasoning: false });
    expect(bodies[0]).toMatchObject({ model: "gemini-2.5-flash", reasoning_effort: "medium" });
    expect(bodies[0].temperature).toBeUndefined();
    expect(bodies[1].reasoning_effort).toBeUndefined();
  });

  it("reports thinking when the endpoint takes it, and never sends it to a model without it", async () => {
    vi.stubEnv("LLM_CHAT_MODEL", "gemini-3.1-flash-lite");
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
      })
    );
    expect((await askReasoned("sys", "data")).reasoning).toBe(true);

    vi.stubEnv("LLM_CHAT_MODEL", "gpt-4o-mini");
    bodies.length = 0;
    expect((await askReasoned("sys", "data")).reasoning).toBe(false);
    expect(bodies[0].reasoning_effort).toBeUndefined();
    expect(bodies[0].temperature).toBe(0);
  });
});
