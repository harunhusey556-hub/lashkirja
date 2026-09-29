"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Briefcase,
  Building2,
  Calendar,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Eye,
  GraduationCap,
  Megaphone,
  Package,
  Pencil,
  ShoppingBag,
  Sparkles,
  Store,
  UserRound,
} from "lucide-react";
import { Icon, IconTile } from "@/components/ds/Icon";
import { Button } from "@/components/ui";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { useFocusTrap } from "@/components/useFocusTrap";
import { useOverlayLock } from "@/lib/overlay-lock";
import { hapticNotify, hapticSelection } from "@/lib/haptics";
import { readReducedMotion } from "@/lib/motion-feedback";
import {
  NO_SELECTION_LABEL,
  ONBOARDING_INTRO,
  answerText,
  onboardingStep,
  onboardingSteps,
  profileFromAnswers,
  profileSummaryRows,
  type BusinessProfile,
  type ChipValue,
  type OnboardingAnswers,
  type OnboardingStepId,
} from "@/lib/onboarding";
import {
  clearOnboardingDraft,
  clearOnboardingSnooze,
  readOnboardingDraft,
  saveOnboardingDraft,
  snoozeOnboarding,
} from "@/lib/onboarding-gate";
import styles from "./onboarding.module.css";

/** Lucide icon per answer value (V1: no emoji). */
const CHOICE_ICONS: Record<string, LucideIcon> = {
  toiminimi: UserRound,
  kevytyrittaja: Briefcase,
  oy: Building2,
  true: CircleCheck,
  false: CircleSlash,
  month: CalendarDays,
  quarter: CalendarRange,
  year: Calendar,
  ripsipalvelut: Eye,
  kulmapalvelut: Sparkles,
  koulutus: GraduationCap,
  tuotemyynti: ShoppingBag,
  tarvikkeet: Package,
  vuokra: Store,
  markkinointi: Megaphone,
  koulutuskulut: BookOpen,
};

type Current = OnboardingStepId | "summary";
/** waiting: the answer just landed; typing: the indicator shows; ready: the question and its choices are up. */
type Stage = "waiting" | "typing" | "ready";

/** Timings of one answer, in ms (findings-shell, onboarding design). */
const SELECT_HOLD_MS = 180;
const TYPING_DELAY_MS = 250;
const TYPING_MS = 480;
const CHIPS_DELAY_MS = 200;
const BACK_MS = 160;
const EXIT_MS = 250;

/** The answered prefix of the thread that is still valid for these answers. */
function validDone(answers: OnboardingAnswers, done: OnboardingStepId[]): OnboardingStepId[] {
  const steps = onboardingSteps(answers);
  const result: OnboardingStepId[] = [];
  for (let index = 0; index < done.length && index < steps.length; index += 1) {
    if (done[index] !== steps[index].id || answers[steps[index].id] === undefined) break;
    result.push(done[index]);
  }
  return result;
}

function currentOf(answers: OnboardingAnswers, done: OnboardingStepId[]): Current {
  return onboardingSteps(answers)[done.length]?.id ?? "summary";
}

