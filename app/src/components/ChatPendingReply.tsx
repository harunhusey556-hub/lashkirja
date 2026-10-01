"use client";

import { useEffect, useState } from "react";
import styles from "./AiChatDrawer.module.css";

/** True from sending until the first word of the answer paints: the thread ends on the user's own bubble. */
export function awaitingFirstWord(loading: boolean, last: { role: string } | undefined): boolean {
  return loading && last?.role === "user";
}

/**
 * A local answer arrives in 50-260 ms; a typing bubble that long reads as a flicker
 * (C-7). The indicator is therefore left out for answers that come at once and
 * shows only when the wait is long enough to need it.
 */
export const PENDING_REPLY_DELAY_MS = 400;

/**
 * The assistant is answering but nothing has arrived yet (F60): three soft dots in
 * the same bubble shell as an answer, after PENDING_REPLY_DELAY_MS.
 */
export function ChatPendingReply() {
  const [due, setDue] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDue(true), PENDING_REPLY_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return due ? <ChatPendingBubble /> : null;
}

/**
 * The bubble itself. role="status" gives the spoken label once; the thread
 * itself stays aria-busy so no token is announced on its own.
 */
export function ChatPendingBubble() {
  return (
    <div className="flex flex-col items-start">
      <div
        role="status"
        className={`flex h-11 items-center gap-1.5 rounded-2xl rounded-bl-md border border-line bg-surface px-4 ${styles.messageIn}`}
      >
        <span aria-hidden className={styles.typingDot} />
        <span aria-hidden className={styles.typingDot} />
        <span aria-hidden className={styles.typingDot} />
        <span className="sr-only">Avustaja kirjoittaa…</span>
      </div>
    </div>
  );
}
