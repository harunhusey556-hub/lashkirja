"use client";

import { useEffect } from "react";
import { apiFetch } from "@/components/clientFetch";

/** Forwards window errors to the server. The server redacts and rate-limits. */
export default function ClientErrorReporter() {
  useEffect(() => {
    const send = (message: string, source: "window" | "rejection") => {
      const text = message.trim().slice(0, 300);
      if (!text) return;
      void apiFetch("/api/observe", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, source }),
      }).catch(() => {});
    };
    const onError = (event: ErrorEvent) => send(event.message || "virhe", "window");
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason ?? "");
      send(message, "rejection");
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
