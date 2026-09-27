"use client";

import { useEffect, useRef, useState } from "react";
import { ChatMatchProposal } from "@/lib/ai-assistant";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { STREAM_IDLE_MS, armIdleTimeout, subscribeOverlayClose } from "@/lib/screen-state";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { Button, FormError } from "@/components/ui";
import { hapticNotify } from "@/lib/haptics";
import { useOverlayLock } from "@/lib/overlay-lock";

interface ChatSourceLink {
  label: string;
  href: string;
}

interface ConversationItem {
  id: string;
  title: string;
  archivedAt?: string | null;
}

interface ChatMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  clientId?: string | null;
  proposal?: (ChatMatchProposal & { status?: "accepted" | "rejected" }) | null;
  limited?: boolean;
  sources?: ChatSourceLink[];
  status?: string;
  replyToId?: string | null;
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
  sources?: ChatSourceLink[];
  status?: string;
  replyToId?: string | null;
  conversationId?: string;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("Avustaja");
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [conversationQuery, setConversationQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [removedConversation, setRemovedConversation] = useState<ConversationItem | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);
  useOverlayLock(open);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    return subscribeOverlayClose(() => closeRef.current());
  }, [open]);

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
      return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
  }

  async function loadHistory(before?: { createdAt: string; id: string }, replace = false) {
    if (loadingRef.current && !before) return;
    setLoadingHistory(true);
    setHistoryError("");
    try {
      const params = new URLSearchParams();
      if (conversationId) params.set("conversationId", conversationId);
      if (before) {
        params.set("before", before.createdAt);
        params.set("beforeId", before.id);
      }
      const query = params.toString();
      const response = await apiFetch(query ? `/api/ai/chat?${query}` : "/api/ai/chat");
      const data = await readJson<{
        messages: ChatMessageItem[];
        hasMore?: boolean;
        conversation?: { id: string; title: string } | null;
      }>(response, "Keskusteluhistorian lataus epäonnistui");
      if (data.conversation?.id) {
        setConversationId(data.conversation.id);
        setConversationTitle(data.conversation.title);
      }
      if (replace) {
        setMessages(
          [...(data.messages ?? [])].sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
          )
        );
      } else {
        mergeHistory(data.messages ?? []);
      }
      setHasMore(Boolean(data.hasMore));
      setHistoryLoaded(true);
    } catch (error) {
      setHistoryError(errorMessage(error, "Keskusteluhistorian lataus epäonnistui"));
    } finally {
      setLoadingHistory(false);
    }
  }

  async function loadConversations(query = conversationQuery, archived = showArchived) {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (archived) params.set("archived", "1");
    const response = await apiFetch(`/api/ai/conversations?${params.toString()}`);
    const data = await readJson<{ conversations: ConversationItem[] }>(response, "Keskustelulistan lataus epäonnistui");
    setConversations(data.conversations ?? []);
  }

  useEffect(() => {
    if (open && !historyLoaded && !historyError) void loadHistory();
    // loadHistory is stable enough for the open transition; historyLoaded gates repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, historyLoaded, historyError, conversationId]);

  useEffect(() => {
    if (!open) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") abortRef.current?.abort();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [open]);

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

  async function ensureConversation(): Promise<string | null> {
    if (conversationId) return conversationId;
    const response = await apiFetch("/api/ai/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await readJson<{ id: string; title: string }>(response, "Keskustelun luonti epäonnistui");
    setConversationId(data.id);
    setConversationTitle(data.title);
    return data.id;
  }

  async function handleSendMessage(textToSend?: string, retry?: { clientId: string }) {
    const query = (textToSend || input).trim();
    if (!query || loading) return;
    if (query.length > 4000) {
      setActionError("Viesti on liian pitkä (enintään 4000 merkkiä).");
      return;
    }
    let activeConversation = conversationId;
    try {
      activeConversation = await ensureConversation();
    } catch (error) {
      setActionError(errorMessage(error, "Keskustelun luonti epäonnistui"));
      return;
    }
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
    let idleAbort = false;
    const idle = armIdleTimeout(STREAM_IDLE_MS, () => {
      idleAbort = true;
      controller.abort();
    });
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
        body: JSON.stringify({
          message: query,
          stream: true,
          clientId,
          conversationId: activeConversation,
        }),
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
        idle.bump();
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
          if (event.conversationId) setConversationId(event.conversationId);
          if (event.done || event.status === "complete") {
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
                      sources: event.sources,
                      status: event.status || "complete",
                      replyToId: event.replyToId,
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
      if (idleAbort) {
        setFailed({ text: query, clientId });
        setMessages((prev) =>
          prev.map((message) =>
            message.id === placeholderId
              ? {
                  ...message,
                  incomplete: true,
                  content: message.content || "Vastaus ei edennyt. Yritä uudelleen.",
                }
              : message
          )
        );
        return;
      }
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
      idle.stop();
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
    const response = await apiFetch("/api/ai/chat", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });
    await readJson(response, "Päätöksen tallennus epäonnistui");
  }

  async function handleConfirmProposal(msgId: string) {
    setMatchBusyId(msgId);
    setActionError("");
    try {
      await persistDecision(msgId, "accepted");
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
      await persistDecision(msgId, "rejected");
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
        <h2 id="ai-chat-title" className="flex-1 truncate text-center text-base font-medium text-charcoal">
          {conversationTitle || "Avustaja"}
        </h2>
        <button
          type="button"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((value) => !value);
            if (!menuOpen) void loadConversations();
          }}
          className="active-press min-h-11 px-2 text-sm font-medium text-charcoal"
        >
          Valikko
        </button>
      </header>
      {menuOpen && (
        <div className="max-h-72 space-y-2 overflow-y-auto border-b border-warm-gray-light/30 bg-cream/40 px-3 py-2">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void loadConversations(conversationQuery, showArchived);
            }}
          >
            <input
              value={conversationQuery}
              onChange={(event) => setConversationQuery(event.target.value)}
              aria-label="Hae keskusteluja"
              placeholder="Hae keskusteluja"
              className="min-h-11 flex-1 rounded-xl border border-warm-gray-light/60 bg-white px-3 text-sm"
            />
            <Button type="submit" variant="secondary">
              Hae
            </Button>
          </form>
          <button
            type="button"
            className="block min-h-11 w-full rounded-xl px-3 text-left text-sm"
            onClick={() => {
              void (async () => {
                const response = await apiFetch("/api/ai/conversations", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: "{}",
                });
                const data = await readJson<{ id: string; title: string }>(response, "Keskustelun luonti epäonnistui");
                setConversationId(data.id);
                setConversationTitle(data.title);
                setMessages([]);
                setHasMore(false);
                setHistoryLoaded(true);
                setFailed(null);
                setMenuOpen(false);
                stickRef.current = true;
                void loadConversations();
              })();
            }}
          >
            Uusi keskustelu
          </button>
          <button
            type="button"
            className="block min-h-11 w-full rounded-xl px-3 text-left text-sm"
            onClick={() => {
              const next = !showArchived;
              setShowArchived(next);
              void loadConversations(conversationQuery, next);
            }}
          >
            {showArchived ? "Näytä aktiiviset" : "Näytä arkisto"}
          </button>
          {conversations.length === 0 && <p className="px-3 text-sm text-warm-gray">Ei keskusteluja</p>}
          {conversations.map((conversation) => (
            <div key={conversation.id} className="rounded-xl bg-white px-3 py-2">
              {renamingId === conversation.id ? (
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void (async () => {
                      const response = await apiFetch("/api/ai/conversations", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: conversation.id, title: renameValue }),
                      });
                      const data = await readJson<{ title: string }>(response, "Nimen tallennus epäonnistui");
                      if (conversation.id === conversationId) setConversationTitle(data.title);
                      setRenamingId(null);
                      void loadConversations();
                    })();
                  }}
                >
                  <input
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    aria-label="Keskustelun nimi"
                    className="min-h-11 flex-1 rounded-xl border border-warm-gray-light/60 px-3 text-sm"
                  />
                  <Button type="submit" variant="secondary">
                    Tallenna
                  </Button>
                </form>
              ) : (
                <button
                  type="button"
                  className="block min-h-11 w-full text-left text-sm"
                  onClick={() => {
                    setConversationId(conversation.id);
                    setConversationTitle(conversation.title);
                    setMessages([]);
                    setHasMore(false);
                    setHistoryLoaded(false);
                    setHistoryError("");
                    setMenuOpen(false);
                  }}
                >
                  {conversation.title}
                </button>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="min-h-11 text-xs text-accent-dark"
                  onClick={() => {
                    setRenamingId(conversation.id);
                    setRenameValue(conversation.title);
                  }}
                >
                  Nimeä
                </button>
                <button
                  type="button"
                  className="min-h-11 text-xs text-charcoal"
                  onClick={() => {
                    void (async () => {
                      const response = await apiFetch("/api/ai/conversations", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: conversation.id, archived: !conversation.archivedAt }),
                      });
                      await readJson(response, "Arkistointi epäonnistui");
                      if (conversation.id === conversationId) {
                        setConversationId(null);
                        setConversationTitle("Avustaja");
                        setMessages([]);
                        setHistoryLoaded(false);
                      }
                      void loadConversations();
                    })();
                  }}
                >
                  {conversation.archivedAt ? "Palauta" : "Arkistoi"}
                </button>
                <button
                  type="button"
                  className="min-h-11 text-xs text-warm-gray"
                  onClick={() => {
                    void (async () => {
                      const response = await apiFetch("/api/ai/conversations", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: conversation.id, deleted: true }),
                      });
                      await readJson(response, "Poisto epäonnistui");
                      setRemovedConversation(conversation);
                      if (conversation.id === conversationId) {
                        setConversationId(null);
                        setConversationTitle("Avustaja");
                        setMessages([]);
                        setHistoryLoaded(true);
                      }
                      void loadConversations();
                    })();
                  }}
                >
                  Poista
                </button>
              </div>
            </div>
          ))}
          {removedConversation && (
            <div className="flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 text-sm">
              <span>Keskustelu poistettu</span>
              <button
                type="button"
                className="min-h-11 text-accent-dark"
                onClick={() => {
                  const removed = removedConversation;
                  void (async () => {
                    const response = await apiFetch("/api/ai/conversations", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: removed.id, deleted: false }),
                    });
                    await readJson(response, "Palautus epäonnistui");
                    setRemovedConversation(null);
                    void loadConversations();
                  })();
                }}
              >
                Kumoa
              </button>
            </div>
          )}
        </div>
      )}

      <div ref={scrollerRef} onScroll={onScroll} className="relative min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
        {hasMore && (
          <button
            type="button"
            className="mx-auto block min-h-11 text-sm text-accent-dark"
            disabled={loadingHistory}
            onClick={() => {
              const oldest = messages[0];
              if (oldest) void loadHistory({ createdAt: oldest.createdAt, id: oldest.id });
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
        {!loadingHistory && messages.length === 0 && (
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
        {messages.map((message) => (
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
            {message.sources && message.sources.length > 0 && (
              <div className="mt-1 flex max-w-[85%] flex-wrap gap-2">
                {message.sources.map((source) => (
                  <a key={source.href} href={source.href} className="text-xs text-accent-dark underline">
                    {source.label}
                  </a>
                ))}
              </div>
            )}
            {message.status === "cancelled" && (
              <p className="mt-1 text-xs text-warm-gray">Keskeytetty</p>
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
                    onClick={() => void handleConfirmProposal(message.id)}
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
            maxLength={4000}
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
