"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReceiptPreview from "@/components/ReceiptPreview";
import ReceiptMatchPanel, {
  type ReceiptMatchData,
  type BankTxMatch,
} from "@/components/ReceiptMatchPanel";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  ApiError,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  categoryLabel,
  isKnownCategory,
  RECEIPT_CATEGORIES,
} from "@/lib/receipt-categories";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const ACCEPTED_UPLOAD = ".pdf,.jpg,.jpeg,.png,.heic,.heif,image/jpeg,image/png,image/heic";

const emptyForm = {
  vendor: "",
  date: "",
  totalAmount: "",
  category: "",
  customCategory: "",
  notes: "",
  type: "meno",
  vatDetails: [{ rate: "25.5", amount: "" }],
  reference: "",
  invoiceNumber: "",
};

interface ExtractedMeta {
  source: string;
  confidence: number | null;
  rawText?: string | null;
}

interface LinkedBankTx extends BankTxMatch {}

interface ReceiptEditorProps {
  /** When set, loads and edits an existing receipt */
  receiptId?: string;
}

interface ReceiptResponse {
  receipt: Record<string, unknown> & {
    filePath?: string | null;
    fileName?: string | null;
    source?: string | null;
    confidence?: number | null;
    rawText?: string | null;
    vatDetails?: string | null;
    vendor?: string | null;
    date?: string | null;
    totalAmount?: number | null;
    category?: string | null;
    notes?: string | null;
    type?: string | null;
    reference?: string | null;
    invoiceNumber?: string | null;
    linkedTransaction?: LinkedBankTx | null;
    match?: ReceiptMatchData;
  };
}

