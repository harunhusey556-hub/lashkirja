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
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useEditorSession } from "@/components/form-session";
import { Button, FormError, SavePhaseNote } from "@/components/ui";
import { SelectMenu, SelectOption } from "@/components/SelectMenu";
import { parseFinnishNumber, parseMoneyInput } from "@/lib/format";
import { focusFirstInvalid } from "@/lib/focus-field";
import { clearDraft } from "@/lib/draft-store";
import { receiptFieldId, validateReceiptFields } from "@/lib/receipt-form";
import { RECEIPT_PHASE } from "@/lib/screen-state";
import { isLowConfidenceField } from "@/lib/receipt-confidence";
import {
  categoryLabel,
  isKnownCategory,
  RECEIPT_CATEGORIES,
} from "@/lib/receipt-categories";
import {
  useReceiptUploadQueue,
  type ReadyUpload,
} from "@/components/useReceiptUploadQueue";

const ACCEPTED_UPLOAD = ".pdf,.jpg,.jpeg,.png,.heic,.heif,image/jpeg,image/png,image/heic";

function queueStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Jonossa";
    case "uploading":
      return "Lähetetään";
    case "processing":
      return "Käsitellään";
    case "ready":
      return "Valmis";
    case "failed":
      return "Epäonnistui";
    case "cancelled":
      return "Peruttu";
    case "background":
      return "Taustalla";
    default:
      return status;
  }
}

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
  fieldConfidence?: { vendor?: number; date?: number; totalAmount?: number } | null;
}

