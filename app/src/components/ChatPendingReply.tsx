import styles from "./AiChatDrawer.module.css";

/** True from sending until the first word of the answer paints: the thread ends on the user's own bubble. */
export function awaitingFirstWord(loading: boolean, last: { role: string } | undefined): boolean {
  return loading && last?.role === "user";
}

/**
 * The assistant is answering but nothing has arrived yet (F60): three soft dots in
 * the same bubble shell as an answer. role="status" gives the spoken label once;
 * the thread itself stays aria-busy so no token is announced on its own.
 */
export function ChatPendingReply() {
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
