import { Check } from "lucide-react";
import { Icon } from "./Icon";

/** A data chart, with an explicit empty state rather than a fictitious 100%. */
export function ProgressRing({ done, total, complete = false }: { done: number; total: number; complete?: boolean }) {
  const percent = total > 0 ? Math.round(Math.min(1, Math.max(0, done / total)) * 100) : null;
  const circumference = 2 * Math.PI * 32;
  return (
    <div className="bookkeeping-progress" role="img" aria-label={percent === null ? "Ei tapahtumia" : `${done} / ${total} tapahtumaa kunnossa, ${percent} %`}>
      <svg aria-hidden viewBox="0 0 80 80">
        <circle cx="40" cy="40" r="32" fill="none" stroke="var(--progress-track, #EBE6DF)" strokeWidth="7" />
        <circle cx="40" cy="40" r="32" fill="none" stroke="#1F4D3A" strokeWidth="7" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - (percent ?? 0) / 100)} transform="rotate(-90 40 40)" />
      </svg>
      <span>{complete && percent === 100 ? <Icon icon={Check} size="hero" strokeWidth={2.5} /> : percent === null ? "—" : `${percent} %`}</span>
    </div>
  );
}
