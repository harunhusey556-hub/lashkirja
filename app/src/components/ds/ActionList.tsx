"use client";

import {
  Archive,
  ArchiveRestore,
  Ban,
  Check,
  CircleDot,
  Copy,
  FileText,
  Mail,
  Merge,
  Pencil,
  ReceiptText,
  RotateCcw,
  Search,
  Send,
  Share2,
  Trash2,
  Undo2,
  Unlink,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "./Icon";

export type ActionItem = {
  label: string;
  onSelect: () => void;
  tone?: "danger";
  disabled?: boolean;
  /** Overrides the icon picked from the label. */
  icon?: LucideIcon;
};

/**
 * The verb decides the icon, so every action sheet shows the same picture for
 * the same action (Muokkaa is always the pencil, Poista always the bin).
 * Checked in order: the first match wins.
 */
const VERB_ICONS: Array<[RegExp, LucideIcon]> = [
  [/^poist(a|etaan)|^poista luonnos/i, Trash2],
  [/^muokkaa|^nimeä/i, Pencil],
  [/pdf/i, FileText],
  [/^jaa\b/i, Share2],
  [/sähköpost/i, Mail],
  [/^kopioi luonnokseksi/i, Copy],
  [/^kopioi/i, Copy],
  [/^lähetä|lähetetyksi/i, Send],
  [/^hyvitä/i, Undo2],
  [/^sulje perustelulla/i, Ban],
  [/^sulje haku/i, X],
  [/arkistosta|^palauta/i, ArchiveRestore],
  [/^arkistoi/i, Archive],
  [/^kumoa/i, RotateCcw],
  [/^(etsi|tunnista)/i, Search],
  [/kohdistus/i, Unlink],
  [/väärä/i, X],
  [/kuitti|kuittia/i, ReceiptText],
  [/^yhdistä/i, Merge],
  [/asiaka/i, UserRound],
  [/^merkitse|^hyväksy/i, Check],
];

export function actionIcon(item: Pick<ActionItem, "label" | "icon" | "tone">): LucideIcon {
  if (item.icon) return item.icon;
  const match = VERB_ICONS.find(([pattern]) => pattern.test(item.label.trim()));
  if (match) return match[1];
  return item.tone === "danger" ? Trash2 : CircleDot;
}

/** An action sheet's rows: icon and label, one tap each. */
export function ActionList({ items, onPick }: { items: ActionItem[]; onPick?: (item: ActionItem) => void }) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      {items.map((item, index) => {
        const danger = item.tone === "danger";
        return (
          <button
            key={item.label}
            type="button"
            disabled={item.disabled}
            onClick={() => (onPick ? onPick(item) : item.onSelect())}
            className={`active-press relative flex min-h-[52px] w-full items-center gap-3 px-4 text-left text-body disabled:opacity-50 ${
              danger ? "text-danger" : "text-ink"
            }`}
          >
            {/* Inset hairline, starting under the label like an iOS list. */}
            {index > 0 && <span aria-hidden className="absolute left-[3.25rem] right-0 top-0 h-px bg-line" />}
            <span aria-hidden className={`flex w-6 shrink-0 justify-center ${danger ? "text-danger" : "text-ink-2"}`}>
              <Icon icon={actionIcon(item)} size="row" strokeWidth={1.9} />
            </span>
            <span className="min-w-0 flex-1">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
