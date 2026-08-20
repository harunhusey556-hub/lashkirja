"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChatMatchProposal } from "@/lib/ai-assistant";
import { readJson,
  errorMessage,
} from "@/components/clientFetch";

import BottomSheet from "@/components/BottomSheet";
import { LoadingState } from "@/components/AsyncState";
interface ChatMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  proposal?: ChatMatchProposal | null;
  createdAt: string;
}

interface ChatResponse {
  id?: string;
  content: string;
  proposal?: ChatMatchProposal | null;
  createdAt?: string;
}

export function AiChatDrawer() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [matchBusyId, setMatchBusyId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && !historyLoaded) {
      setLoadingHistory(true);
      fetch("/api/ai/chat")
        .then((res) => readJson<{ messages: ChatMessageItem[] }>(res, ""))
        .then((data) => {
          if (data && data.messages && Array.isArray(data.messages)) {
            setMessages(data.messages);
          }
        })
        .catch(() => {})
        .finally(() => {
          setLoadingHistory(false);
          setHistoryLoaded(true);
        });
    }
  }, [isOpen, historyLoaded]);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isOpen]);

  async function handleSendMessage(textToSend?: string) {
    const query = textToSend || input;
    if (!query.trim() || loading) return;

    const userMsg: ChatMessageItem = {
      id: String(Date.now()),
      role: "user",
      content: query.trim(),
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!textToSend) setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg.content }),
      });
      const data = await readJson<ChatResponse>(res, "Virhe viestin lähetyksessä");

      setMessages((prev) => [
        ...prev,
        {
          id: data.id || String(Date.now() + 1),
          role: "assistant",
          content: data.content,
          proposal: data.proposal,
          createdAt: data.createdAt || new Date().toISOString(),
        },
      ]);
    } catch (err: unknown) {
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now() + 2),
          role: "assistant",
          content: `Pahoittelut, viestin käsittely epäonnistui: ${errorMessage(
            err,
            "tuntematon virhe"
          )}. Yritä uudelleen!`,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmProposal(
    msgId: string,
    proposal: ChatMatchProposal
  ) {
    setMatchBusyId(msgId);
    try {
      const res = await fetch("/api/matching/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionId: proposal.transactionId,
          receiptId: proposal.receiptId,
        }),
      });

      await readJson(res, "Yhdistäminen epäonnistui");

      // Update message state to show match confirmed
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === msgId
            ? {
                ...msg,
                content: "✅ Täsmäytys hyväksytty ja kuitti yhdistetty tiliotteeseen!",
                proposal: null,
              }
            : msg
        )
      );
    } catch (err: unknown) {
      alert(errorMessage(err, "Täsmäytys epäonnistui"));
    } finally {
      setMatchBusyId(null);
    }
  }

  function handleRejectProposal(msgId: string) {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === msgId
          ? {
              ...msg,
              content: "Ehdotus hylätty.",
              proposal: null,
            }
          : msg
      )
    );
  }

  return (
    <>
      {/* Floating Trigger Badge Button */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="fixed right-4 z-40 bottom-[calc(var(--app-tab-height)+var(--safe-bottom)+0.75rem)] min-h-11 px-4 py-2.5 rounded-full bg-accent text-white font-medium text-xs shadow-xl hover:bg-accent-dark transition-all duration-300 hover-lift active-press flex items-center gap-2 border border-white/40 glass"
        aria-label="Avaa tekoälyapuri"
      >
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping motion-reduce:animate-none" />
        <span>LashKirja AI</span>
      </button>

      <BottomSheet
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="LashKirja AI"
        subtitle="Kysy ALV-ohjeita tai anna tekoälyn etsiä kuitteja"
        labelledBy="ai-chat-title"
        heightClass="h-[85dvh]"
      >
            {/* Quick Action Chips */}
            <div className="shrink-0 px-4 py-2 bg-cream/30 border-b border-warm-gray-light/20 flex items-center gap-2 overflow-x-auto scrollbar-none">
              <button
                type="button"
                onClick={() => handleSendMessage("Etsi täsmäytettäviä kuitteja ja laskuja")}
                className="min-h-11 inline-flex items-center text-[11px] px-3 py-1.5 rounded-full bg-accent/10 text-accent-dark font-medium border border-accent/20 whitespace-nowrap hover:bg-accent/20 transition-colors active-press"
              >
                🔍 Täsmäytä kuitit
              </button>
              <button
                type="button"
                onClick={() => handleSendMessage("Mikä on ripsienpidennysten ALV-kanta?")}
                className="min-h-11 inline-flex items-center text-[11px] px-3 py-1.5 rounded-full bg-white text-charcoal font-medium border border-warm-gray-light whitespace-nowrap hover:bg-cream transition-colors active-press"
              >
                💡 ALV-ohjeet
              </button>
            </div>

            {/* Messages Body */}
            <div
              className={`flex-1 min-h-0 p-4 overflow-y-auto space-y-4 ${
                messages.length === 0 && !loading ? "flex flex-col justify-center" : ""
              }`}
            >
              {loadingHistory && messages.length === 0 && (
                <LoadingState label="Ladataan keskustelua…" compact />
              )}

              {!loadingHistory && messages.length === 0 && !loading && (
                // Centred rather than stuck to the top: an empty chat with a
                // wall of white above the composer reads as broken.
                <div className="text-center space-y-2.5">
                  <div className="w-12 h-12 rounded-3xl bg-accent/10 text-accent mx-auto flex items-center justify-center text-xl font-bold">
                    💬
                  </div>
                  <p className="text-sm font-medium text-charcoal">
                    Miten voin auttaa kirjanpidossasi tänään?
                  </p>
                  <p className="text-xs text-warm-gray max-w-xs mx-auto">
                    Voit kysyä Suomen ALV-säännöistä tai pyytää minua etsimään tiliotteen tapahtumiin sopivia kuitteja.
                  </p>
                </div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${
                    msg.role === "user" ? "items-end" : "items-start"
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl p-3.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-accent text-white rounded-tr-xs shadow-sm"
                        : "bg-cream/80 text-charcoal border border-warm-gray-light/40 rounded-tl-xs shadow-xs"
                    }`}
                  >
                    {msg.content}
                  </div>

                  {/* Match Proposal Card (Human Approval Required) */}
                  {msg.proposal && (
                    <div className="mt-2.5 max-w-[90%] bg-white border border-accent/30 rounded-2xl p-4 shadow-md space-y-3 animate-in">
                      <div className="flex items-center justify-between border-b border-warm-gray-light/30 pb-2">
                        <span className="text-[11px] font-bold text-accent-dark uppercase tracking-wider">
                          Ehdotus täsmäytykseksi ({Math.round(msg.proposal.confidenceScore * 100)}% varmuus)
                        </span>
                      </div>

                      <div className="space-y-2 text-xs">
                        <div className="bg-cream/50 p-2.5 rounded-xl border border-warm-gray-light/30">
                          <span className="text-warm-gray block text-[10px]">Pankkitapahtuma:</span>
                          <span className="font-semibold text-charcoal">{msg.proposal.txSummary}</span>
                        </div>
                        <div className="bg-cream/50 p-2.5 rounded-xl border border-warm-gray-light/30">
                          <span className="text-warm-gray block text-[10px]">Vastaava kuitti:</span>
                          <span className="font-semibold text-charcoal">{msg.proposal.receiptSummary}</span>
                        </div>
                      </div>

                      {/* Explicit Human Approval Action Buttons */}
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          disabled={matchBusyId === msg.id}
                          onClick={() => handleConfirmProposal(msg.id, msg.proposal!)}
                          className="flex-1 min-h-11 py-2 rounded-xl bg-accent text-white text-xs font-semibold hover:bg-accent-dark transition-all shadow-sm active-press disabled:opacity-50"
                        >
                          {matchBusyId === msg.id ? "Yhdistetään..." : "Hyväksy täsmäytys ✓"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRejectProposal(msg.id)}
                          className="min-h-11 px-3 py-2 rounded-xl border border-warm-gray-light text-xs font-medium text-warm-gray hover:bg-cream transition-colors"
                        >
                          Hylkää
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div className="flex items-center gap-2 text-xs text-warm-gray bg-cream/50 p-3 rounded-2xl max-w-[70%]">
                  <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin motion-reduce:animate-none" />
                  <span>Tehdään hakuja...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="shrink-0 p-3 bg-white border-t border-warm-gray-light/40 flex items-center gap-2 sheet-safe-bottom"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Kirjoita viesti tekoälyapurille..."
                aria-label="Viesti tekoälyapurille"
                className="flex-1 px-3.5 py-2.5 rounded-xl border border-warm-gray-light/60 bg-cream/30 text-sm focus:bg-white transition-colors"
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                className="w-10 h-10 rounded-xl bg-accent text-white flex items-center justify-center hover:bg-accent-dark transition-colors disabled:opacity-40 shrink-0 shadow-sm"
              >
                ➔
              </button>
            </form>
      </BottomSheet>
    </>
  );
}
