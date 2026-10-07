import type { Instrumentation } from "next";

/**
 * Errors Next.js catches itself (routes without withErrorHandler, server
 * rendering) go to the event log with the request id the app sent.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { errorFields, writeEvents } = await import("@/lib/event-log");
  const requestId = request.headers["x-request-id"];
  await writeEvents([
    {
      source: "server",
      kind: "error",
      requestId: Array.isArray(requestId) ? requestId[0] : requestId,
      method: request.method,
      path: request.path.split("?")[0],
      routePath: context.routePath,
      routeType: context.routeType,
      digest:
        typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined,
      ...errorFields(error),
    },
  ]);
};