export default function ReceiptEditor({ receiptId }: ReceiptEditorProps) {
  const isEdit = Boolean(receiptId);
  const router = useRouter();
  const searchParams = useSearchParams();
  const isNewStep2 = searchParams.get("new") === "true";
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const matchPanelRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(isEdit);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [formReady, setFormReady] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [uploadId, setUploadId] = useState("");
  const [originalName, setOriginalName] = useState("");
  const [meta, setMeta] = useState<ExtractedMeta | null>(null);
  const [formData, setFormData] = useState(emptyForm);
  const [useCustomCategory, setUseCustomCategory] = useState(false);
  const [linkedTx, setLinkedTx] = useState<LinkedBankTx | null>(null);
  const [matchData, setMatchData] = useState<ReceiptMatchData>({
    status: "unlinked",
    matchCandidates: [],
  });
  const [matchBusy, setMatchBusy] = useState(false);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!receiptId) return;
    const controller = new AbortController();
    fetch(`/api/receipts/${receiptId}`, { signal: controller.signal })
      .then((response) =>
        readJson<ReceiptResponse>(response, "Kuitin lataus epäonnistui")
      )
      .then((d) => {
        if (!d.receipt || controller.signal.aborted) return;
        const r = d.receipt;
        let vatDetails = [{ rate: "25.5", amount: "" }];
        if (r.vatDetails) {
          try {
            const details = JSON.parse(r.vatDetails) as {
              rate: number;
              amount: number;
            }[];
            if (details.length > 0) {
              vatDetails = details.map((detail) => ({
                rate: String(detail.rate),
                amount: String(detail.amount),
              }));
            }
          } catch {
            /* ignore */
          }
        }
        setFilePath(r.filePath || "");
        setOriginalName(r.fileName || "");
        setMeta({
          source: r.source || "manual",
          confidence: r.confidence ?? null,
          rawText: r.rawText,
        });
        const knownCategory = isKnownCategory(r.category);
        setFormData({
          vendor: r.vendor || "",
          date: r.date ? String(r.date).slice(0, 10) : "",
          totalAmount: r.totalAmount != null ? String(r.totalAmount) : "",
          category: knownCategory ? r.category || "" : "",
          customCategory: knownCategory ? "" : r.category || "",
          notes: r.notes || "",
          type: r.type === "tulo" ? "tulo" : "meno",
          vatDetails,
          reference: r.reference || "",
          invoiceNumber: r.invoiceNumber || "",
        });
        setUseCustomCategory(!knownCategory && Boolean(r.category));
        setLinkedTx(r.linkedTransaction || null);
        setMatchData(
          r.match ?? {
            status: r.linkedTransaction ? "linked" : "unlinked",
            matchCandidates: [],
          }
        );
        setError("");
        setNotFound(false);
        setFormReady(true);
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(loadError)) {
          redirectToLogin();
          return;
        }
        if (loadError instanceof ApiError && loadError.status === 404) {
          setNotFound(true);
          setError("Kuittia ei löytynyt");
          return;
        }
        setError(errorMessage(loadError, "Kuitin lataus epäonnistui"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
        if (isNewStep2 && matchPanelRef.current) {
          setTimeout(() => {
            matchPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 500);
        }
      });
    return () => controller.abort();
  }, [receiptId, loadAttempt, isNewStep2]);

  function validateUploadFile(file: File): string | null {
    if (file.size === 0) return "Tiedosto on tyhjä";
    if (file.size > MAX_UPLOAD_BYTES) return "Tiedosto on liian suuri (enintään 15 Mt)";
    const name = file.name.toLowerCase();
    const okExt = /\.(pdf|jpe?g|png|heic|heif)$/.test(name);
    const okMime =
      file.type === "application/pdf" ||
      file.type.startsWith("image/");
    if (!okExt && !okMime) {
      return "Tuemme PDF-, JPG-, PNG- ja HEIC-tiedostoja";
    }
    return null;
  }

  async function handleFileUpload(file: File) {
    const validationError = validateUploadFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setUploading(true);
    setUploadProgress("Lähetetään tiedostoa...");
    setError("");
    setFormReady(false);
    setUploadId("");

    try {
      const fd = new FormData();
      fd.append("file", file);
      setUploadProgress("Analysoidaan kuitin tietoja...");
      const res = await fetch("/api/receipts", { method: "POST", body: fd });
      const data = await readJson<{
        uploadId: string;
        filePath: string;
        originalName: string;
        extracted: Record<string, unknown> & {
          source?: string;
          confidence?: number | null;
          rawText?: string | null;
          vendor?: string | null;
          date?: string | null;
          totalAmount?: number | null;
          category?: string | null;
          notes?: string | null;
          type?: string | null;
          vatDetails?: { rate?: number; amount?: number }[];
          reference?: string | null;
          invoiceNumber?: string | null;
        };
      }>(res, "Tiedoston käsittely epäonnistui");

      setUploadId(data.uploadId);
      setFilePath(data.filePath);
      setOriginalName(data.originalName);
      setMeta({
        source: data.extracted.source || "manual",
        confidence: data.extracted.confidence ?? null,
        rawText: data.extracted.rawText,
      });
      const knownCategory = isKnownCategory(data.extracted.category);
      setFormData({
        vendor: data.extracted.vendor || "",
        date: data.extracted.date || "",
        totalAmount: data.extracted.totalAmount?.toString() || "",
        category: knownCategory ? data.extracted.category || "" : "",
        customCategory: knownCategory ? "" : data.extracted.category || "",
        notes: data.extracted.notes || "",
        type: data.extracted.type || "meno",
        vatDetails:
          data.extracted.vatDetails && data.extracted.vatDetails.length > 0
            ? data.extracted.vatDetails.map((detail) => ({
                rate: detail.rate?.toString() || "0",
                amount: detail.amount?.toString() || "0",
              }))
            : [{ rate: "25.5", amount: "" }],
        reference: data.extracted.reference || "",
        invoiceNumber: data.extracted.invoiceNumber || "",
      });
      setUseCustomCategory(
        !knownCategory && Boolean(data.extracted.category)
      );
      setShowPreview(false);
      setFormReady(true);
      setUploadProgress("");
    } catch (uploadError: unknown) {
      if (isUnauthorized(uploadError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(uploadError, "Lataus epäonnistui"));
    } finally {
      setUploadProgress("");
      setUploading(false);
    }
  }

  async function reloadReceiptMatch() {
    if (!receiptId) return;
    const response = await fetch(`/api/receipts/${receiptId}`);
    const data = await readJson<ReceiptResponse>(
      response,
      "Kuitin lataus epäonnistui"
    );
    setLinkedTx(data.receipt.linkedTransaction || null);
    setMatchData(
      data.receipt.match ?? {
        status: data.receipt.linkedTransaction ? "linked" : "unlinked",
        matchCandidates: [],
      }
    );
  }

  async function handleMatchConfirm(transactionId: string) {
    if (!receiptId) return;
    setMatchBusy(true);
    setError("");
    try {
      const res = await fetch("/api/matching/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId, receiptId }),
      });
      if (!res.ok) await readJson(res, "Linkitys epäonnistui");
      await reloadReceiptMatch();
    } catch (matchError: unknown) {
      if (isUnauthorized(matchError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(matchError, "Linkitys epäonnistui"));
    } finally {
      setMatchBusy(false);
    }
  }

  async function handleMatchUnlink() {
    if (!receiptId || !linkedTx) return;
    setMatchBusy(true);
    setError("");
    try {
      const res = await fetch("/api/matching/unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionId: linkedTx.id }),
      });
      if (!res.ok) await readJson(res, "Linkityksen poisto epäonnistui");
      await reloadReceiptMatch();
    } catch (unlinkError: unknown) {
      if (isUnauthorized(unlinkError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(unlinkError, "Linkityksen poisto epäonnistui"));
    } finally {
      setMatchBusy(false);
    }
  }

  async function handleSave() {
    const totalAmount = Number(formData.totalAmount);
    const populatedVatRows = formData.vatDetails.filter(
      (detail) => detail.amount !== ""
    );
    if (
      formData.vatDetails.length > 1 &&
      populatedVatRows.length !== formData.vatDetails.length
    ) {
      setError("Anna ALV-summa jokaiselle riville tai poista tyhjä rivi");
      return;
    }
    const vatDetails = populatedVatRows.map((detail) => ({
      rate: Number(detail.rate),
      amount: Number(detail.amount),
    }));
    const invalidVat = vatDetails.some(
      (detail) =>
        !Number.isFinite(detail.rate) ||
        !Number.isFinite(detail.amount) ||
        detail.amount < 0
    );
    const totalVat = vatDetails.reduce((sum, detail) => sum + detail.amount, 0);
    if (!formData.vendor.trim()) {
      setError("Myyjä on pakollinen");
      return;
    }
    if (!formData.date) {
      setError("Päivämäärä on pakollinen");
      return;
    }
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      setError("Summan pitää olla suurempi kuin nolla");
      return;
    }
    const resolvedCategory = useCustomCategory
      ? formData.customCategory.trim()
      : formData.category.trim();
    if (!resolvedCategory) {
      setError(
        useCustomCategory
          ? "Kirjoita kategoria tai valitse listasta"
          : "Valitse kategoria"
      );
      return;
    }
    if (invalidVat || totalVat > totalAmount) {
      setError("Tarkista ALV-summa");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const payload = {
        vendor: formData.vendor || null,
        date: formData.date || null,
        totalAmount,
        vatDetails,
        category: resolvedCategory,
        notes: formData.notes.trim() || null,
        type: formData.type,
        reference: formData.reference || null,
        invoiceNumber: formData.invoiceNumber || null,
      };

      const res = isEdit
        ? await fetch(`/api/receipts/${receiptId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/receipts/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payload,
              uploadId,
            }),
          });

      if (!res.ok) {
        await readJson(res, "Tallennus epäonnistui");
        return;
      }

      const data = await readJson<ReceiptResponse>(res, "Tallennus epäonnistui");

      if (!isEdit && data.receipt && data.receipt.match) {
        const matchStatus = data.receipt.match.status;
        const candidates = data.receipt.match.matchCandidates;
        if (
          matchStatus === "suggested" ||
          matchStatus === "linked" ||
          (candidates && candidates.length > 0)
        ) {
          router.push(`/kuitit/${data.receipt.id as string}?new=true`);
          return;
        }
      }

      router.push("/kuitit");
    } catch (saveError: unknown) {
      if (isUnauthorized(saveError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(saveError, "Tallennus epäonnistui"));
    } finally {
      setSaving(false);
    }
  }

  const formPreviewSrc = isEdit
    ? `/api/receipts/${receiptId}/file`
    : filePath
      ? `/api/uploads/${encodeURIComponent(filePath)}`
      : null;

  if (loading) {
    return <LoadingState label="Ladataan kuittia..." />;
  }

  if (notFound) {
    return (
      <div className="space-y-4">
        <ErrorState message="Kuittia ei löytynyt" />
        <Link
          href="/kuitit"
          className="min-h-11 rounded-xl border border-warm-gray-light text-sm text-charcoal inline-flex items-center justify-center w-full hover:bg-white"
        >
          Palaa kuitteihin
        </Link>
      </div>
    );
  }

  if (isEdit && error && !formReady) {
    return (
      <ErrorState
        message={error}
        onRetry={() => {
          setError("");
          setLoading(true);
          setLoadAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {isNewStep2 && (
        <div className="bg-success/10 border border-success/20 rounded-2xl p-4 shadow-sm animate-in">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-success/20 flex items-center justify-center text-success">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-success">Kuitti tallennettu onnistuneesti!</h3>
              <p className="text-xs text-success/80 mt-0.5">Vaihe 2: Yhdistä kuitti oikeaan pankkitapahtumaan tiliotteelta.</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 animate-in">
        <Link
          href="/kuitit"
          className="w-11 h-11 flex items-center justify-center rounded-xl bg-white shadow-sm text-charcoal hover:bg-blush/40 transition-colors"
          aria-label="Takaisin"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h2 className="text-xl font-light text-charcoal">
          {isNewStep2 ? "Vaihe 2: Linkitys" : isEdit ? "Muokkaa kuittia" : "Lisää kuitti"}
        </h2>
      </div>

      {!isEdit && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_UPLOAD}
            aria-label="Valitse kuitti tai lasku tiedostona"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileUpload(f);
              e.currentTarget.value = "";
            }}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*,.heic,.heif,image/heic"
            capture="environment"
            aria-label="Ota kuva kuitista tai laskusta"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileUpload(f);
              e.currentTarget.value = "";
            }}
          />
        </>
      )}

      {!isEdit && !formReady && (
        <div className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
          <p className="text-sm text-warm-gray">
            Lisää kuitti tai lasku kuvana tai PDF-tiedostona
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex-1 py-3 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-dark transition-colors disabled:opacity-50"
            >
              Valitse tiedosto
            </button>
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              disabled={uploading}
              className="flex-1 py-3 rounded-xl bg-white text-charcoal text-sm font-medium border border-warm-gray-light hover:bg-blush/30 transition-colors disabled:opacity-50"
            >
              Ota kuva
            </button>
          </div>

          {uploading && (
            <div className="flex items-center gap-3 text-sm text-warm-gray" role="status" aria-live="polite">
              <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {uploadProgress}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-sm text-danger bg-danger/10 rounded-xl px-4 py-3" role="alert">
          {error}
        </p>
      )}

      {formReady && (
        <form
          className="bg-white rounded-2xl p-6 shadow-sm space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-charcoal">
              {isEdit ? "Kuitin tiedot" : "Tarkista tiedot"}
            </h3>
            <div className="flex items-center gap-2 shrink-0">
              {!isEdit && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="text-xs text-accent hover:underline disabled:opacity-50"
                >
                  Vaihda tiedosto
                </button>
              )}
              {meta && meta.source !== "manual" && (
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    meta.source === "ai"
                      ? "bg-success/10 text-success"
                      : "bg-warning/10 text-warning"
                  }`}
                >
                  {meta.source === "ai" ? "AI" : "OCR"}
                </span>
              )}
            </div>
          </div>

          {!isEdit &&
            meta?.confidence != null &&
            meta.confidence < 0.6 && (
              <p className="text-xs text-warning bg-warning/10 rounded-xl px-3 py-2">
                Automaattinen tunnistus epävarma — tarkista kaikki kentät ennen
                tallennusta.
              </p>
            )}

          {originalName && (
            <p className="text-xs text-warm-gray">{originalName}</p>
          )}

          {isEdit && (
            <div ref={matchPanelRef} className={isNewStep2 ? "ring-2 ring-accent ring-offset-2 rounded-2xl transition-all duration-500" : ""}>
              <ErrorBoundary>
                <ReceiptMatchPanel
                  match={matchData}
                  linkedTransaction={linkedTx}
                  busy={matchBusy}
                  onConfirm={handleMatchConfirm}
                  onUnlink={linkedTx ? handleMatchUnlink : undefined}
                />
              </ErrorBoundary>
            </div>
          )}

          {formPreviewSrc && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowPreview((v) => !v)}
                className="w-full py-2 rounded-xl border border-warm-gray-light text-xs font-medium text-charcoal hover:bg-cream transition-colors"
              >
                {showPreview ? "Piilota esikatselu" : "Näytä kuitti / lasku"}
              </button>
              {showPreview && (
                <ReceiptPreview
                  src={formPreviewSrc}
                  fileName={originalName || filePath || "kuitti"}
                />
              )}
            </div>
          )}

          {!isNewStep2 && (
            <div className="space-y-3">
            <div>
              <label htmlFor="receipt-vendor" className="block text-xs text-warm-gray mb-1">Myyjä</label>
              <input
                id="receipt-vendor"
                type="text"
                required
                value={formData.vendor}
                onChange={(e) =>
                  setFormData({ ...formData, vendor: e.target.value })
                }
                className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="receipt-date" className="block text-xs text-warm-gray mb-1">
                  Päivämäärä
                </label>
                <input
                  id="receipt-date"
                  type="date"
                  required
                  value={formData.date}
                  onChange={(e) =>
                    setFormData({ ...formData, date: e.target.value })
                  }
                  className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                />
              </div>
              <div>
                <label htmlFor="receipt-total" className="block text-xs text-warm-gray mb-1">
                  Summa (€)
                </label>
                <input
                  id="receipt-total"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={formData.totalAmount}
                  onChange={(e) =>
                    setFormData({ ...formData, totalAmount: e.target.value })
                  }
                  className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                />
              </div>
            </div>

            <fieldset className="space-y-2">
              <legend className="block text-xs text-warm-gray mb-1">
                ALV-erittely
              </legend>
              {formData.vatDetails.map((detail, index) => {
                const standardRates = ["25.5", "13.5", "10", "0"];
                const isLegacyRate = !standardRates.includes(detail.rate);
                return (
                  <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
                    <div>
                      <label
                        htmlFor={`receipt-vat-rate-${index}`}
                        className="block text-xs text-warm-gray mb-1"
                      >
                        ALV-%
                      </label>
                      <select
                        id={`receipt-vat-rate-${index}`}
                        value={detail.rate}
                        onChange={(event) => {
                          const newRate = event.target.value;
                          setFormData((prev) => {
                            let newAmount = detail.amount;
                            if (prev.vatDetails.length === 1 && prev.totalAmount) {
                              const total = parseFloat(prev.totalAmount.replace(',', '.'));
                              const rateNum = parseFloat(newRate);
                              if (!isNaN(total) && !isNaN(rateNum)) {
                                const calculatedVat = total * (rateNum / (100 + rateNum));
                                newAmount = calculatedVat.toFixed(2);
                              }
                            }
                            return {
                              ...prev,
                              vatDetails: prev.vatDetails.map((row, rowIndex) =>
                                rowIndex === index
                                  ? { ...row, rate: newRate, amount: newAmount }
                                  : row
                              ),
                            };
                          });
                        }}
                        className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                      >
                        {isLegacyRate && (
                          <option value={detail.rate}>
                            {detail.rate.replace(".", ",")} %
                          </option>
                        )}
                        <option value="25.5">25,5 %</option>
                        <option value="13.5">13,5 %</option>
                        <option value="10">10 %</option>
                        <option value="0">0 %</option>
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor={`receipt-vat-amount-${index}`}
                        className="block text-xs text-warm-gray mb-1"
                      >
                        ALV (€)
                      </label>
                      <input
                        id={`receipt-vat-amount-${index}`}
                        type="number"
                        step="0.01"
                        min="0"
                        value={detail.amount}
                        onChange={(event) =>
                          setFormData({
                            ...formData,
                            vatDetails: formData.vatDetails.map((row, rowIndex) =>
                              rowIndex === index
                                ? { ...row, amount: event.target.value }
                                : row
                            ),
                          })
                        }
                        className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setFormData({
                          ...formData,
                          vatDetails:
                            formData.vatDetails.length === 1
                              ? [{ rate: "25.5", amount: "" }]
                              : formData.vatDetails.filter(
                                  (_, rowIndex) => rowIndex !== index
                                ),
                        })
                      }
                      className="w-11 h-11 rounded-xl border border-danger/30 text-danger hover:bg-danger/10 disabled:opacity-40"
                      aria-label={`Poista ALV-rivi ${index + 1}`}
                      disabled={
                        formData.vatDetails.length === 1 &&
                        detail.amount === "" &&
                        detail.rate === "25.5"
                      }
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() =>
                  setFormData({
                    ...formData,
                    vatDetails: [
                      ...formData.vatDetails,
                      { rate: "25.5", amount: "" },
                    ],
                  })
                }
                className="min-h-11 w-full rounded-xl border border-warm-gray-light text-xs font-medium text-charcoal hover:bg-cream"
              >
                + Lisää ALV-rivi
              </button>
            </fieldset>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="receipt-reference" className="block text-xs text-warm-gray mb-1">
                  Viitenumero
                </label>
                <input
                  id="receipt-reference"
                  type="text"
                  value={formData.reference}
                  onChange={(e) =>
                    setFormData({ ...formData, reference: e.target.value })
                  }
                  placeholder="esim. 1009"
                  className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                />
              </div>
              <div>
                <label htmlFor="receipt-invoice-number" className="block text-xs text-warm-gray mb-1">
                  Laskun numero
                </label>
                <input
                  id="receipt-invoice-number"
                  type="text"
                  value={formData.invoiceNumber}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      invoiceNumber: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                />
              </div>
            </div>

            <fieldset className="space-y-3">
              <legend className="block text-xs text-warm-gray mb-1">
                Kategoria
              </legend>
              <p className="text-xs text-warm-gray leading-relaxed -mt-1">
                Valitse sopivin luokka. AI ehdottaa automaattisesti latauksen
                jälkeen.
              </p>
              <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
                {RECEIPT_CATEGORIES.map((c) => {
                  const selected = !useCustomCategory && formData.category === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setUseCustomCategory(false);
                        setFormData({ ...formData, category: c.id });
                      }}
                      className={`text-left px-3 py-2.5 rounded-xl text-sm leading-snug border transition-colors ${
                        selected
                          ? "bg-accent text-white border-accent"
                          : "bg-cream/50 text-charcoal border-warm-gray-light hover:bg-cream"
                      }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-pressed={useCustomCategory}
                  onClick={() => setUseCustomCategory(true)}
                  className={`text-left px-3 py-2.5 rounded-xl text-sm leading-snug border transition-colors ${
                    useCustomCategory
                      ? "bg-accent text-white border-accent"
                      : "bg-cream/50 text-charcoal border-warm-gray-light hover:bg-cream"
                  }`}
                >
                  Muu kategoria…
                </button>
              </div>
              {useCustomCategory && (
                <div>
                  <label
                    htmlFor="receipt-custom-category"
                    className="block text-xs text-warm-gray mb-1"
                  >
                    Oma kategoria
                  </label>
                  <input
                    id="receipt-custom-category"
                    type="text"
                    value={formData.customCategory}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        customCategory: e.target.value,
                      })
                    }
                    placeholder="esim. kalusteet, siivous"
                    className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
                  />
                </div>
              )}
              {!useCustomCategory && formData.category && (
                <p className="text-xs text-warm-gray">
                  Valittu: {categoryLabel(formData.category)}
                </p>
              )}
            </fieldset>

            <div>
              <label
                htmlFor="receipt-notes"
                className="block text-xs text-warm-gray mb-1"
              >
                Selite / lisätiedot
              </label>
              <textarea
                id="receipt-notes"
                rows={3}
                value={formData.notes}
                onChange={(e) =>
                  setFormData({ ...formData, notes: e.target.value })
                }
                placeholder="Valinnainen selite esim. miksi kategoria valittiin, mitä ostettiin, tai muu huomio kirjanpitoon"
                className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm resize-y min-h-[5rem]"
              />
            </div>

            <fieldset>
              <legend className="block text-xs text-warm-gray mb-1">Tyyppi</legend>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, type: "meno" })}
                  aria-pressed={formData.type === "meno"}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
                    formData.type === "meno"
                      ? "bg-accent text-white"
                      : "bg-cream text-charcoal border border-warm-gray-light"
                  }`}
                >
                  Meno
                </button>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, type: "tulo" })}
                  aria-pressed={formData.type === "tulo"}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
                    formData.type === "tulo"
                      ? "bg-success text-white"
                      : "bg-cream text-charcoal border border-warm-gray-light"
                  }`}
                >
                  Tulo
                </button>
              </div>
            </fieldset>
          </div>
          )}

          <div className="flex gap-3 pt-2">
            {isNewStep2 ? (
              <Link
                href="/kuitit"
                className="w-full py-3.5 rounded-xl bg-success text-white text-sm font-medium hover:bg-success/90 transition-all text-center shadow-md hover:shadow-lg hover:-translate-y-0.5"
              >
                Kaikki valmista, palaa kuitteihin
              </Link>
            ) : (
              <>
                <Link
                  href="/kuitit"
                  className="flex-1 py-3 rounded-xl border border-warm-gray-light text-sm text-warm-gray hover:bg-cream transition-colors text-center"
                >
                  Peruuta
                </Link>
                <button
                  type="submit"
                  disabled={saving || (!isEdit && !uploadId)}
                  className="flex-1 py-3 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-dark transition-colors disabled:opacity-50"
                >
                  {saving
                    ? "Tallennetaan..."
                    : isEdit
                      ? "Tallenna muutokset"
                      : "Tallenna"}
                </button>
              </>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
