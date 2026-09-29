import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { explainsLimitedMode } from "@/lib/chat-honesty";
import { GET as getStatus } from "@/app/api/ai/status/route";
import { POST as postChat } from "@/app/api/ai/chat/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
const savedToken = process.env.COPILOT_GITHUB_TOKEN;

beforeEach(async () => {
  delete process.env.COPILOT_GITHUB_TOKEN;
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
  else process.env.COPILOT_GITHUB_TOKEN = savedToken;
});

describe("GET /api/ai/status", () => {
  it("needs a session", async () => {
    const response = await getStatus(buildRequest("GET", "/api/ai/status"));
    expect(response.status).toBe(401);
  });

  it("reports unavailable without a model token, and names nothing internal", async () => {
    const response = await getStatus(buildRequest("GET", "/api/ai/status", undefined, { cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await readJson(response);
    expect(body).toEqual({ available: false });
  });

  it("treats a blank token as missing", async () => {
    process.env.COPILOT_GITHUB_TOKEN = "   ";
    const body = await readJson(await getStatus(buildRequest("GET", "/api/ai/status", undefined, { cookie })));
    expect(body).toEqual({ available: false });
  });

  it("reports available once the token is set", async () => {
    process.env.COPILOT_GITHUB_TOKEN = "test-token-not-used";
    const body = await readJson(await getStatus(buildRequest("GET", "/api/ai/status", undefined, { cookie })));
    expect(body).toEqual({ available: true });
  });
});

describe("free-form question without a model", () => {
  it("answers calmly with what works: no limited-mode label, no provider or setting names", async () => {
    const response = await postChat(
      buildRequest(
        "POST",
        "/api/ai/chat",
        { message: "Kerro jotain kivaa yrityksestäni", clientId: crypto.randomUUID() },
        { cookie }
      )
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.role).toBe("assistant");
    expect(body.status).toBe("complete");
    expect(body.limited).toBe(true);
    expect(explainsLimitedMode(body.content)).toBe(true);
    expect(body.content).toMatch(/täsmäyttää kuitit/);
    expect(body.content).not.toMatch(/Rajattu|Rajoitettu|kielimalli|Copilot|COPILOT|GITHUB|token/i);
  });
});
