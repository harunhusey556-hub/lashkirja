import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_TOOL_LIMITS, streamChatWithTools, type ChatToolRunner } from "./chat-provider";
import { resetCopilotPauseForTests } from "./copilot";

function sseBody(...deltas: string[]): ReadableStream<Uint8Array> {
  const text = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text).body!;
}

const toolCall = (id: string, name: string, args: unknown) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) }, extra_content: { google: { thought_signature: "sig" } } }],
});

const runner = (): ChatToolRunner & { calls: Array<[string, string]> } => {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    definitions: [{ type: "function", function: { name: "period_summary", description: "x", parameters: { type: "object", properties: {} } } }],
    run: async (name, args) => {
      calls.push([name, args]);
      return JSON.stringify({ ok: true, profitNet: "100.00" });
    },
  };
};

async function collect(stream: AsyncGenerator<string>) {
  let out = "";
  for await (const d of stream) out += d;
  return out;
}

beforeEach(() => {
  resetCopilotPauseForTests();
  vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
  vi.stubEnv("LLM_API_KEY", "key");
  vi.stubEnv("LLM_BASE_URL", "https://llm.example/v1");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tool loop", () => {
  it("runs the model's tool call and returns its text answer", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        bodies.push(body);
        const message = bodies.length === 1 ? toolCall("c1", "period_summary", { period: "2026-09" }) : { role: "assistant", content: "Tulos 100,00 €." };
        return new Response(JSON.stringify({ choices: [{ message }] }));
      })
    );
    const tools = runner();
    expect(await collect(streamChatWithTools("sys", "tulos?", undefined, [], tools))).toBe("Tulos 100,00 €.");
    expect(tools.calls).toEqual([["period_summary", JSON.stringify({ period: "2026-09" })]]);
    expect(bodies[0].tools).toEqual(tools.definitions);
    expect(bodies[0].stream).toBe(false);
    const second = bodies[1].messages as Array<Record<string, unknown>>;
    const echoed = second.find((m) => m.role === "assistant") as { tool_calls: Array<Record<string, unknown>> };
    // The provider's own fields in the call (Gemini's thought signature) go back unchanged.
    expect(echoed.tool_calls[0].extra_content).toEqual({ google: { thought_signature: "sig" } });
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("stops after the round limit and streams the answer with tools off", async () => {
    let n = 0;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        bodies.push(body);
        if (body.stream) return new Response(sseBody("Vastaus", " valmis"));
        n += 1;
        return new Response(JSON.stringify({ choices: [{ message: toolCall(`c${n}`, "period_summary", {}) }] }));
      })
    );
    const tools = runner();
    expect(await collect(streamChatWithTools("sys", "kysymys", undefined, [], tools))).toBe("Vastaus valmis");
    expect(tools.calls).toHaveLength(CHAT_TOOL_LIMITS.maxRounds);
    expect(bodies).toHaveLength(CHAT_TOOL_LIMITS.maxRounds + 1);
    expect(bodies.at(-1)).toMatchObject({ stream: true, tool_choice: "none" });
  });

  it("answers the plain way when the endpoint refuses tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        if (body.tools) return new Response("tools not supported", { status: 400 });
        return new Response(sseBody("Ilman ", "työkaluja"));
      })
    );
    const tools = runner();
    expect(await collect(streamChatWithTools("sys", "kysymys", undefined, [], tools))).toBe("Ilman työkaluja");
    expect(tools.calls).toHaveLength(0);
  });

  it("caps the calls run in one round", async () => {
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (first) {
          first = false;
          const calls = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, type: "function", function: { name: "period_summary", arguments: "{}" } }));
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }] }));
        }
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
      })
    );
    const tools = runner();
    expect(await collect(streamChatWithTools("sys", "k", undefined, [], tools))).toBe("ok");
    expect(tools.calls).toHaveLength(CHAT_TOOL_LIMITS.maxCallsPerRound);
  });

  it("moves to the next provider on a quota refusal before anything is shown", async () => {
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "gh");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("copilot_internal")) return new Response(JSON.stringify({ token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
        if (url.includes("githubcopilot")) return new Response("quota", { status: 429 });
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "LLM vastasi" } }] }));
      })
    );
    expect(await collect(streamChatWithTools("sys", "k", undefined, [], runner()))).toBe("LLM vastasi");
  });
});
