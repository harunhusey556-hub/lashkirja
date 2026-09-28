"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  ONBOARDING_STEPS,
  BusinessProfile,
  generateProfileSummary,
  type ChipValue,
} from "@/lib/onboarding";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { useFocusTrap } from "@/components/useFocusTrap";
import { ArrowRight, Check, Sparkles } from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { useOverlayLock } from "@/lib/overlay-lock";

interface OnboardingModalProps {
  isOpen: boolean;
  onComplete: (profile: BusinessProfile) => void;
  initialProfile?: Partial<BusinessProfile>;
}

export function OnboardingModal({
  isOpen,
  onComplete,
  initialProfile,
}: OnboardingModalProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [profile, setProfile] = useState<BusinessProfile>({
    entityType: initialProfile?.entityType || "toiminimi",
    vatRegistered: initialProfile?.vatRegistered ?? false,
    vatPeriod: initialProfile?.vatPeriod || "month",
    salesTypes: initialProfile?.salesTypes || [],
    expenseCategories: initialProfile?.expenseCategories || [],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  // No `onEscape`: this is a mandatory, non-dismissable onboarding gate —
  // only completing it is allowed to close the modal.
  useFocusTrap(dialogRef, isOpen);
  useOverlayLock(isOpen);

  // Freeze the dashboard behind the modal; otherwise it stays scrollable
  // while onboarding is blocking the rest of the app.
  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const step = ONBOARDING_STEPS[currentStepIndex];
  const isFinalReview = currentStepIndex >= ONBOARDING_STEPS.length;

  function handleSelectChip(value: ChipValue) {
    if (!step) return;

    if (step.multiSelect) {
      // Multi-select steps collect tags, which are always strings.
      const selected = String(value);
      const fieldArr = (profile[step.field] as string[]) || [];
      const updated = fieldArr.includes(selected)
        ? fieldArr.filter((v) => v !== selected)
        : [...fieldArr, selected];

      setProfile({ ...profile, [step.field]: updated });
    } else {
      setProfile({ ...profile, [step.field]: value });
      // If user selected vatRegistered=false, skip vatPeriod step
      if (step.id === "vatRegistered" && value === false) {
        setCurrentStepIndex(currentStepIndex + 2);
        return;
      }
      setCurrentStepIndex(currentStepIndex + 1);
    }
  }

  function handleNextStep() {
    setCurrentStepIndex(currentStepIndex + 1);
  }

  async function handleApproveProfile() {
    setSaving(true);
    setError("");
    try {
      const res = await apiFetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });

      await readJson(res, "Asetusten tallennus epäonnistui");
      onComplete(profile);
    } catch (err: unknown) {
      setError(errorMessage(err, "Tallennus epäonnistui"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-md animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-modal-title"
    >
      <div
        ref={dialogRef}
        className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-card border border-line bg-surface shadow-2xl animate-scale-in"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line bg-canvas px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Icon icon={Sparkles} />
            </div>
            <div>
              <h2 id="onboarding-modal-title" className="text-[15px] font-semibold text-ink">
                LashKirja AI: Perehdytys
              </h2>
              <p className="text-[13px] text-ink-2">
                Muokataan kirjanpitosi vastaamaan liiketoimintaasi
              </p>
            </div>
          </div>

          {/* Progress dots */}
          <div className="flex items-center gap-1.5">
            {ONBOARDING_STEPS.map((_, idx) => (
              <div
                key={idx}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  idx === currentStepIndex
                    ? "w-5 bg-accent"
                    : idx < currentStepIndex
                    ? "w-1.5 bg-accent/40"
                    : "w-1.5 bg-line"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {!isFinalReview && step ? (
            <div className="space-y-6 animate-in">
              {/* AI Chat Bubble */}
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-accent text-sm font-bold text-canvas">
                  AI
                </div>
                <div className="rounded-card rounded-tl-sm border border-line bg-canvas p-4 text-[15px] leading-relaxed text-ink">
                  {step.question}
                </div>
              </div>

              {/* Interactive Chips */}
              <div className="space-y-2 pt-2">
                <p className="text-[13px] text-ink-2">
                  {step.multiSelect
                    ? "Valitse vaihtoehdot (napauta ja jatka):"
                    : "Valitse sopivin vaihtoehto:"}
                </p>
                <div className="flex flex-col gap-2.5">
                  {step.chips.map((chip) => {
                    const isSelected = step.multiSelect
                      ? ((profile[step.field] as string[]) || []).includes(
                          String(chip.value)
                        )
                      : profile[step.field] === chip.value;

                    return (
                      <button
                        key={String(chip.value)}
                        type="button"
                        onClick={() => handleSelectChip(chip.value)}
                        className={`active-press flex w-full items-center justify-between rounded-card border px-4 py-3 text-left text-[15px] font-medium ${
                          isSelected
                            ? "border-accent bg-accent-soft text-accent"
                            : "border-line bg-surface text-ink"
                        }`}
                      >
                        <span>{chip.label}</span>
                        {isSelected && <Icon icon={Check} className="text-accent" strokeWidth={2.5} />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {step.multiSelect && (
                <button
                  type="button"
                  onClick={handleNextStep}
                  className="active-press flex min-h-12 w-full items-center justify-center gap-2 rounded-card bg-ink text-[15px] font-semibold text-canvas"
                >
                  Jatka eteenpäin
                  <Icon icon={ArrowRight} size="inline" />
                </button>
              )}
            </div>
          ) : (
            /* Final Summary & Mandatory Approval Card */
            <div className="space-y-6 animate-in">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-success text-canvas">
                  <Icon icon={Check} strokeWidth={2.5} />
                </div>
                <div className="rounded-card rounded-tl-sm border border-success/30 bg-success/10 p-4 text-[15px] leading-relaxed text-ink">
                  Mahtavaa! Kiitos tiedoista. Tässä on yhteenveto sovellukseesi
                  määritettävistä asetuksista. Vahvista asetukset alta:
                </div>
              </div>

              <div className="space-y-3.5 rounded-card border border-line bg-canvas p-5">
                <h3 className="text-[13px] text-ink-2">Määritetty kirjanpitoprofiili</h3>
                <div className="space-y-2 text-[15px] text-ink">
                  <div className="flex justify-between border-b border-line py-1">
                    <span className="text-ink-2">Yritysmuoto:</span>
                    <span className="font-semibold capitalize">
                      {profile.entityType}
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-line py-1">
                    <span className="text-ink-2">ALV-rekisteri:</span>
                    <span className="font-semibold">
                      {profile.vatRegistered ? "Kyllä" : "Ei (0%)"}
                    </span>
                  </div>
                  {profile.vatRegistered && (
                    <div className="flex justify-between border-b border-line py-1">
                      <span className="text-ink-2">ALV-kausi:</span>
                      <span className="font-semibold capitalize">
                        {profile.vatPeriod}
                      </span>
                    </div>
                  )}
                  <div className="py-1">
                    <span className="mb-1 block text-ink-2">
                      Pääasialliset myynnit ja kulut:
                    </span>
                    <span className="block rounded-card border border-line bg-surface px-3 py-2 text-xs">
                      {generateProfileSummary(profile)}
                    </span>
                  </div>
                </div>
              </div>

              {error && (
                <p className="rounded-card bg-danger/10 p-3 text-xs text-danger" role="alert">
                  {error}
                </p>
              )}

              {/* Explicit Mandatory Approval Button */}
              <div className="pt-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleApproveProfile}
                  className="active-press flex min-h-12 w-full items-center justify-center gap-2 rounded-card bg-ink text-[15px] font-semibold text-canvas disabled:opacity-50"
                >
                  {saving ? (
                    "Tallennetaan…"
                  ) : (
                    <>
                      <span>Hyväksy asetukset ja aloita</span>
                      <Icon icon={ArrowRight} size="inline" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
