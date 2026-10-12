import { afterEach, describe, expect, it } from "vitest";
import { createServer, get, ServerResponse, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
// The pieces `next start` itself uses: its gzip middleware (untyped, hence require), its Node
// response wrapper and the function that copies a route handler's Response onto the Node response.
import { NodeNextResponse } from "next/dist/server/base-http/node";
import { sendResponse } from "next/dist/server/send-response";
import { restoreRouteCompression } from "./route-compression";

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
const compression = createRequire(import.meta.url)("next/dist/compiled/compression") as () => Middleware;

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A server that answers like a Next route handler behind Next's compression. */
async function serve(patched: boolean, answer: () => Response) {
  // A subclass, so the patch under test never touches this process's real ServerResponse.
  class Res extends ServerResponse {}
  if (patched) restoreRouteCompression(Res.prototype as never);
  const compress = compression();
  const server = createServer({ ServerResponse: Res }, (req, res) => {
    compress(req, res, () => {});
    void sendResponse(req as never, new NodeNextResponse(res) as never, answer());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return (headers: Record<string, string> = {}) =>
    new Promise<{ res: IncomingMessage; body: Buffer }>((resolve, reject) => {
      get({ host: "127.0.0.1", port, path: "/api/x", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ res, body: Buffer.concat(chunks) }));
      }).on("error", reject);
    });
}

const bigJson = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i, vendor: "K-Market", amount: 12.5 })) });
const jsonAnswer = () =>
  new Response(bigJson, {
    headers: { "Content-Type": "application/json", ETag: '"abc"', "Cache-Control": "private, no-cache", Vary: "Cookie, Authorization" },
  });

describe("restoreRouteCompression", () => {
  it("reproduces the bug: Next sends a route handler's JSON uncompressed", async () => {
    const ask = await serve(false, jsonAnswer);
    const { res, body } = await ask({ "accept-encoding": "gzip" });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(body.toString()).toBe(bigJson);
  });

  it("gzips the JSON when the client accepts it, keeping the ETag and adding Vary", async () => {
    const ask = await serve(true, jsonAnswer);
    const { res, body } = await ask({ "accept-encoding": "gzip, deflate, br" });
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers.etag).toBe('"abc"');
    expect(res.headers.vary).toMatch(/Accept-Encoding/);
    expect(gunzipSync(body).toString()).toBe(bigJson);
    expect(body.length).toBeLessThan(bigJson.length / 5);

    const plain = await ask();
    expect(plain.res.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.toString()).toBe(bigJson);
  });

  it("leaves a 304 and a no-transform stream alone", async () => {
    const notModified = await serve(true, () => new Response(null, { status: 304, headers: { ETag: '"abc"' } }));
    const r304 = await notModified({ "accept-encoding": "gzip" });
    expect(r304.res.statusCode).toBe(304);
    expect(r304.res.headers["content-encoding"]).toBeUndefined();
    expect(r304.res.headers.etag).toBe('"abc"');

    const encoder = new TextEncoder();
    const stream = await serve(true, () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("data: a\n\n"));
            controller.enqueue(encoder.encode("data: b\n\n"));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" } }
      )
    );
    const sse = await stream({ "accept-encoding": "gzip" });
    expect(sse.res.headers["content-encoding"]).toBeUndefined();
    expect(sse.body.toString()).toBe("data: a\n\ndata: b\n\n");
  });

  it("stores only a one-element Content-Type as a string", () => {
    class Res extends ServerResponse {}
    restoreRouteCompression(Res.prototype as never);
    restoreRouteCompression(Res.prototype as never);
    const res = new Res({ method: "GET" } as IncomingMessage);
    res.setHeader("content-type", ["application/json"]);
    res.setHeader("vary", ["Cookie"]);
    res.setHeader("set-cookie", ["a=1"]);
    expect(res.getHeader("content-type")).toBe("application/json");
    expect(res.getHeader("vary")).toEqual(["Cookie"]);
    expect(res.getHeader("set-cookie")).toEqual(["a=1"]);
  });
});
