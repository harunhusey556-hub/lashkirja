"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./AiChatDrawer.module.css";
import { ChatMatchProposal } from "@/lib/ai-assistant";
import { apiFetch, authorizedFetch, errorMessage, readJson } from "@/components/clientFetch";
import { STREAM_IDLE_MS, armIdleTimeout, subscribeOverlayClose } from "@/lib/screen-state";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { Button, chipClass, controlClass } from "@/components/ui";
import { ConnectionNotice } from "@/components/ScreenState";
import { Skeleton } from "@/components/ds/Skeleton";
import { useFocusTrap } from "@/components/useFocusTrap";
import { useSheetDrag } from "@/components/useSheetDrag";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Link2,
  MessagesSquare,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { hapticNotify } from "@/lib/haptics";
import { displayChatContent } from "@/lib/chat-legacy";
import { useOverlayLock } from "@/lib/overlay-lock";

interface ChatSourceLink {
  label: string;
  href: string;
}

interface ConversationItem {
  id: string;
  title: string;
  archivedAt?: string | null;
  updatedAt?: string;
}

interface ChatMessageItem {
  id: string;
  /** Stable React key: a streamed reply keeps its placeholder key when the server id arrives. */
  renderKey?: string;
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

/** Exit animation (CSS --dur-exit, 240 ms) plus a frame. */
const EXIT_MS = 250;

/**
 * Whether the server can answer free-form questions (GET /api/ai/status).
 * null = not known yet (behave as available). Re-asked on a drawer open once
 * the last answer is older than AVAILABILITY_TTL_MS, so adding the model on
 * the server shows up without killing the app.
 */
let cachedAvailability: boolean | null = null;
let availabilityCheckedAt = 0;
const AVAILABILITY_TTL_MS = 60_000;

/** The two shortcuts that always work, model or not. */
const SHORTCUTS = [
  { label: "Täsmäytä kuitit", message: "Täsmäytä kuitit" },
  { label: "Tämän kuun ALV", message: "Mikä on tämän kuun ALV?" },
];

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
  const [historyError, setHistoryError] = useState<unknown>(null);
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
  const [conversationsHasMore, setConversationsHasMore] = useState(false);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [conversationQuery, setConversationQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [removedConversation, setRemovedConversation] = useState<ConversationItem | null>(null);
  // Failures of the conversation menu's own actions (list, new, rename, archive, delete, undo)
  // show inside the menu panel instead of vanishing as an unhandled rejection.
  const [menuError, setMenuError] = useState("");
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(cachedAvailability);
  /** Messages added in this session rise in; history loads without motion. */
  const [newKeys, setNewKeys] = useState<ReadonlySet<string>>(() => new Set());
  const markNew = (key: string) => setNewKeys((keys) => new Set([...keys, key]));
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);
  useOverlayLock(open);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Exit animation (SHELL-09): closing keeps the drawer mounted for one
  // slide-down. Render-phase derived state, like BottomSheet.
  const [prevOpen, setPrevOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setClosing(!open);
    if (!open) setMenuOpen(false);
  }
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  // A real modal dialog (SHELL-10): focus moves in (to the title, so the
  // keyboard does not jump up on open), Tab stays inside, Escape closes.
  useFocusTrap(panelRef, open, { onEscape: () => closeRef.current(), initialFocusRef: titleRef });
  // Swipe down on the header closes it, with the sheet's thresholds.
  const { dragDismissed } = useSheetDrag({
    active: open,
    panelRef,
    handleRef: headerRef,
    onDismiss: () => closeRef.current(),
  });

