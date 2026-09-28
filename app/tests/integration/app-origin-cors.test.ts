import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { POST as issueToken } from "@/app/api/auth/token/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { prisma } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

const PASSWORD = "salasana1234";
const APP_ORIGIN = "capacitor://localhost";

let user: TestUser;

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });
});

async function bearerToken(): Promise<string> {
  const response = await issueToken(
    buildRequest("POST", "/api/auth/token", { email: user.email, password: PASSWORD })
  );
  const body = await readJson<{ token: string }>(response);
  return body.token;
}

describe("proxy() CORS headers for a bearer request from the app origin", () => {
  it("adds ACAO, expose headers and the API version to a protected GET", async () => {
    const token = await bearerToken();
    const request = buildRequest("GET", "/api/dashboard", undefined, {
      origin: APP_ORIGIN,
      headers: { authorization: `Bearer ${token}` },
    });

    const proxyResponse = await proxy(request);
    expect(proxyResponse.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(proxyResponse.headers.get("access-control-expose-headers")).toBe(
      "Retry-After, Content-Disposition, X-LashKirja-Api-Version"
    );
    expect(proxyResponse.headers.get("x-lashkirja-api-version")).toBe("1");

    const { GET: dashboard } = await import("@/app/api/dashboard/route");
    const routeResponse = await dashboard(
      buildRequest("GET", "/api/dashboard", undefined, {
        origin: APP_ORIGIN,
        headers: { authorization: `Bearer ${token}` },
      })
    );
    expect(routeResponse.status).toBe(200);
  });
});

describe("guardWrite from the app origin", () => {
  it("a bearer POST /api/customers with an app Origin passes guardWrite and creates the customer", async () => {
    const token = await bearerToken();
    const response = await createCustomer(
      buildRequest(
        "POST",
        "/api/customers",
        { name: "App-luotu asiakas" },
        { origin: APP_ORIGIN, headers: { authorization: `Bearer ${token}` } }
      )
    );
    expect(response.status).toBe(201);
    const body = await readJson<{ customer: { name: string } }>(response);
    expect(body.customer.name).toBe("App-luotu asiakas");
  });

  it("the same POST with a cookie and a foreign Origin is still 403 (unchanged CSRF protection)", async () => {
    const cookie = await sessionCookie(user);
    const response = await createCustomer(
      buildRequest("POST", "/api/customers", { name: "Ei pitäisi luoda" }, {
        cookie,
        origin: "https://evil.test",
        secFetchSite: "cross-site",
      })
    );
    expect(response.status).toBe(403);
  });
});

describe("rejectCrossSite for POST /api/auth/token from the app origin", () => {
  it("passes (does not 403) when the app origin issues the token request", async () => {
    const response = await issueToken(
      buildRequest("POST", "/api/auth/token", { email: user.email, password: PASSWORD }, { origin: APP_ORIGIN })
    );
    expect(response.status).toBe(200);
  });
});
