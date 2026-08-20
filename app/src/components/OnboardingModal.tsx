"use client";

import React, { useEffect, useState } from "react";
import {
  ONBOARDING_STEPS,
  BusinessProfile,
  generateProfileSummary,
  type ChipValue,
} from "@/lib/onboarding";
import { errorMessage, readJson } from "@/components/clientFetch";

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
      const res = await fetch("/api/onboarding", {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-charcoal/60 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-white/50 overflow-hidden animate-scale-in flex flex-col max-h-[90dvh]">
        {/* Header */}
        <div className="px-6 py-4 bg-cream/60 border-b border-warm-gray-light/30 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-accent/15 flex items-center justify-center text-accent font-bold text-sm">
              ✨
            </div>
            <div>
              <h2 className="text-sm font-semibold text-charcoal">
                LashKirja AI — Perehdytys
              </h2>
              <p className="text-[11px] text-warm-gray">
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
                    : "w-1.5 bg-warm-gray-light"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {!isFinalReview && step ? (
            <div className="space-y-6 animate-in">
              {/* AI Chat Bubble */}
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-2xl bg-accent text-white flex items-center justify-center font-bold text-sm shrink-0 shadow-sm">
                  AI
                </div>
                <div className="bg-cream/80 border border-warm-gray-light/40 rounded-2xl rounded-tl-sm p-4 text-sm text-charcoal leading-relaxed shadow-sm">
                  {step.question}
                </div>
              </div>

              {/* Interactive Chips */}
              <div className="space-y-2 pt-2">
                <p className="text-xs font-semibold text-charcoal-light uppercase tracking-wider">
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
                        className={`w-full text-left px-4 py-3 rounded-2xl border text-sm font-medium transition-all duration-200 active-press flex items-center justify-between ${
                          isSelected
                            ? "bg-accent/10 border-accent text-accent-dark shadow-sm ring-1 ring-accent/30"
                            : "bg-white border-warm-gray-light/60 text-charcoal hover:bg-cream hover:border-warm-gray"
                        }`}
                      >
                        <span>{chip.label}</span>
                        {isSelected && (
                          <svg
                            className="w-5 h-5 text-accent shrink-0"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2.5}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {step.multiSelect && (
                <button
                  type="button"
                  onClick={handleNextStep}
                  className="w-full py-3 rounded-2xl bg-accent text-white font-medium text-sm hover:bg-accent-dark transition-all duration-200 shadow-md active-press"
                >
                  Jatka eteenpäin →
                </button>
              )}
            </div>
          ) : (
            /* Final Summary & Mandatory Approval Card */
            <div className="space-y-6 animate-in">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-2xl bg-success text-white flex items-center justify-center font-bold text-sm shrink-0 shadow-sm">
                  ✓
                </div>
                <div className="bg-success/10 border border-success/30 rounded-2xl rounded-tl-sm p-4 text-sm text-charcoal leading-relaxed shadow-sm">
                  Mahtavaa! Kiitos tiedoista. Tässä on yhteenveto sovellukseesi
                  määritettävistä asetuksista. Vahvista asetukset alta:
                </div>
              </div>

              <div className="bg-cream/60 border border-warm-gray-light/60 rounded-2xl p-5 space-y-3.5">
                <h3 className="text-xs font-bold text-charcoal-light uppercase tracking-wider">
                  Määritetty kirjanpitoprofiili
                </h3>
                <div className="space-y-2 text-sm text-charcoal">
                  <div className="flex justify-between py-1 border-b border-warm-gray-light/30">
                    <span className="text-warm-gray">Yritysmuoto:</span>
                    <span className="font-semibold capitalize">
                      {profile.entityType}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-warm-gray-light/30">
                    <span className="text-warm-gray">ALV-rekisteri:</span>
                    <span className="font-semibold">
                      {profile.vatRegistered ? "Kyllä" : "Ei (0%)"}
                    </span>
                  </div>
                  {profile.vatRegistered && (
                    <div className="flex justify-between py-1 border-b border-warm-gray-light/30">
                      <span className="text-warm-gray">ALV-kausi:</span>
                      <span className="font-semibold capitalize">
                        {profile.vatPeriod}
                      </span>
                    </div>
                  )}
                  <div className="py-1">
                    <span className="text-warm-gray block mb-1">
                      Pääasialliset myynnit ja kulut:
                    </span>
                    <span className="text-xs bg-white px-3 py-2 rounded-xl border border-warm-gray-light/40 block">
                      {generateProfileSummary(profile)}
                    </span>
                  </div>
                </div>
              </div>

              {error && (
                <p className="text-xs text-danger bg-danger/10 p-3 rounded-xl">
                  {error}
                </p>
              )}

              {/* Explicit Mandatory Approval Button */}
              <div className="pt-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleApproveProfile}
                  className="w-full py-3.5 rounded-2xl bg-accent text-white font-semibold text-sm hover:bg-accent-dark transition-all duration-200 shadow-lg shadow-accent/20 active-press disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {saving ? (
                    "Tallennetaan..."
                  ) : (
                    <>
                      <span>Hyväksy asetukset ja aloita</span>
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M14 5l7 7m0 0l-7 7m7-7H3"
                        />
                      </svg>
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