  useEffect(() => {
    if (!open) return;
    if (cachedAvailability !== null && Date.now() - availabilityCheckedAt < AVAILABILITY_TTL_MS) return;
    let cancelled = false;
    apiFetch("/api/ai/status")
      .then((response) => readJson<{ available: boolean }>(response, ""))
      .then((data) => {
        if (typeof data?.available !== "boolean") return;
        cachedAvailability = data.available;
        availabilityCheckedAt = Date.now();
        if (!cancelled) setAiAvailable(data.available);
      })
      .catch(() => {
        // Unknown: behave as available; a failed question still explains itself.
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
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
    setHistoryError(null);
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
      setHistoryError(error);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function loadConversations(
    query = conversationQuery,
    archived = showArchived,
    before?: { updatedAt: string; id: string }
  ) {
    setLoadingConversations(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (archived) params.set("archived", "1");
      if (before) {
        params.set("before", before.updatedAt);
        params.set("beforeId", before.id);
      }
      const response = await apiFetch(`/api/ai/conversations?${params.toString()}`);
      const data = await readJson<{ conversations: ConversationItem[]; hasMore?: boolean }>(
        response,
        "Keskustelulistan lataus epäonnistui"
      );
      const page = data.conversations ?? [];
      setConversations((current) => (before ? [...current, ...page] : page));
      setConversationsHasMore(Boolean(data.hasMore));
    } finally {
      setLoadingConversations(false);
    }
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
      markNew(`user-${clientId}`);
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
        markNew(placeholderId);
        setMessages((prev) => [
          ...prev,
          {
            id: placeholderId,
            renderKey: placeholderId,
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
      const response = await authorizedFetch("/api/ai/chat", {
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
        markNew(data.id || `assistant-${clientId}`);
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
            // A retry is offered only when it can succeed.
            if (cachedAvailability !== false || event.status === "busy") setFailed({ text: query, clientId });
            markNew(`error-${clientId}`);
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
      markNew(`error-${clientId}`);
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
      await navigator.clipboard.writeText(displayChatContent(message.role, message.content));
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

  /** Runs one conversation-menu action; a failure lands in the menu's own alert. */
  async function runMenuAction(action: () => Promise<void>, fallback: string) {
    setMenuError("");
    try {
      await action();
    } catch (error) {
      setMenuError(errorMessage(error, fallback));
    }
  }

  function refreshConversations(query = conversationQuery, archived = showArchived) {
    void runMenuAction(() => loadConversations(query, archived), "Keskustelulistan lataus epäonnistui");
  }

  async function startNewConversation() {
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
    await loadConversations();
  }

  async function renameConversation(conversation: ConversationItem) {
    const response = await apiFetch("/api/ai/conversations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: conversation.id, title: renameValue }),
    });
    const data = await readJson<{ title: string }>(response, "Nimen tallennus epäonnistui");
    if (conversation.id === conversationId) setConversationTitle(data.title);
    setRenamingId(null);
    await loadConversations();
  }

  async function toggleArchive(conversation: ConversationItem) {
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
    await loadConversations();
  }

  async function removeConversation(conversation: ConversationItem) {
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
    await loadConversations();
  }

  async function undoRemove(removed: ConversationItem) {
    const response = await apiFetch("/api/ai/conversations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: removed.id, deleted: false }),
    });
    await readJson(response, "Palautus epäonnistui");
    setRemovedConversation(null);
    await loadConversations();
  }

  // A drag already moved the drawer off-screen: no second (CSS) exit.
  if (!open && (!closing || dragDismissed)) return null;

  const lastMessage = messages[messages.length - 1];
  const showShortcutsAfterLast =
    aiAvailable === false && !loading && lastMessage?.role === "assistant" && Boolean(lastMessage.limited);

  const smallAction = "active-press inline-flex min-h-11 items-center px-1 text-caption font-medium";

  return (
    <div
      ref={panelRef}
      className={`absolute inset-0 z-[70] flex flex-col bg-canvas shadow-2xl ${
        closing ? "animate-sheet-out pointer-events-none" : "animate-sheet"
      }`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-chat-title"
    >
      {/* Header: close (left), title (centre), conversation menu (right). Both controls are 36px
          circles in 44px hit boxes, the same pair the app header uses. */}
      <header ref={headerRef} className="app-header border-b border-line bg-canvas">
        {/* Same max width as the thread and the composer, so on desktop the controls frame the
            conversation instead of sitting at the far edges of the window. */}
        <div className="mx-auto grid w-full max-w-2xl grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2 px-3 pb-1.5">
        <button type="button" onClick={onClose} aria-label="Sulje" className="active-press flex h-11 w-11 items-center justify-center">
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-ink">
            <Icon icon={X} />
          </span>
        </button>
        <div className="min-w-0 text-center">
          <h2 id="ai-chat-title" ref={titleRef} tabIndex={-1} className="truncate text-headline font-semibold text-ink outline-none">
            {conversationTitle || "Avustaja"}
          </h2>
          {conversationTitle && conversationTitle !== "Avustaja" && (
            <p className="truncate text-caption text-ink-2">Avustaja</p>
          )}
        </div>
        <button
          type="button"
          aria-label="Valikko"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((value) => !value);
            if (!menuOpen) refreshConversations();
          }}
          className="active-press flex h-11 w-11 items-center justify-center"
        >
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-full border ${
              menuOpen ? "border-ink bg-ink text-canvas" : "border-line bg-surface text-ink"
            }`}
          >
            <Icon icon={MessagesSquare} />
          </span>
        </button>
        </div>
      </header>
      {/* Conversation menu: stays mounted and drops down over the thread (SHELL-10). */}
      <div className={styles.menu} data-open={menuOpen ? "true" : undefined} inert={!menuOpen}>
        <div className={styles.menuInner}>
        <div className="max-h-[50dvh] space-y-3 overflow-y-auto overscroll-contain border-b border-line bg-canvas px-4 py-3 *:mx-auto *:max-w-[40rem]">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              refreshConversations(conversationQuery, showArchived);
            }}
          >
            <input
              value={conversationQuery}
              onChange={(event) => setConversationQuery(event.target.value)}
              aria-label="Hae keskusteluja"
              placeholder="Hae keskusteluja"
              className={`${controlClass} flex-1`}
            />
            <Button type="submit" variant="secondary">
              Hae
            </Button>
          </form>
          <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
            <button
              type="button"
              className="active-press flex min-h-12 w-full items-center gap-3 px-4 text-left text-body font-medium text-ink"
              onClick={() => void runMenuAction(startNewConversation, "Keskustelun luonti epäonnistui")}
            >
              <Icon icon={Plus} className="text-ink-2" />
              Uusi keskustelu
            </button>
            <button
              type="button"
              className="active-press flex min-h-12 w-full items-center gap-3 px-4 text-left text-body font-medium text-ink"
              onClick={() => {
                const next = !showArchived;
                setShowArchived(next);
                refreshConversations(conversationQuery, next);
              }}
            >
              <Icon icon={showArchived ? MessagesSquare : Archive} className="text-ink-2" />
              {showArchived ? "Näytä aktiiviset" : "Näytä arkisto"}
            </button>
          </div>
          {menuError && (
            <p className="rounded-card border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
              {menuError}
            </p>
          )}
          {removedConversation && (
            <div className="flex items-center justify-between gap-2 rounded-card border border-line bg-surface px-4 text-body text-ink">
              <span>Keskustelu poistettu</span>
              <button
                type="button"
                className={`${smallAction} text-accent`}
                onClick={() => {
                  const removed = removedConversation;
                  void runMenuAction(() => undoRemove(removed), "Palautus epäonnistui");
                }}
              >
                Kumoa
              </button>
            </div>
          )}
          {conversations.length === 0 && !loadingConversations && (
            <p className="px-1 text-caption text-ink-2">Ei keskusteluja</p>
          )}
          {loadingConversations && conversations.length === 0 && (
            <p className="px-1 text-caption text-ink-2">Ladataan…</p>
          )}
          {conversations.length > 0 && (
            <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
              {conversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`px-4 py-1 ${conversation.id === conversationId ? "bg-accent-soft/60" : ""}`}
                >
                  {renamingId === conversation.id ? (
                    <form
                      className="flex gap-2 py-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void runMenuAction(() => renameConversation(conversation), "Nimen tallennus epäonnistui");
                      }}
                    >
                      <input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        aria-label="Keskustelun nimi"
                        className={`${controlClass} flex-1`}
                      />
                      <Button type="submit" variant="secondary">
                        Tallenna
                      </Button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="active-press block min-h-11 w-full truncate pt-2 text-left text-body font-medium text-ink"
                      onClick={() => {
                        setConversationId(conversation.id);
                        setConversationTitle(conversation.title);
                        setMessages([]);
                        setHasMore(false);
                        setHistoryLoaded(false);
                        setHistoryError(null);
                        setMenuOpen(false);
                      }}
                    >
                      {conversation.title}
                    </button>
                  )}
                  <div className="-mt-1 flex flex-wrap gap-x-4">
                    <button
                      type="button"
                      className={`${smallAction} text-accent`}
                      onClick={() => {
                        setRenamingId(conversation.id);
                        setRenameValue(conversation.title);
                      }}
                    >
                      Nimeä
                    </button>
                    <button
                      type="button"
                      className={`${smallAction} text-ink-2`}
                      onClick={() => void runMenuAction(() => toggleArchive(conversation), "Arkistointi epäonnistui")}
                    >
                      {conversation.archivedAt ? "Palauta" : "Arkistoi"}
                    </button>
                    <button
                      type="button"
                      className={`${smallAction} text-danger`}
                      onClick={() => void runMenuAction(() => removeConversation(conversation), "Poisto epäonnistui")}
                    >
                      Poista
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {conversationsHasMore && (
            <button
              type="button"
              className={`${smallAction} w-full justify-center text-accent`}
              disabled={loadingConversations}
              onClick={() => {
                const last = conversations[conversations.length - 1];
                const updatedAt = last?.updatedAt;
                if (!last || !updatedAt) return;
                void runMenuAction(
                  () => loadConversations(conversationQuery, showArchived, { updatedAt, id: last.id }),
                  "Keskustelulistan lataus epäonnistui"
                );
              }}
            >
              {loadingConversations ? "Ladataan…" : "Näytä vanhemmat"}
            </button>
          )}
        </div>
        </div>
      </div>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="relative mx-auto min-h-0 w-full max-w-2xl flex-1 overflow-y-auto overscroll-contain px-4 py-4"
      >
        {/* C1.1: the thread always has a 1 px scroll range, so it rubber-bands. */}
        <div className="thread-fill space-y-4">
        {hasMore && (
          <button
            type="button"
            className="active-press mx-auto block min-h-11 text-caption font-medium text-accent"
            disabled={loadingHistory}
            onClick={() => {
              const oldest = messages[0];
              if (oldest) void loadHistory({ createdAt: oldest.createdAt, id: oldest.id });
            }}
          >
            {loadingHistory ? "Ladataan…" : "Vanhemmat viestit"}
          </button>
        )}
        {Boolean(historyError) && (
          <ConnectionNotice
            compact
            error={historyError}
            fallback="Keskusteluhistorian lataus epäonnistui"
            onRetry={() => void loadHistory()}
          />
        )}
        {loadingHistory && messages.length === 0 && (
          // Bubble placeholders at their final sizes instead of a "Ladataan" line.
          <div className="space-y-4" role="status" aria-label="Ladataan keskustelua">
            <Skeleton radius="card" height={56} className="w-3/5" />
            <Skeleton radius="card" height={40} className="ml-auto w-2/5" />
            <Skeleton radius="card" height={72} className="w-4/5" />
          </div>
        )}
        {!loadingHistory && !historyError && messages.length === 0 && (
          <div className={`flex flex-col items-center px-2 pt-10 text-center ${historyLoaded ? styles.fadeIn : ""}`}>
            <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Icon icon={Sparkles} size="hero" />
            </span>
            <p className="mt-4 text-headline font-semibold text-ink">Miten voin auttaa?</p>
            <p className="mt-1 max-w-xs text-caption leading-relaxed text-ink-2">
              {aiAvailable === false
                ? "Avustaja osaa nyt täsmäyttää kuitit ja kertoa tämän kuun ALV:n. Laajemmat kysymykset tulevat käyttöön myöhemmin."
                : "Kysy kuiteista, tapahtumista tai ALV:stä. Ehdotukset hyväksyt aina itse."}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {SHORTCUTS.map((shortcut) => (
                <button
                  key={shortcut.label}
                  type="button"
                  className={chipClass(false)}
                  onClick={() => void handleSendMessage(shortcut.message)}
                >
                  {shortcut.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => {
          const mine = message.role === "user";
          const key = message.renderKey ?? message.id;
          return (
            <div
              key={key}
              className={`flex flex-col ${mine ? "items-end" : "items-start"} ${newKeys.has(key) ? styles.messageIn : ""}`}
            >
              <div
                className={`select-text max-w-[85%] rounded-2xl px-4 py-2.5 text-body leading-relaxed ${
                  mine
                    ? "rounded-br-md bg-ink text-canvas"
                    : `rounded-bl-md border bg-surface text-ink ${message.incomplete ? "border-danger/30" : "border-line"}`
                }`}
              >
                {message.role === "assistant" ? (
                  <ChatMarkdown text={displayChatContent(message.role, message.content)} />
                ) : (
                  message.content
                )}
              </div>
              {message.status === "cancelled" ? (
                <p className="mt-1 px-1 text-caption text-ink-2">Keskeytetty</p>
              ) : null}
              {/* Sources and the message actions share one quiet row under the bubble. */}
              {message.role === "assistant" && (message.content || (message.sources && message.sources.length > 0)) && (
                <div className="flex max-w-[85%] flex-wrap items-center gap-x-4 px-1">
                  {message.sources?.map((source) => (
                    <a
                      key={source.href}
                      href={source.href}
                      className="active-press inline-flex min-h-11 items-center gap-1.5 text-caption font-medium text-accent"
                    >
                      <Icon icon={Link2} size="inline" />
                      {source.label}
                    </a>
                  ))}
                  {message.content && (
                    <button
                      type="button"
                      className="active-press inline-flex min-h-11 items-center gap-1.5 text-caption font-medium text-ink-2"
                      onClick={() => void copyMessage(message)}
                    >
                      <Icon icon={copiedId === message.id ? Check : Copy} size="inline" />
                      {copiedId === message.id ? "Kopioitu" : "Kopioi"}
                    </button>
                  )}
                  {message.content && message.incomplete && failed && !loading && (
                    <button
                      type="button"
                      className="active-press inline-flex min-h-11 items-center gap-1.5 text-caption font-medium text-accent"
                      onClick={() => void handleSendMessage(failed.text, { clientId: failed.clientId })}
                    >
                      <Icon icon={RotateCcw} size="inline" />
                      Yritä uudelleen
                    </button>
                  )}
                </div>
              )}
              {message.proposal?.transactionId &&
                message.proposal.status !== "accepted" &&
                message.proposal.status !== "rejected" && (
                  <div className="mt-1 w-full max-w-[90%] space-y-3 rounded-card border border-line bg-surface p-4">
                    <p className="flex items-center gap-2 text-caption font-semibold text-accent">
                      <Icon icon={Link2} size="inline" />
                      Ehdotus täsmäytykseksi
                    </p>
                    <div className="space-y-1 text-caption leading-relaxed text-ink">
                      {/* A no-break space keeps "139,00 €" on one line. */}
                      <p>{message.proposal.txSummary.replace(/ €/g, " €")}</p>
                      <p>{message.proposal.receiptSummary.replace(/ €/g, " €")}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        busy={matchBusyId === message.id}
                        busyLabel="Yhdistetään…"
                        className="flex-1"
                        onClick={() => void handleConfirmProposal(message.id)}
                      >
                        Hyväksy
                      </Button>
                      <Button variant="secondary" className="flex-1" onClick={() => void handleRejectProposal(message.id)}>
                        Hylkää
                      </Button>
                    </div>
                  </div>
                )}
              {message.proposal?.status === "accepted" && (
                <p className="mt-1 flex items-center gap-1.5 px-1 text-caption font-medium text-success">
                  <Icon icon={Check} size="inline" />
                  Täsmäytys hyväksytty
                </p>
              )}
              {message.proposal?.status === "rejected" && (
                <p className="mt-1 px-1 text-caption text-ink-2">Ehdotus hylätty</p>
              )}
              {message === lastMessage && showShortcutsAfterLast && (
                // Without a model, a question it cannot answer ends with what does work.
                <div className="mt-1 flex flex-wrap gap-2">
                  {SHORTCUTS.map((shortcut) => (
                    <button
                      key={shortcut.label}
                      type="button"
                      className={chipClass(false)}
                      onClick={() => void handleSendMessage(shortcut.message)}
                    >
                      {shortcut.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {showJump && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="active-press sticky bottom-2 ml-auto flex min-h-11 items-center gap-1.5 rounded-full bg-ink px-4 text-caption font-semibold text-canvas"
          >
            Uusi viesti
            <Icon icon={ArrowDown} size="inline" />
          </button>
        )}
        </div>
      </div>

      <form
        className="sheet-safe-bottom border-t border-line bg-canvas px-3 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSendMessage();
        }}
      >
        <div className="mx-auto w-full max-w-[40rem] space-y-2">
          {actionError && (
            <p className="rounded-card border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger" role="alert">
              {actionError}
            </p>
          )}
          {failed && !loading && !messages.some((message) => message.incomplete && message.content) && (
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => void handleSendMessage(failed.text, { clientId: failed.clientId })}
            >
              <Icon icon={RotateCcw} size="inline" />
              Yritä uudelleen
            </Button>
          )}
          {/* One rounded field with the send/stop control inside it, as in native messaging apps. */}
          <div className="flex items-end gap-1 rounded-[24px] border border-line bg-surface py-0.5 pl-4 pr-0.5 focus-within:border-ink-2/60">
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
              className="max-h-[120px] min-h-11 flex-1 resize-none bg-transparent py-2.5 text-input leading-6 text-ink outline-none placeholder:text-ink-2"
            />
            {loading ? (
              <button type="button" aria-label="Pysäytä" onClick={stop} className="active-press flex h-11 w-11 shrink-0 items-center justify-center">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-canvas text-ink">
                  <Square aria-hidden width={14} height={14} fill="currentColor" strokeWidth={0} />
                </span>
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Lähetä"
                disabled={!input.trim()}
                className="active-press flex h-11 w-11 shrink-0 items-center justify-center disabled:opacity-40"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-canvas">
                  <Icon icon={ArrowUp} strokeWidth={2.25} />
                </span>
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
