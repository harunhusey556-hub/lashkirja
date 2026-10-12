import { ServerResponse } from "node:http";

/**
 * Lets `next start`'s own gzip reach route-handler responses (W28).
 *
 * Next copies a route handler's Response headers onto the Node response with
 * NodeNextResponse.appendHeader, which always stores an array, so Content-Type
 * becomes ["application/json"]. Next's compression middleware tests the type
 * with `compressible()`, which accepts only a string: every API answer was sent
 * uncompressed while pages and static files were gzipped. Storing a one-element
 * Content-Type as the string it is changes nothing on the wire (Content-Type is
 * single-valued) and lets the middleware decide as it does for pages: gzip when
 * the client accepts it, nothing for `Cache-Control: no-transform` (the AI chat
 * stream), HEAD, 304 or already-encoded bodies; ETag and streaming untouched.
 */
const PATCHED = Symbol.for("lashkirja.route-compression");

type Patchable = { setHeader: ServerResponse["setHeader"]; [PATCHED]?: true };

export function restoreRouteCompression(proto: Patchable = ServerResponse.prototype as Patchable): void {
  if (proto[PATCHED]) return;
  const setHeader = proto.setHeader;
  proto.setHeader = function (this: ServerResponse, name: string, value: number | string | readonly string[]) {
    const single =
      Array.isArray(value) && value.length === 1 && typeof value[0] === "string" && name.toLowerCase() === "content-type";
    return setHeader.call(this, name, single ? value[0] : value);
  } as ServerResponse["setHeader"];
  proto[PATCHED] = true;
}
