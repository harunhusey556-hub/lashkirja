import { sealData } from "iron-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionOptions } from "@/lib/session-options";
import { readCredential, sealBearerToken } from "./auth-credential";

const denyAppOrigin = () => false;

function headersWith(values: Record<string, string>): Headers {
  return new Headers(values);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sealBearerToken + readCredential", () => {
  it("round-trips a sealed bearer token", async () => {
    const { token } = await sealBearerToken({
      userId: "user-1",
      email: "demo@lashkirja.fi",
      firstName: "Demo",
      sessionId: "session-1",
    });

    const credential = await readCredential(
      headersWith({ authorization: `Bearer ${token}` }),
      undefined,
      denyAppOrigin
    );

    expect(credential).toEqual({
      kind: "bearer",
      data: {
        userId: "user-1",
        email: "demo@lashkirja.fi",
        firstName: "Demo",
        sessionId: "session-1",
        kind: "bearer",
      },
    });
  });

  it("rejects a bearer payload without kind: \"bearer\"", async () => {
    const sealed = await sealData(
      { userId: "user-1", sessionId: "session-1" },
      { password: sessionOptions.password as string, ttl: 3600 }
    );

    const credential = await readCredential(
      headersWith({ authorization: `Bearer ${sealed}` }),
      undefined,
      denyAppOrigin
    );

    expect(credential).toBeNull();
  });

  it("rejects a bearer payload missing sessionId", async () => {
    const sealed = await sealData(
      { userId: "user-1", kind: "bearer" },
      { password: sessionOptions.password as string, ttl: 3600 }
    );

    const credential = await readCredential(
      headersWith({ authorization: `Bearer ${sealed}` }),
      undefined,
      denyAppOrigin
    );

    expect(credential).toBeNull();
  });

  it("rejects a cookie whose payload has kind: \"bearer\"", async () => {
    const { token } = await sealBearerToken({
      userId: "user-1",
      email: "demo@lashkirja.fi",
      firstName: "Demo",
      sessionId: "session-1",
    });

    const credential = await readCredential(headersWith({}), token, denyAppOrigin);

    expect(credential).toBeNull();
  });

  it("does not fall back to a valid cookie when Authorization is not a bearer token", async () => {
    const cookieSealed = await sealData(
      { userId: "user-1", email: "demo@lashkirja.fi", firstName: "Demo" },
      { password: sessionOptions.password as string, ttl: sessionOptions.ttl }
    );

    const credential = await readCredential(
      headersWith({ authorization: "Basic x" }),
      cookieSealed,
      denyAppOrigin
    );

    expect(credential).toBeNull();
  });

  it("still reads a genuine cookie credential when there is no Authorization header", async () => {
    const cookieSealed = await sealData(
      { userId: "user-1", email: "demo@lashkirja.fi", firstName: "Demo" },
      { password: sessionOptions.password as string, ttl: sessionOptions.ttl }
    );

    const credential = await readCredential(headersWith({}), cookieSealed, denyAppOrigin);

    expect(credential).toEqual({
      kind: "cookie",
      data: { userId: "user-1", email: "demo@lashkirja.fi", firstName: "Demo" },
    });
  });

  it("ignores a cookie credential when the request Origin is an app client origin", async () => {
    const cookieSealed = await sealData(
      { userId: "user-1", email: "demo@lashkirja.fi", firstName: "Demo" },
      { password: sessionOptions.password as string, ttl: sessionOptions.ttl }
    );

    const credential = await readCredential(
      headersWith({ origin: "capacitor://localhost" }),
      cookieSealed,
      (origin) => origin === "capacitor://localhost"
    );

    expect(credential).toBeNull();
  });

  it("rejects an expired bearer token", async () => {
    vi.useFakeTimers();
    const sealed = await sealData(
      { userId: "user-1", sessionId: "session-1", kind: "bearer" },
      { password: sessionOptions.password as string, ttl: 1 }
    );

    // Past the 1s ttl plus iron's 60s clock-skew allowance.
    vi.setSystemTime(new Date(Date.now() + 70_000));

    const credential = await readCredential(
      headersWith({ authorization: `Bearer ${sealed}` }),
      undefined,
      denyAppOrigin
    );

    expect(credential).toBeNull();
  });
});
