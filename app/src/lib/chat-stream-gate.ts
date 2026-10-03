/**
 * A3: a streamed reply is shown sentence by sentence, and only the sentences the
 * honesty guard has nothing to say about. A sentence with a euro amount, a
 * percentage, a claim that the books were changed, a record id, a link or code
 * is held, and so is everything after it (the reply stays in order), until the
 * final guard has read the whole reply. The client protocol is unchanged: the
 * same `{delta}` events, only later; the final event carries the reply as stored.
 */
import { citedEuroAmounts, replyClaimsUnperformedAction } from "./chat-honesty";
import { replyLooksLikeCode } from "./chat-scope";

const RECORD_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PERCENT = /\d\s*%|(?<![\p{L}])(?:prosent\p{L}*|percent\p{L}*|yüzde|procent\p{L}*)/iu;
const CURRENCY = /€|(?<![\p{L}])(?:eur|euro\p{L}*|avro)(?![\p{L}])/iu;
const LINK_OR_PATH = /\]\(|(?:^|[\s(:])\/[a-z]/i;
// A number at the very end may continue in the next piece ("999" then "\nEUR").
const TRAILING_NUMBER = /\d[\d\s.,  ]*$/;

/** Whether the final guard has to read this sentence before anyone sees it. */
export function sentenceNeedsGuard(sentence: string): boolean {
  return (
    citedEuroAmounts(sentence).length > 0 ||
    CURRENCY.test(sentence) ||
    PERCENT.test(sentence) ||
    replyClaimsUnperformedAction(sentence) ||
    RECORD_ID.test(sentence) ||
    LINK_OR_PATH.test(sentence) ||
    sentence.includes("`") ||
    TRAILING_NUMBER.test(sentence)
  );
}

// A sentence ends at . ! ? … followed by whitespace (so "12." in "12.50" is not an end), or at a line break.
const SENTENCE_END = /[.!?…]+(?=\s)[^\S\n]*\n*|\n+/;

export class GuardedReplyStream {
  private buffer = "";
  private releasedText = "";
  private holding = false;

  /** Everything shown so far. */
  get released(): string {
    return this.releasedText;
  }

  /** Adds a piece of the model's reply; returns the text that may be shown now ("" when nothing). */
  push(delta: string): string {
    this.buffer += delta;
    let out = "";
    while (!this.holding) {
      const end = SENTENCE_END.exec(this.buffer);
      if (!end) break;
      const stop = end.index + end[0].length;
      // A boundary at the very end of the buffer may still grow ("Hei." before its space arrives).
      if (stop === this.buffer.length && !/\s$/.test(this.buffer)) break;
      const sentence = this.buffer.slice(0, stop);
      if (sentenceNeedsGuard(sentence.trimEnd()) || replyLooksLikeCode(this.releasedText + sentence)) {
        this.holding = true;
        break;
      }
      this.releasedText += sentence;
      this.buffer = this.buffer.slice(stop);
      out += sentence;
    }
    return out;
  }

  /**
   * The text still to send once the guard has settled the reply: the rest of
   * the stored reply when it continues what was shown, nothing otherwise (the
   * final event's content replaces the streamed text on every client).
   */
  finish(final: { content: string; status: string }): string {
    if (final.status === "failed" || final.status === "cancelled") return "";
    if (!final.content.startsWith(this.releasedText)) return "";
    return final.content.slice(this.releasedText.length);
  }
}