type LinkedBankTx = BankTxMatch;

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
    updatedAt?: string;
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
  const [uploadProgress, setUploadProgress] = useState("");
  const [saving, setSaving] = useState(false);
  const [formReady, setFormReady] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [uploadId, setUploadId] = useState("");
  const [originalName, setOriginalName] = useState("");
  const [meta, setMeta] = useState<ExtractedMeta | null>(null);
  const [formData, setFormData] = useState(emptyForm);
  const [baseline, setBaseline] = useState(emptyForm);
  const [updatedAt, setUpdatedAt] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
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
  const [forceDuplicate, setForceDuplicate] = useState(false);
  const [vendorRuleActive, setVendorRuleActive] = useState(false);
  const [vendorRuleBusy, setVendorRuleBusy] = useState(false);
  const draftKey = receiptId ? `receipt:${receiptId}` : "receipt:new";
  const session = useEditorSession({
    sourceId: draftKey,
    draftKey,
    baseline,
    value: formData,
    active: !isEdit || formReady,
    onRestore: setFormData,
  });

  function applyUpload(upload: ReadyUpload) {
    const knownCategory = isKnownCategory(upload.extracted.category);
    setUploadId(upload.uploadId);
    setFilePath(upload.filePath);
    setOriginalName(upload.originalName);
    setMeta({
      source: upload.extracted.source || "ocr",
      confidence: upload.extracted.confidence ?? null,
      rawText: upload.extracted.rawText,
      fieldConfidence: upload.extracted.fieldConfidence,
    });
    setFormData({
      vendor: upload.extracted.vendor || "",
      date: upload.extracted.date || "",
      totalAmount: upload.extracted.totalAmount?.toString() || "",
      category: knownCategory ? upload.extracted.category || "" : "",
      customCategory: knownCategory ? "" : upload.extracted.category || "",
      notes: upload.extracted.notes || "",
      type: upload.extracted.type || "meno",
      vatDetails:
        upload.extracted.vatDetails && upload.extracted.vatDetails.length > 0
          ? upload.extracted.vatDetails.map((detail) => ({
              rate: detail.rate?.toString() || "0",
              amount: detail.amount?.toString() || "0",
            }))
          : [{ rate: "25.5", amount: "" }],
      reference: upload.extracted.reference || "",
      invoiceNumber: upload.extracted.invoiceNumber || "",
    });
    setUseCustomCategory(!knownCategory && Boolean(upload.extracted.category));
    setFormReady(true);
    setError("");
    setUploadProgress(RECEIPT_PHASE.review);
  }

  const uploadQueue = useReceiptUploadQueue(applyUpload);
  const uploading = uploadQueue.rows.some(
    (row) => row.status === "uploading" || row.status === "processing"
  );
  const openExistingId =
    uploadQueue.rows.find((row) => row.duplicateReceiptId)?.duplicateReceiptId ?? null;

  useEffect(() => {
    if (!formReady) return;
    const vendor = formData.vendor.trim();
    if (!vendor) {
      setVendorRuleActive(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      apiFetch(`/api/vendor-rules?vendor=${encodeURIComponent(vendor)}`, {
        signal: controller.signal,
      })
        .then((response) => readJson<{ rule: { active?: boolean } | null }>(response, "Säännön haku epäonnistui"))
        .then((data) => {
          if (!controller.signal.aborted) setVendorRuleActive(Boolean(data.rule?.active));
        })
        .catch(() => {
          if (!controller.signal.aborted) setVendorRuleActive(false);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [formReady, formData.vendor]);

  useEffect(() => {
    if (!receiptId) return;
    const controller = new AbortController();
    apiFetch(`/api/receipts/${receiptId}`, { signal: controller.signal })
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
        const loaded = {
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
        };
        setFormData(loaded);
        setBaseline(loaded);
        setUpdatedAt(r.updatedAt ? String(r.updatedAt) : "");
        setConflict(false);
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

  async function saveVendorRule() {
    const vendor = formData.vendor.trim();
    const category = (useCustomCategory ? formData.customCategory : formData.category).trim();
    if (!vendor || !category) {
      setError("Anna myyjä ja kategoria ennen sääntöä.");
      return;
    }
    setVendorRuleBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/vendor-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor, category }),
      });
      if (!response.ok) await readJson(response, "Säännön tallennus epäonnistui");
      setVendorRuleActive(true);
    } catch (ruleError: unknown) {
      if (isUnauthorized(ruleError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(ruleError, "Säännön tallennus epäonnistui"));
    } finally {
      setVendorRuleBusy(false);
    }
  }

  async function undoVendorRule() {
    const vendor = formData.vendor.trim();
    if (!vendor) return;
    setVendorRuleBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/vendor-rules/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor }),
      });
      if (!response.ok) await readJson(response, "Säännön kumoaminen epäonnistui");
      setVendorRuleActive(false);
    } catch (ruleError: unknown) {
      if (isUnauthorized(ruleError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(ruleError, "Säännön kumoaminen epäonnistui"));
    } finally {
      setVendorRuleBusy(false);
    }
  }

  async function reloadReceiptMatch() {
    if (!receiptId) return;
    const response = await apiFetch(`/api/receipts/${receiptId}`);
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
      const res = await apiFetch("/api/matching/confirm", {
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
      const res = await apiFetch("/api/matching/unlink", {
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
    const resolvedCategory = useCustomCategory
      ? formData.customCategory.trim()
      : formData.category.trim();
    const nextFieldErrors = validateReceiptFields({
      vendor: formData.vendor,
      date: formData.date,
      totalAmount: formData.totalAmount,
      category: resolvedCategory,
    });
    const totalAmount = parseMoneyInput(formData.totalAmount) ?? NaN;
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
      amount: parseMoneyInput(detail.amount) ?? NaN,
    }));
    const invalidVat = vatDetails.some(
      (detail) =>
        !Number.isFinite(detail.rate) ||
        !Number.isFinite(detail.amount) ||
        detail.amount < 0
    );
    const totalVat = vatDetails.reduce((sum, detail) => sum + detail.amount, 0);
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setError("");
      focusFirstInvalid(
        nextFieldErrors,
        ["vendor", "date", "totalAmount", "category"],
        (key) => (key === "category" && useCustomCategory ? "receipt-custom-category" : receiptFieldId(key))
      );
      return;
    }
    if (invalidVat || totalVat > totalAmount) {
      setFieldErrors({});
      setError("Tarkista ALV-summa");
      return;
    }
    setFieldErrors({});

    setSaving(true);
    setError("");
    setConflict(false);
    session.setPhase("saving");
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
        ? await apiFetch(`/api/receipts/${receiptId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payload,
              ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}),
            }),
          })
        : await apiFetch("/api/receipts/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payload,
              uploadId,
              forceDuplicate,
            }),
          });

      if (!res.ok) {
        try {
          await readJson(res, "Tallennus epäonnistui");
        } catch (e: unknown) {
          // details is untyped by nature; read the one flag this path needs.
          const duplicate =
            e instanceof ApiError &&
            e.status === 409 &&
            typeof e.details === "object" &&
            e.details !== null &&
            (e.details as { isDuplicate?: boolean }).isDuplicate === true;
          if (duplicate) {
            setForceDuplicate(true);
            setError(e.message);
            session.setPhase("failed");
            setSaving(false);
            return;
          }
          if (e instanceof ApiError && e.message.includes("Lataa tiedot uudelleen")) {
            setConflict(true);
            setError(e.message);
            session.setPhase("failed");
            setSaving(false);
            return;
          }
          throw e;
        }
        return;
      }

      const data = await readJson<ReceiptResponse>(res, "Tallennus epäonnistui");
      session.clearSavedDraft();
      session.setPhase("saved");
      setUploadProgress(RECEIPT_PHASE.done);
      setBaseline(formData);
      if (data.receipt?.updatedAt) setUpdatedAt(String(data.receipt.updatedAt));

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
      session.setPhase("failed");
    } finally {
      setSaving(false);
    }
  }

  const formPreviewSrc = isEdit
    ? `/api/receipts/${receiptId}/file`
    : filePath
      ? `/api/uploads/${encodeURIComponent(filePath)}`
      : null;
  const lowVendor = isLowConfidenceField({
    value: formData.vendor,
    overall: meta?.confidence,
    field: meta?.fieldConfidence?.vendor,
  });
  const lowDate = isLowConfidenceField({
    value: formData.date,
    overall: meta?.confidence,
    field: meta?.fieldConfidence?.date,
  });
  const lowAmount = isLowConfidenceField({
    value: formData.totalAmount,
    overall: meta?.confidence,
    field: meta?.fieldConfidence?.totalAmount,
  });
  const uncertainClass = "border-warning ring-2 ring-warning";

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

      <div className="animate-in">
        <h2 className="text-xl font-medium text-charcoal tracking-tight">
          {isNewStep2 ? "Vaihe 2: Linkitys" : isEdit ? "Muokkaa kuittia" : "Lisää kuitti"}
        </h2>
      </div>

      {!isEdit && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_UPLOAD}
            multiple
            aria-label="Valitse kuitti tai lasku tiedostona"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) uploadQueue.enqueue(files);
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
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) uploadQueue.enqueue(files);
              e.currentTarget.value = "";
            }}
          />
        </>
      )}

      {!isEdit && !formReady && (
        <div className="bg-white rounded-[32px] p-8 border border-warm-gray-light/30 shadow-sm space-y-6 text-center animate-in fade-in slide-in-from-bottom-2">
          <div className="mx-auto w-12 h-12 bg-cream/50 rounded-full flex items-center justify-center text-warm-gray mb-2">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
          </div>
          <p className="text-sm font-medium text-charcoal tracking-tight">
            Lisää kuitti tai lasku kuvana tai PDF-tiedostona
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center max-w-sm mx-auto">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex-1 py-3 px-4 rounded-full bg-charcoal text-white text-sm font-medium shadow-sm hover:bg-black transition-colors disabled:opacity-50 active:scale-95"
            >
              Valitse tiedosto
            </button>
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              disabled={uploading}
              className="flex-1 py-3 px-4 rounded-full bg-white text-charcoal text-sm font-medium hover:bg-cream/50 shadow-sm transition-colors disabled:opacity-50 active:scale-95"
            >
              Ota kuva
            </button>
          </div>

          {uploading && (
            <div className="flex items-center justify-center gap-3 text-sm text-warm-gray pt-4" role="status" aria-live="polite">
              <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {uploadQueue.rows.find((row) => row.status === "uploading" || row.status === "processing")?.progress || uploadProgress}
            </div>
          )}
        </div>
      )}

      {!isEdit && uploadQueue.rows.length > 0 && (
        <div className="bg-white rounded-3xl border border-warm-gray-light/30 shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-charcoal">Lähetysjono</h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => uploadQueue.cancel()}
                className="min-h-11 px-3 text-xs font-medium text-charcoal"
              >
                Peruuta
              </button>
              <button
                type="button"
                onClick={() => uploadQueue.retryFailed()}
                className="min-h-11 px-3 text-xs font-medium text-accent"
              >
                Yritä epäonnistuneet
              </button>
            </div>
          </div>
          <ul className="space-y-2">
            {uploadQueue.rows.map((row) => (
              <li key={row.localId} className="rounded-xl border border-warm-gray-light/40 px-3 py-2 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 break-words font-medium text-charcoal">{row.name}</p>
                  <p className="shrink-0 text-xs text-warm-gray">{queueStatusLabel(row.status)}</p>
                </div>
                {row.progress && <p className="text-xs text-warm-gray mt-1">{row.progress}</p>}
                {row.error && <p className="text-xs text-danger mt-1">{row.error}</p>}
                {row.duplicateReceiptId && (
                  <Link href={`/kuitit/${row.duplicateReceiptId}`} className="text-xs font-medium text-accent mt-1 inline-flex min-h-11 items-center">
                    Avaa olemassa oleva
                  </Link>
                )}
                {row.status === "ready" && (
                  <button
                    type="button"
                    onClick={() => uploadQueue.useReady(row.localId)}
                    className="text-xs font-medium text-accent min-h-11"
                  >
                    Käytä lomakkeessa
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <FormError message={error} className="bg-danger/10 rounded-xl px-4 py-3" />
      {openExistingId && (
        <Link
          href={`/kuitit/${openExistingId}`}
          className="min-h-11 inline-flex items-center text-sm font-medium text-accent"
        >
          Avaa olemassa oleva
        </Link>
      )}

      {uploadProgress && !uploading && (
        <p className="text-sm text-warm-gray text-center" role="status" aria-live="polite">
          {uploadProgress}
        </p>
      )}

      {formReady && (
        <form
          className="bg-white rounded-[32px] p-6 sm:p-8 border border-warm-gray-light/30 shadow-sm space-y-6 pb-8 animate-in fade-in slide-in-from-bottom-2"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <div className="flex items-center justify-between gap-2 pb-2">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-charcoal">
              {isEdit ? "Kuitin tiedot" : "Tarkista tiedot"}
            </h3>
            <div className="flex items-center gap-2 shrink-0">
              {!isEdit && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="min-h-11 inline-flex items-center px-2 -mx-2 text-xs text-accent hover:underline disabled:opacity-50"
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

          {!isNewStep2 && (
            <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            {formPreviewSrc && (
              <ReceiptPreview
                src={formPreviewSrc}
                fileName={originalName || filePath || "kuitti"}
              />
            )}
            <div className="space-y-4">
            <div>
              <label htmlFor="receipt-vendor" className="block text-[10px] font-medium tracking-wider uppercase text-warm-gray mb-1.5">Myyjä</label>
              <input
                id="receipt-vendor"
                type="text"
                required
                value={formData.vendor}
                onChange={(e) =>
                  setFormData({ ...formData, vendor: e.target.value })
                }
                aria-invalid={Boolean(fieldErrors.vendor) || undefined}
                aria-describedby={fieldErrors.vendor ? "receipt-vendor-error" : undefined}
                className={`w-full min-h-12 min-w-0 px-3 rounded-xl border bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm ${lowVendor ? uncertainClass : "border-warm-gray-light/50"}`}
              />
              {lowVendor && !fieldErrors.vendor && (
                <p className="mt-1.5 text-xs text-warning">Epävarma tunnistus</p>
              )}
              {fieldErrors.vendor && (
                <p id="receipt-vendor-error" className="mt-1.5 text-xs text-danger" role="alert">
                  {fieldErrors.vendor}
                </p>
              )}
            </div>

            <div className="field-dates">
              <div>
                <label htmlFor="receipt-date" className="block text-[10px] font-medium tracking-wider uppercase text-warm-gray mb-1.5">
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
                  aria-invalid={Boolean(fieldErrors.date) || undefined}
                  aria-describedby={fieldErrors.date ? "receipt-date-error" : undefined}
                  className={`w-full min-h-12 min-w-0 px-3 rounded-xl border bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm ${lowDate ? uncertainClass : "border-warm-gray-light/50"}`}
                />
                {lowDate && !fieldErrors.date && (
                  <p className="mt-1.5 text-xs text-warning">Epävarma tunnistus</p>
                )}
                {fieldErrors.date && (
                  <p id="receipt-date-error" className="mt-1.5 text-xs text-danger" role="alert">
                    {fieldErrors.date}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="receipt-total" className="block text-[10px] font-medium tracking-wider uppercase text-warm-gray mb-1.5">
                  Summa (€)
                </label>
                <input
                  id="receipt-total"
                  type="text"
                  inputMode="decimal"
                  placeholder="0,00"
                  required
                  value={formData.totalAmount}
                  onChange={(e) =>
                    setFormData({ ...formData, totalAmount: e.target.value })
                  }
                  aria-invalid={Boolean(fieldErrors.totalAmount) || undefined}
                  aria-describedby={fieldErrors.totalAmount ? "receipt-total-error" : undefined}
                  className={`w-full min-h-12 min-w-0 px-3 rounded-xl border bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm ${lowAmount ? uncertainClass : "border-warm-gray-light/50"}`}
                />
                {lowAmount && !fieldErrors.totalAmount && (
                  <p className="mt-1.5 text-xs text-warning">Epävarma tunnistus</p>
                )}
                {fieldErrors.totalAmount && (
                  <p id="receipt-total-error" className="mt-1.5 text-xs text-danger" role="alert">
                    {fieldErrors.totalAmount}
                  </p>
                )}
              </div>
            </div>
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
                      <SelectMenu
                        id={`receipt-vat-rate-${index}`}
                        label="ALV-%"
                        value={detail.rate}
                        options={[
                          ...(isLegacyRate
                            ? [{ value: detail.rate, label: `${detail.rate.replace(".", ",")} %` }]
                            : []),
                          { value: "25.5", label: "25,5 %", description: "Yleinen (mm. palvelut & tuotteet)" },
                          { value: "13.5", label: "13,5 %", description: "Ravintola, kirjat, liikunta" },
                          { value: "10", label: "10 %", description: "Sanoma-/aikakauslehdet" },
                          { value: "0", label: "0 %", description: "Vienti / veroton" },
                        ]}
                        onChange={(newRate) => {
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
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`receipt-vat-amount-${index}`}
                        className="block text-[10px] font-medium tracking-wider uppercase text-warm-gray mb-1.5"
                      >
                        ALV (€)
                      </label>
                      <input
                        id={`receipt-vat-amount-${index}`}
                        type="text"
                        inputMode="decimal"
                        placeholder="0,00"
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
                        className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light/50 bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm"
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
                      className="w-11 h-11 flex items-center justify-center rounded-xl border border-danger/30 text-danger hover:bg-danger/10 disabled:opacity-40 transition-colors"
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
                className="active-press min-h-12 w-full rounded-xl border border-warm-gray-light/70 bg-white text-sm font-medium text-charcoal hover:bg-cream transition-colors shadow-sm"
              >
                + Lisää ALV-rivi
              </button>
            </fieldset>

            <div className="field-grid">
              <div>
                <label htmlFor="receipt-reference" className="block text-[10px] font-medium tracking-wider uppercase text-warm-gray mb-1.5">
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
                  className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light/50 bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm"
                />
              </div>
              <div>
                <label htmlFor="receipt-invoice-number" className="block text-[10px] font-medium tracking-wider uppercase text-warm-gray mb-1.5">
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
                  className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light/50 bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm"
                />
              </div>
            </div>

            <fieldset className="space-y-3">
              <legend className="block text-[10px] font-medium tracking-wider uppercase text-warm-gray mb-1.5">
                Kategoria
              </legend>
              
              {(formData.category || useCustomCategory) ? (
                <div className="space-y-3 animate-in fade-in">
                  <SelectMenu
                    id="receipt-category"
                    label="Valittu kategoria"
                    value={useCustomCategory ? "custom" : formData.category}
                    options={[
                      ...RECEIPT_CATEGORIES.map(c => ({ value: c.id, label: c.label })),
                      { value: "custom", label: "Muu kategoria…" }
                    ]}
                    onChange={(newCat) => {
                      if (newCat === "custom") {
                        setUseCustomCategory(true);
                      } else {
                        setUseCustomCategory(false);
                        setFormData({ ...formData, category: newCat });
                      }
                    }}
                  />
                  {useCustomCategory && (
                    <div className="pt-1 animate-in fade-in slide-in-from-top-1">
                      <label
                        htmlFor="receipt-custom-category"
                        className="block text-[10px] font-medium tracking-wider uppercase text-warm-gray mb-1.5"
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
                        className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light/50 bg-white text-sm transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm"
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto overscroll-contain pr-1 animate-in fade-in">
                  {RECEIPT_CATEGORIES.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={false}
                      onClick={() => {
                        setUseCustomCategory(false);
                        setFormData({ ...formData, category: c.id });
                      }}
                      className="text-left px-4 py-3 rounded-xl text-sm leading-snug border bg-white text-charcoal border-warm-gray-light/50 hover:bg-cream/50 transition-colors shadow-sm"
                    >
                      {c.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-pressed={false}
                    onClick={() => setUseCustomCategory(true)}
                    className="text-left px-4 py-3 rounded-xl text-sm leading-snug border bg-white text-charcoal border-warm-gray-light/50 hover:bg-cream/50 transition-colors shadow-sm"
                  >
                    Muu kategoria…
                  </button>
                </div>
              )}
              {fieldErrors.category && (
                <p id="receipt-category-error" className="text-xs text-danger" role="alert">
                  {fieldErrors.category}
                </p>
              )}
            </fieldset>

            <div className="flex flex-wrap gap-2">
              {vendorRuleActive ? (
                <Button type="button" variant="secondary" busy={vendorRuleBusy} onClick={() => void undoVendorRule()}>
                  Kumoa sääntö
                </Button>
              ) : (
                <Button type="button" variant="secondary" busy={vendorRuleBusy} onClick={() => void saveVendorRule()}>
                  Käytä tälle myyjälle myöhemmin
                </Button>
              )}
            </div>

            <div>
              <label
                htmlFor="receipt-notes"
                className="block text-[10px] font-medium tracking-wider uppercase text-warm-gray mb-1.5"
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
                placeholder="Valinnainen selite kirjanpitoon..."
                className="w-full px-4 py-3 rounded-xl border border-warm-gray-light/50 bg-white text-sm resize-y min-h-[5rem] transition-colors focus:border-accent outline-none focus:ring-1 focus:ring-accent shadow-sm"
              />
            </div>

            <fieldset>
              <legend className="block text-[10px] font-medium tracking-wider uppercase text-warm-gray mb-1.5">Tyyppi</legend>
              <div className="flex gap-2 p-1.5 bg-white border border-warm-gray-light/30 rounded-3xl shadow-sm">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, type: "meno" })}
                  aria-pressed={formData.type === "meno"}
                  className={`flex-1 py-2 px-4 rounded-full text-sm font-medium transition-colors ${
                    formData.type === "meno"
                      ? "bg-charcoal text-white shadow-sm"
                      : "text-charcoal hover:bg-cream/50"
                  }`}
                >
                  Meno
                </button>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, type: "tulo" })}
                  aria-pressed={formData.type === "tulo"}
                  className={`flex-1 py-2 px-4 rounded-full text-sm font-medium transition-colors ${
                    formData.type === "tulo"
                      ? "bg-charcoal text-white shadow-sm"
                      : "text-charcoal hover:bg-cream/50"
                  }`}
                >
                  Tulo
                </button>
              </div>
            </fieldset>
          </div>
          )}

          {session.notice && (
            <p className="text-sm text-charcoal" role="status">
              {session.notice}{" "}
              <button
                type="button"
                className="font-medium text-accent-dark underline"
                onClick={() => {
                  session.clearSavedDraft();
                  setFormData(baseline);
                }}
              >
                Hylkää luonnos
              </button>
            </p>
          )}
          <SavePhaseNote phase={session.phase} error={error} />
          {conflict && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                clearDraft(draftKey);
                setConflict(false);
                setLoadAttempt((attempt) => attempt + 1);
              }}
            >
              Lataa uudelleen
            </Button>
          )}
          <div className="flex gap-3 pt-4 border-t border-warm-gray-light/20 mt-4">
            {isNewStep2 ? (
              <Link
                href="/kuitit"
                className="w-full py-3 px-4 rounded-full bg-success text-white text-sm font-medium hover:bg-success/90 transition-all text-center shadow-sm active:scale-95"
              >
                Kaikki valmista, palaa kuitteihin
              </Link>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => session.requestCancel(() => router.push("/kuitit"))}
                >
                  Peruuta
                </Button>
                <Button
                  type="submit"
                  busy={saving}
                  busyLabel="Tallennetaan…"
                  disabled={!isEdit && !uploadId}
                  disabledReason={!isEdit && !uploadId ? "Liitä ensin kuitti." : undefined}
                  className={`flex-1 ${forceDuplicate ? "bg-warning-dark! hover:bg-warning!" : ""}`}
                >
                  {forceDuplicate ? "Tallenna silti" : isEdit ? "Tallenna muutokset" : "Tallenna"}
                </Button>
              </>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
