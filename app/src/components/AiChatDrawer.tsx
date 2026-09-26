"use client";

import { useEffect, useRef, useState } from "react";
import { ChatMatchProposal } from "@/lib/ai-assistant";
import { errorMessage, readJson } from "@/components/clientFetch";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { Button, FormError } from "@/components/ui";
import { hapticNotify } from "@/lib/haptics";
import { useOverlayLock } from "@/lib/overlay-lock";

interface ChatMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  clientId?: string | null;
  proposal?: (ChatMatchProposal & { status?: "accepted" | "rejected" }) | null;
  limited?: boolean;
  createdAt: string;
  incomplete?: boolean;
}

interface DoneEvent {
  done?: boolean;
  incomplete?: boolean;
  delta?: string;
  error?: string;
  id?: string;
  content?: string;
  proposal?: ChatMessageItem["proposal"];
  createdAt?: string;
  limited?: boolean;
}

export function AiChatDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [matchBusyId, setMatchBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [failed, setFailed] = useState<{ text: string; clientId: string } | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [cutoff, setCutoff] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);
  useOverlayLock(open);

  const visible = messages.filter((message) => !cutoff || message.createdAt >= cutoff);

  function mergeHistory(incoming: ChatMessageItem[]) {
    setMessages((current) => {
      const serverClientIds = new Set(
        incoming.map((message) => message.clientId).filter((id): id is string => Boolean(id))
      );
      const byId = new Map<string, ChatMessageItem>();
      for (const message of incoming) byId.set(message.id, message);
      for (const message of current) {
        if (byId.has(message.id)) continue;
        const localClient = message.id.startsWith("user-") ? message.id.slice(5) : message.clientId;
        if (localClient && serverClientIds.has(localClient)) continue;
        byId.set(message.id, message);
      }
      return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }

  async function loadHistory(before?: string) {
    if (loadingRef.current && !before) return;
    setLoadingHistory(true);
    setHistoryError("");
    try {
      const url = before ? `/api/ai/chat?before=${encodeURIComponent(before)}` : "/api/ai/chat";
      const response = await fetch(url);
      const data = await readJson<{ messages: ChatMessageItem[]; hasMore?: boolean }>(
        response,
        "Keskusteluhistorian lataus epäonnistui"
      );
      mergeHistory(data.messages ?? []);
      setHasMore(Boolean(data.hasMore));
      setHistoryLoaded(true);
    } catch (error) {
      setHistoryError(errorMessage(error, "Keskusteluhistorian lataus epäonnistui"));
    } finally {
      setLoadingHistory(false);
    }
  }

  useEffect(() => {
    if (open && !historyLoaded && !historyError) void loadHistory();
    // loadHistory is stable enough for the open transition; historyLoaded gates repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, historyLoaded, historyError]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !open) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else if (loading) {
      setShowJump(true);
    }
  }, [messages, loading, open]);

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distance < 72;
    if (stickRef.current) setShowJump(false);
  }

  function jumpToLatest() {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  }

  async function handleSendMessage(textToSend?: string, retry?: { clientId: string }) {
    const query = (textToSend || input).trim();
    if (!query || loading) return;
    const clientId = retry?.clientId || crypto.randomUUID();
    if (!retry) {
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${clientId}`,
          role: "user",
          content: query,
          createdAt: new Date().toISOString(),
        },
      ]);
      setInput("");
    } else {
      setMessages((prev) =>
        prev.filter((message) => !message.id.startsWith("error-") && !message.incomplete)
      );
    }
    setFailed(null);
    setActionError("");
    setLoading(true);
    loadingRef.current = true;
    stickRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const placeholderId = `stream-${clientId}`;
    let placeholderAdded = false;
    let sawDone = false;

    const paint = (next: string) => {
      if (!placeholderAdded) {
        placeholderAdded = true;
        setMessages((prev) => [
          ...prev,
          {
            id: placeholderId,
            role: "assistant",
            content: next,
            createdAt: new Date().toISOString(),
          },
        ]);
        return;
      }
      setMessages((prev) =>
        prev.map((message) => (message.id === placeholderId ? { ...message, content: next } : message))
      );
    };

    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: query, stream: true, clientId }),
        signal: controller.signal,
      });
      const type = response.headers.get("content-type") || "";
      if (!response.ok || !type.includes("text/event-stream")) {
        const data = await readJson<{
          id?: string;
          content: string;
          proposal?: ChatMessageItem["proposal"];
          createdAt?: string;
          limited?: boolean;
        }>(response, "Virhe viestin lähetyksessä");
        setMessages((prev) => [
          ...prev.filter((message) => message.id !== placeholderId),
          {
            id: data.id || `assistant-${clientId}`,
            role: "assistant",
            content: data.content,
            proposal: data.proposal,
            limited: data.limited,
            createdAt: data.createdAt || new Date().toISOString(),
          },
        ]);
        sawDone = true;
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Vastausta ei voitu lukea");
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((entry) => entry.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as DoneEvent;
          if (event.delta) {
            content += event.delta;
            paint(content);
          }
          if (event.incomplete) {
            sawDone = false;
            setFailed({ text: query, clientId });
            setMessages((prev) => {
              const rest = prev.filter((message) => message.id !== placeholderId);
              return [
                ...rest,
                {
                  id: `error-${clientId}`,
                  role: "assistant",
                  content: event.error || "Vastaus jäi kesken.",
                  createdAt: new Date().toISOString(),
                  incomplete: true,
                  limited: true,
                },
              ];
            });
            void hapticNotify("error");
            return;
          }
          if (event.done) {
            sawDone = true;
            const finalContent = event.content || content;
            setMessages((prev) =>
              prev.map((message) =>
                message.id === placeholderId
                  ? {
                      ...message,
                      id: event.id || placeholderId,
                      content: finalContent,
                      proposal: event.proposal ?? null,
                      limited: event.limited,
                      createdAt: event.createdAt || message.createdAt,
                      incomplete: false,
                    }
                  : message
              )
            );
            if (!placeholderAdded) paint(finalContent);
          }
        }
      }
      if (!sawDone) {
        setFailed({ text: query, clientId });
        setMessages((prev) =>
          prev.map((message) =>
            message.id === placeholderId ? { ...message, incomplete: true } : message
          )
        );
        void hapticNotify("error");
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === placeholderId
              ? { ...message, incomplete: true, content: message.content || "Vastaus keskeytettiin." }
              : message
          )
        );
        setFailed({ text: query, clientId });
        return;
      }
      setFailed({ text: query, clientId });
      setMessages((prev) => [
        ...prev.filter((message) => message.id !== placeholderId),
        {
          id: `error-${clientId}`,
          role: "assistant",
          content: `Viestin käsittely epäonnistui: ${errorMessage(error, "tuntematon virhe")}.`,
          createdAt: new Date().toISOString(),
          incomplete: true,
        },
      ]);
      void hapticNotify("error");
    } finally {
      setLoading(false);
      loadingRef.current = false;
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function copyMessage(message: ChatMessageItem) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId((current) => (current === message.id ? null : current)), 1500);
    } catch {
      setActionError("Kopiointi epäonnistui");
    }
  }

  async function persistDecision(id: string, decision: "accepted" | "rejected") {
    const response = await fetch("/api/ai/chat", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    await readJson(response, "Päätöksen tallennus epäonnistui");
  }

  async function handleConfirmProposal(msgId: string, proposal: ChatMatchProposal) {
    setMatchBusyId(msgId);
    setActionError("");
    try {
      const response = await fetch("/api/matching/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionId: proposal.transactionId,
          receiptId: proposal.receiptId,
        }),
      });
      await readJson(response, "Yhdistäminen epäonnistui");
      if (!msgId.startsWith("stream-") && !msgId.startsWith("error-")) {
        await persistDecision(msgId, "accepted");
      }
      setMessages((prev) =>
        prev.map((message) =>
          message.id === msgId
            ? {
                ...message,
                content: "Täsmäytys hyväksytty ja kuitti yhdistetty tiliotteeseen.",
                proposal: message.proposal ? { ...message.proposal, status: "accepted" } : null,
              }
            : message
        )
      );
      void hapticNotify("success");
    } catch (error) {
      setActionError(errorMessage(error, "Täsmäytys epäonnistui"));
      void hapticNotify("error");
    } finally {
      setMatchBusyId(null);
    }
  }

  async function handleRejectProposal(msgId: string) {
    setActionError("");
    try {
      if (!msgId.startsWith("stream-") && !msgId.startsWith("error-")) {
        await persistDecision(msgId, "rejected");
      }
      setMessages((prev) =>
        prev.map((message) =>
          message.id === msgId
            ? {
                ...message,
                proposal: message.proposal ? { ...message.proposal, status: "rejected" } : null,
              }
            : message
        )
      );
    } catch (error) {
      setActionError(errorMessage(error, "Hylkäyksen tallennus epäonnistui"));
    }
  }

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-[70] flex flex-col bg-white" role="dialog" aria-labelledby="ai-chat-title">
      <header className="app-header flex items-center gap-2 border-b border-warm-gray-light/40 px-3 pb-2">
        <button type="button" onClick={onClose} className="active-press min-h-11 px-2 text-sm font-medium text-accent-dark">
          Sulje
        </button>
        <h2 id="ai-chat-title" className="flex-1 text-center text-base font-medium text-charcoal">
          Avustaja
        </h2>
        <button
          type="button"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
          className="active-press min-h-11 px-2 text-sm font-medium text-charcoal"
        >
          Valikko
        </button>
      </header>
      {menuOpen && (
        <div className="border-b border-warm-gray-light/30 bg-cream/40 px-3 py-2">
          <button
            type="button"
            className="block min-h-11 w-full rounded-xl px-3 text-left text-sm"
            onClick={() => {
              setCutoff(new Date().toISOString());
              setMenuOpen(false);
              stickRef.current = true;
            }}
          >
            Uusi keskustelu
          </button>
          <button
            type="button"
            className="block min-h-11 w-full rounded-xl px-3 text-left text-sm"
            onClick={() => {
              setCutoff(null);
              setMenuOpen(false);
              if (!historyLoaded) void loadHistory();
            }}
          >
            Näytä historia
          </button>
        </div>
      )}

      <div ref={scrollerRef} onScroll={onScroll} className="relative min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
        {hasMore && (
          <button
            type="button"
            className="mx-auto block min-h-11 text-sm text-accent-dark"
            disabled={loadingHistory}
            onClick={() => {
              const oldest = messages[0]?.createdAt;
              if (oldest) void loadHistory(oldest);
            }}
          >
            {loadingHistory ? "Ladataan…" : "Vanhemmat viestit"}
          </button>
        )}
        {historyError && (
          <div className="space-y-2">
            <FormError message={historyError} />
            <Button variant="secondary" onClick={() => void loadHistory()}>
              Yritä ladata historia uudelleen
            </Button>
          </div>
        )}
        {loadingHistory && messages.length === 0 && (
          <p className="text-sm text-warm-gray">Ladataan keskustelua…</p>
        )}
        {!loadingHistory && visible.length === 0 && (
          <div className="space-y-3 pt-6">
            <p className="text-sm text-charcoal">Miten voin auttaa?</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void handleSendMessage("Täsmäytä kuitit")}>
                Täsmäytä kuitit
              </Button>
              <Button variant="secondary" onClick={() => void handleSendMessage("Mikä on tämän kuun ALV?")}>
                Tämän kuun ALV
              </Button>
            </div>
          </div>
        )}
        {visible.map((message) => (
          <div key={message.id} className={`flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
            <div
              className={`select-text max-w-[85%] rounded-2xl px-3.5 py-3 text-sm leading-relaxed ${
                message.role === "user" ? "bg-accent text-white" : "bg-cream text-charcoal"
              }`}
            >
              {message.role === "assistant" ? <ChatMarkdown text={message.content} /> : message.content}
            </div>
            {message.limited && message.role === "assistant" && (
              <p className="mt-1 text-xs text-warm-gray">Rajattu tila</p>
            )}
            {message.role === "assistant" && message.content && (
              <div className="mt-1 flex gap-2">
                <button type="button" className="min-h-11 text-xs text-warm-gray" onClick={() => void copyMessage(message)}>
                  {copiedId === message.id ? "Kopioitu" : "Kopioi"}
                </button>
                {message.incomplete && failed && (
                  <button
                    type="button"
                    className="min-h-11 text-xs text-accent-dark"
                    onClick={() => void handleSendMessage(failed.text, { clientId: failed.clientId })}
                  >
                    Yritä uudelleen
                  </button>
                )}
              </div>
            )}
            {message.proposal?.transactionId && message.proposal.status !== "accepted" && message.proposal.status !== "rejected" && (
              <div className="mt-2 max-w-[90%] space-y-2 rounded-2xl border border-accent/30 bg-white p-3">
                <p className="text-xs font-medium text-accent-dark">Ehdotus täsmäytykseksi</p>
                <p className="text-xs text-charcoal">{message.proposal.txSummary}</p>
                <p className="text-xs text-charcoal">{message.proposal.receiptSummary}</p>
                <div className="flex gap-2">
                  <Button
                    busy={matchBusyId === message.id}
                    busyLabel="Yhdistetään…"
                    className="flex-1 text-xs"
                    onClick={() => void handleConfirmProposal(message.id, message.proposal!)}
                  >
                    Hyväksy
                  </Button>
                  <Button variant="secondary" className="text-xs" onClick={() => void handleRejectProposal(message.id)}>
                    Hylkää
                  </Button>
                </div>
              </div>
            )}
            {message.proposal?.status === "accepted" && (
              <p className="mt-1 text-xs text-success">Täsmäytys hyväksytty</p>
            )}
            {message.proposal?.status === "rejected" && (
              <p className="mt-1 text-xs text-warm-gray">Ehdotus hylätty</p>
            )}
          </div>
        ))}
        {showJump && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="sticky bottom-2 ml-auto block rounded-full bg-charcoal px-3 py-2 text-xs text-white"
          >
            Uusi viesti ↓
          </button>
        )}
      </div>

      <form
        className="sheet-safe-bottom border-t border-warm-gray-light/40 bg-white px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSendMessage();
        }}
      >
        <FormError message={actionError} />
        {failed && !loading && (
          <Button
            variant="secondary"
            className="mb-2 text-xs"
            onClick={() => void handleSendMessage(failed.text, { clientId: failed.clientId })}
          >
            Yritä uudelleen
          </Button>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            rows={1}
            aria-label="Viesti avustajalle"
            placeholder="Kirjoita viesti…"
            onChange={(event) => {
              setInput(event.target.value);
              const field = event.target;
              field.style.height = "auto";
              field.style.height = `${Math.min(field.scrollHeight, 120)}px`;
            }}
            className="max-h-[120px] min-h-12 flex-1 resize-none rounded-xl border border-warm-gray-light/60 bg-cream/40 px-3 py-2.5 text-sm"
          />
          {loading ? (
            <Button type="button" variant="secondary" onClick={stop}>
              Pysäytä
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()}>
              Lähetä
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