function AssistantAvatar({ visible }: { visible: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent ${
        visible ? "" : "invisible"
      }`}
    >
      <Icon icon={Sparkles} size="inline" />
    </span>
  );
}

function AssistantBubble({
  children,
  avatar,
  className = "",
}: {
  children: React.ReactNode;
  avatar: boolean;
  className?: string;
}) {
  return (
    <div className={`flex items-end gap-2 ${styles.theirs} ${className}`}>
      <AssistantAvatar visible={avatar} />
      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        {children}
      </div>
    </div>
  );
}

export function OnboardingChat({
  isOpen,
  onComplete,
  onSnooze,
}: {
  isOpen: boolean;
  onComplete: (profile: BusinessProfile) => void;
  /** "Ohita nyt": the gate hides for 24 h; the caller shows a way back in. */
  onSnooze: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const panelContentRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);

  const [answers, setAnswers] = useState<OnboardingAnswers>({});
  const [done, setDone] = useState<OnboardingStepId[]>([]);
  const [stage, setStage] = useState<Stage>("ready");
  const [panelHidden, setPanelHidden] = useState(false);
  /** The step whose choices are in the panel; the generation replays their entrance. */
  const [panel, setPanel] = useState<{ current: Current; generation: number }>({
    current: "entityType",
    generation: 0,
  });
  const [held, setHeld] = useState<ChipValue | null>(null);
  const [multi, setMulti] = useState<string[]>([]);
  const [removing, setRemoving] = useState<OnboardingStepId | null>(null);
  const [exiting, setExiting] = useState<"done" | "snooze" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  /** Bubbles appended in this session animate in; restored ones do not. */
  const [freshKeys, setFreshKeys] = useState<ReadonlySet<string>>(() => new Set());
  /** Back pressed while a question was showing: it fades out with the answer. */
  const [leavingQuestion, setLeavingQuestion] = useState(false);

  useOverlayLock(isOpen);
  // Mandatory flow: no Escape. Focus lands on the title so no chip shows a
  // focus ring on open (SHELL-15).
  useFocusTrap(surfaceRef, isOpen, { initialFocusRef: titleRef });

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // Restore the draft (an app kill must not restart the flow) each time the
  // gate opens. Render-phase reset keyed on the open transition.
  const [prevOpen, setPrevOpen] = useState(false);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (isOpen) {
      const draft = readOnboardingDraft();
      const restoredAnswers = draft?.answers ?? {};
      const restoredDone = validDone(restoredAnswers, draft?.done ?? []);
      const current = currentOf(restoredAnswers, restoredDone);
      setAnswers(restoredAnswers);
      setDone(restoredDone);
      setStage("ready");
      setPanelHidden(false);
      setPanel({ current, generation: 0 });
      setMulti(current !== "summary" ? multiDefault(restoredAnswers, current) : []);
      setHeld(null);
      setRemoving(null);
      setExiting(null);
      setSaving(false);
      setError("");
      setFreshKeys(new Set());
      setLeavingQuestion(false);
    }
  }

  const steps = onboardingSteps(answers);
  const current = currentOf(answers, done);
  const total = steps.length;
  const progress = current === "summary" ? 1 : done.length / total;
  const questionNumber = Math.min(done.length + 1, total);

  // Keep the newest bubble in view.
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || !isOpen) return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: readReducedMotion() ? "auto" : "smooth" });
  }, [isOpen, done, stage, removing]);

  // The panel animates to the height of its new content (no jump between a
  // two-choice and a four-choice question).
  useLayoutEffect(() => {
    const content = panelContentRef.current;
    if (!content || !isOpen) return;
    const measure = () => setPanelHeight(content.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [isOpen]);

  function persist(nextAnswers: OnboardingAnswers, nextDone: OnboardingStepId[]) {
    saveOnboardingDraft({ answers: nextAnswers, done: nextDone });
  }

  /** Commit an answer and play the reply sequence (about 900 ms, section "Sequence per answer"). */
  function commitAnswer(id: OnboardingStepId, value: ChipValue | string[]) {
    clearTimers();
    const nextAnswers: OnboardingAnswers = { ...answers, [id]: value };
    const nextDone = validDone(nextAnswers, [...done, id]);
    const next = currentOf(nextAnswers, nextDone);
    setFreshKeys((keys) => new Set([...keys, `a-${id}`, `q-${next}`]));
    setAnswers(nextAnswers);
    setDone(nextDone);
    setHeld(null);
    setPanelHidden(true);
    setStage("waiting");
    setError("");
    persist(nextAnswers, nextDone);

    const reduced = readReducedMotion();
    const typingAt = reduced ? 0 : TYPING_DELAY_MS;
    const askAt = typingAt + TYPING_MS;
    schedule(() => setStage("typing"), typingAt);
    schedule(() => setStage("ready"), askAt);
    schedule(() => {
      setPanel((value) => ({ current: next, generation: value.generation + 1 }));
      setMulti(next !== "summary" ? multiDefault(nextAnswers, next) : []);
      setPanelHidden(false);
    }, askAt + (reduced ? 0 : CHIPS_DELAY_MS));
  }

  function chooseSingle(id: OnboardingStepId, value: ChipValue) {
    if (held !== null || stage !== "ready" || panelHidden) return;
    void hapticSelection();
    // Hold the selected look for a moment so the tap registers, then advance.
    setHeld(value);
    schedule(() => commitAnswer(id, value), SELECT_HOLD_MS);
  }

  function toggleMulti(value: string) {
    void hapticSelection();
    setMulti((list) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]));
  }

  /** Reopen an earlier question: later answers stay as defaults, the thread truncates. */
  function rewindTo(id: OnboardingStepId) {
    if (saving) return;
    clearTimers();
    const index = done.indexOf(id);
    if (index < 0) return;
    void hapticSelection();
    const nextDone = done.slice(0, index);
    setDone(nextDone);
    setStage("ready");
    setHeld(null);
    setRemoving(null);
    setError("");
    setPanel((value) => ({ current: id, generation: value.generation + 1 }));
    setMulti(multiDefault(answers, id));
    setPanelHidden(false);
    persist(answers, nextDone);
  }

  /** Header back button and the left-edge swipe. */
  function goBack() {
    if (saving || removing || done.length === 0) return;
    clearTimers();
    const last = done[done.length - 1];
    void hapticSelection();
    setHeld(null);
    setLeavingQuestion(stage === "ready");
    setRemoving(last);
    setPanelHidden(true);
    setError("");
    schedule(() => {
      const nextDone = done.slice(0, -1);
      setDone(nextDone);
      setRemoving(null);
      setStage("ready");
      setPanel((value) => ({ current: last, generation: value.generation + 1 }));
      setMulti(multiDefault(answers, last));
      setPanelHidden(false);
      persist(answers, nextDone);
    }, readReducedMotion() ? 120 : BACK_MS);
  }

  function snooze() {
    if (saving || exiting) return;
    clearTimers();
    void hapticSelection();
    snoozeOnboarding();
    setExiting("snooze");
    schedule(() => onSnooze(), readReducedMotion() ? 130 : EXIT_MS);
  }

  async function approve() {
    const profile = profileFromAnswers(answers);
    if (!profile || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await apiFetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      await readJson(response, "Tallennus ei onnistunut. Yritä uudelleen.");
      clearOnboardingDraft();
      clearOnboardingSnooze();
      void hapticNotify("success");
      setExiting("done");
      schedule(() => onComplete(profile), readReducedMotion() ? 130 : EXIT_MS);
    } catch (err) {
      setError(errorMessage(err, "Tallennus ei onnistunut. Yritä uudelleen."));
      void hapticNotify("error");
      setSaving(false);
    }
  }

  // Left-edge swipe = back, the same handler as the header button.
  const swipeRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  function onTouchStart(event: React.TouchEvent) {
    const touch = event.touches[0];
    swipeRef.current = { x: touch.clientX, y: touch.clientY, active: event.touches.length === 1 && touch.clientX <= 24 };
  }
  function onTouchEnd(event: React.TouchEvent) {
    const start = swipeRef.current;
    if (!start.active) return;
    swipeRef.current.active = false;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    if (dx > 64 && dy < dx * 0.6) goBack();
  }

  if (!isOpen) return null;

  const fresh = (key: string) => freshKeys.has(key);
  const surfaceMotion =
    exiting === "done" ? styles.exitDone : exiting === "snooze" ? styles.exitSnooze : styles.enter;

  // The thread: the intro, then question + answer per answered step, then the
  // current question (or the typing indicator while the reply is "written").
  const thread: React.ReactNode[] = [];
  thread.push(
    <AssistantBubble key="intro" avatar>
      {ONBOARDING_INTRO}
    </AssistantBubble>
  );
  done.forEach((id, index) => {
    const step = onboardingStep(id);
    const leaving = removing !== null && index === done.length - 1;
    thread.push(
      <AssistantBubble
        key={`q-${id}`}
        avatar={index > 0}
        className={fresh(`q-${id}`) ? styles.bubbleIn : ""}
      >
        <p>{step.question}</p>
        {step.hint && <p className="mt-0.5 text-[13px] text-ink-2">{step.hint}</p>}
      </AssistantBubble>
    );
    const text = answerText(id, answers);
    thread.push(
      <div
        key={`a-${id}`}
        className={`flex justify-end ${styles.mine} ${
          leaving ? styles.answerOut : fresh(`a-${id}`) ? styles.bubbleIn : ""
        }`}
      >
        <button
          type="button"
          onClick={() => rewindTo(id)}
          disabled={removing !== null || saving}
          aria-label={`Muokkaa vastausta: ${text}`}
          className="active-press flex min-h-11 max-w-[85%] items-center gap-2 rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-left text-[15px] leading-snug text-canvas"
        >
          <span>{text}</span>
          <Icon icon={Pencil} size="inline" className="opacity-60" />
        </button>
      </div>
    );
  });

  // Each question after an answer starts a new assistant group (avatar);
  // the first one follows the intro in the same group.
  const nextQuestionLeaving = removing !== null && leavingQuestion;
  if (removing !== null && !leavingQuestion) {
    // Back during the reply sequence: nothing below the leaving answer.
  } else if (stage === "typing" && !nextQuestionLeaving) {
    thread.push(
      <div key="typing" className={`flex items-end gap-2 ${styles.theirs} ${styles.typingIn}`} role="status">
        <AssistantAvatar visible />
        <div className="flex h-11 items-center gap-1.5 rounded-2xl rounded-bl-md border border-line bg-surface px-4">
          <span className={styles.dot} />
          <span className={styles.dot} />
          <span className={styles.dot} />
          <span className="sr-only">Kirjoittaa</span>
        </div>
      </div>
    );
  } else if (stage === "ready" || nextQuestionLeaving) {
    const key = `q-${current}`;
    const motion = nextQuestionLeaving ? styles.bubbleOut : fresh(key) ? styles.bubbleIn : "";
    if (current === "summary") {
      const rows = profileSummaryRows(answers);
      thread.push(
        <div key={key} className={`space-y-3 ${motion}`}>
          <AssistantBubble avatar>
            Tässä yhteenveto. Tarkista ja vahvista.
          </AssistantBubble>
          <div className="ml-9 overflow-hidden rounded-card border border-line bg-surface">
            {rows.map((row, index) => (
              <button
                key={row.id}
                type="button"
                onClick={() => rewindTo(row.id)}
                disabled={saving}
                aria-label={`Muokkaa: ${row.label}, ${row.value}`}
                className={`active-press flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left ${
                  index > 0 ? "border-t border-line" : ""
                }`}
              >
                {/* Label above value: long Finnish words never overflow at 320 px. */}
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-snug text-ink-2">{row.label}</span>
                  <span className="block text-[15px] font-medium leading-snug text-ink [overflow-wrap:anywhere]">
                    {row.value}
                  </span>
                </span>
                <Icon icon={ChevronRight} size="inline" className="text-ink-2" />
              </button>
            ))}
          </div>
        </div>
      );
    } else {
      const step = onboardingStep(current);
      thread.push(
        <AssistantBubble
          key={key}
          avatar={done.length > 0}
          className={motion}
        >
          <p>{step.question}</p>
          {step.hint && <p className="mt-0.5 text-[13px] text-ink-2">{step.hint}</p>}
        </AssistantBubble>
      );
    }
  }

  const panelStep = panel.current === "summary" ? null : onboardingStep(panel.current);

  return (
    <div
      ref={surfaceRef}
      className={`${styles.surface} ${surfaceMotion}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <header className="app-header flex-none border-b border-line bg-canvas">
        <div className="mx-auto grid min-h-14 w-full max-w-lg grid-cols-[1fr_auto_1fr] items-center px-2">
          <button
            type="button"
            onClick={goBack}
            data-hidden={done.length === 0 ? "true" : undefined}
            aria-hidden={done.length === 0 || undefined}
            tabIndex={done.length === 0 ? -1 : undefined}
            className={`${styles.back} active-press flex h-11 items-center gap-0.5 justify-self-start pr-2 text-accent`}
          >
            <Icon icon={ChevronLeft} size="tab" strokeWidth={2} />
            <span className="text-[15px] font-medium">Takaisin</span>
          </button>
          <h2
            id="onboarding-title"
            ref={titleRef}
            tabIndex={-1}
            className="text-center text-[17px] font-semibold text-ink outline-none"
          >
            Perehdytys
          </h2>
          <button
            type="button"
            onClick={snooze}
            disabled={saving}
            className="active-press flex min-h-11 items-center justify-self-end px-2 text-[15px] font-medium text-accent disabled:opacity-40"
          >
            Ohita nyt
          </button>
        </div>
        <div className="mx-auto flex w-full max-w-lg items-center gap-3 px-4 pb-2">
          <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-line" aria-hidden>
            <div
              className={`h-full w-full bg-accent ${styles.progressFill}`}
              style={{ transform: `scaleX(${progress})` }}
            />
          </div>
          <span className="shrink-0 text-[13px] tabular-nums text-ink-2" aria-live="polite">
            {current === "summary" ? "Valmis" : `${questionNumber} / ${total}`}
          </span>
        </div>
      </header>

      <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4">
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col justify-end gap-3">{thread}</div>
      </div>

      {/* Quick replies live where a composer would be. */}
      <div
        className={`flex-none border-t border-line bg-canvas ${styles.panel}`}
        style={panelHeight !== null ? { height: panelHeight } : undefined}
      >
        <div
          ref={panelContentRef}
          className="mx-auto w-full max-w-lg px-4 pt-3 pb-[max(12px,var(--safe-bottom))]"
        >
          <div
            key={`${panel.current}-${panel.generation}`}
            className={styles.panelContent}
            data-hidden={panelHidden || removing !== null ? "true" : undefined}
          >
            {panelStep && !panelStep.multiSelect && (
              <div role="radiogroup" aria-label={panelStep.question} className="flex flex-col gap-2">
                {panelStep.chips.map((chip) => {
                  const selected = held !== null ? held === chip.value : answers[panelStep.id] === chip.value;
                  return (
                    <button
                      key={String(chip.value)}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => chooseSingle(panelStep.id, chip.value)}
                      className={`${styles.chipIn} active-press flex min-h-12 w-full items-center gap-3 rounded-card border px-3 py-1.5 text-left transition-colors ${
                        selected ? "border-accent bg-accent-soft" : "border-line bg-surface"
                      }`}
                    >
                      <IconTile>
                        <Icon icon={CHOICE_ICONS[String(chip.value)] ?? Check} />
                      </IconTile>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-medium leading-snug text-ink">{chip.label}</span>
                        {chip.detail && (
                          <span className="block text-[13px] leading-snug text-ink-2">{chip.detail}</span>
                        )}
                      </span>
                      {selected && (
                        <span className={styles.check}>
                          <Icon icon={Check} className="text-accent" strokeWidth={2.5} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {panelStep?.multiSelect && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-2" role="group" aria-label={panelStep.question}>
                  {panelStep.chips.map((chip) => {
                    const value = String(chip.value);
                    const selected = multi.includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleMulti(value)}
                        className={`${styles.chipIn} active-press flex min-h-12 w-full items-center gap-3 rounded-card border px-3 py-1.5 text-left transition-colors ${
                          selected ? "border-accent bg-accent-soft" : "border-line bg-surface"
                        }`}
                      >
                        <IconTile>
                          <Icon icon={CHOICE_ICONS[value] ?? Check} />
                        </IconTile>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] font-medium leading-snug text-ink">{chip.label}</span>
                          {chip.detail && (
                            <span className="block text-[13px] leading-snug text-ink-2">{chip.detail}</span>
                          )}
                        </span>
                        <span
                          aria-hidden
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                            selected ? "border-accent bg-accent text-canvas" : "border-line bg-canvas"
                          }`}
                        >
                          {selected && <Icon icon={Check} size="inline" strokeWidth={2.5} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void hapticSelection();
                    commitAnswer(panelStep.id, [...multi]);
                  }}
                  disabled={stage !== "ready" || panelHidden}
                  className={`${styles.chipIn} active-press mt-1 flex min-h-12 w-full items-center justify-center rounded-card bg-ink text-[15px] font-semibold text-canvas`}
                >
                  {multi.length === 0 ? NO_SELECTION_LABEL : "Jatka"}
                </button>
              </div>
            )}

            {panel.current === "summary" && (
              <div className="space-y-2">
                {error && (
                  <p role="alert" className="text-[13px] leading-snug text-danger">
                    {error}
                  </p>
                )}
                <Button
                  className={`${styles.chipIn} min-h-12 w-full`}
                  busy={saving}
                  busyLabel="Tallennetaan…"
                  onClick={() => void approve()}
                  disabled={exiting !== null}
                >
                  {error ? "Yritä uudelleen" : "Hyväksy ja aloita"}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A step's stored multi-select answer, used as the default when it is asked again. */
function multiDefault(answers: OnboardingAnswers, id: OnboardingStepId): string[] {
  const value = answers[id];
  return Array.isArray(value) ? [...value] : [];
}
