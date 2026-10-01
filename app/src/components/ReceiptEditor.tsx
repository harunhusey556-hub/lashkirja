"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReceiptPreview from "@/components/ReceiptPreview";
import ReceiptMatchPanel, {
  type ReceiptMatchData,
  type BankTxMatch,
} from "@/components/ReceiptMatchPanel";
import { ErrorState } from "@/components/AsyncState";
import { FieldsSkeleton, ReceiptDetailSkeleton } from "@/components/books/Skeletons";
import { Skeleton, SkeletonGroup } from "@/components/ds";
import {
  clearPendingCapture,
  HANDOFF_MAX_AGE_MS,
  hasPendingCapture,
  PENDING_CAPTURE_PARAMS,
  stripPendingCaptureFlag,
  takePendingCapture,
} from "@/lib/pending-capture";
import ConfirmModal from "@/components/ConfirmModal";
import {
  ApiError,
  apiFetch,
  errorMessage,
  fieldErrorsFromApi,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useEditorSession } from "@/components/form-session";
import { detailHref } from "@/lib/routes";
import { Button, FormError, SavePhaseNote, buttonClass, chipClass, controlClass } from "@/components/ui";
import { Check, X } from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { formatDate, formatEur } from "@/lib/format";
import {
  addVatRow,
  autoVatAmount,
  followDateRate,
  moneyField,
  newReceiptVatRows,
  parseReceiptAmount,
  syncAutoVat,
  vatMismatchHint,
  vatPayload,
  vatRateChoicesForDate,
  vatRowsChanged,
  vatRowsFromSaved,
  type VatRow,
} from "@/lib/receipt-vat";
import { focusFirstInvalid } from "@/lib/focus-field";
import {
  captureWithCamera,
  chooseDocuments,
  choosePhotoLibrary,
  isNativeShell,
  type NativePick,
} from "@/lib/native-pick";
import { clearDraft } from "@/lib/draft-store";
import { routeFieldErrors } from "@/lib/field-error-routing";
import { RECEIPT_LIMITS, receiptCategoryFocusId, receiptFieldId, validateReceiptFields } from "@/lib/receipt-form";
import { RECEIPT_PHASE } from "@/lib/screen-state";
import { isLowConfidenceField } from "@/lib/receipt-confidence";
import {
  categoryLabel,
  isKnownCategory,
  RECEIPT_CATEGORIES,
} from "@/lib/receipt-categories";
import { RECEIPT_MATCH_STATUS, receiptMatchStatusKey } from "@/lib/status-labels";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { isUnreadableNote, UNREADABLE_RECEIPT_NOTE } from "@/lib/receipt-unreadable";
import { useReceiptUploadQueue, validateUploadFile, type ReadyUpload } from "@/components/useReceiptUploadQueue";
import ReceiptUploadArea from "@/components/ReceiptUploadArea";
import { BottomActions, DetailHero, MoreMenu, PageTitle, Section, StatusTag } from "@/components/ds";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { useConnectivity } from "@/lib/connectivity";
import { useOfflineReceiptQueue } from "@/components/useOfflineReceiptQueue";
import { tintedButtonClass } from "@/components/control-styles";

/** The fields the receipt form shows an error under (the VAT rows are `vat-<n>`). */
const RECEIPT_FORM_SLOTS = ["vendor", "date", "totalAmount", "category", "reference", "invoiceNumber", "notes"];

const LABEL_CLASS = "mb-1.5 block text-caption font-normal text-ink-2";
/** Same recipe as controlClass (see components/ui.tsx) but with a swappable border
 * colour, so a low-confidence field can show `border-warning` instead of `border-line`
 * without stacking two competing border-color utilities on one element. */
const FIELD_BASE = "box-border block w-full min-w-0 max-w-full px-3 min-h-12 rounded-card border bg-surface text-input text-ink";
const uncertainClass = "border-warning ring-2 ring-warning";

function fieldClass(uncertain: boolean): string {
  return `${FIELD_BASE} ${uncertain ? uncertainClass : "border-line"}`;
}

interface ReceiptForm {
  vendor: string;
  date: string;
  totalAmount: string;
  category: string;
  customCategory: string;
  notes: string;
  type: string;
  vatDetails: VatRow[];
  reference: string;
  invoiceNumber: string;
}

const emptyForm: ReceiptForm = {
  vendor: "",
  date: "",
  totalAmount: "",
  category: "",
  customCategory: "",
  notes: "",
  type: "meno",
  // No rows = "Ei ALV-erittelyä". A new receipt gets its default row from the upload (applyUpload).
  vatDetails: [],
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
  const photoInputRef = useRef<HTMLInputElement>(null);
  const matchPanelRef = useRef<HTMLDivElement>(null);
  const saveNoteRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(isEdit);
  const [uploadProgress, setUploadProgress] = useState("");
  const [saving, setSaving] = useState(false);
  const [formReady, setFormReady] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [uploadId, setUploadId] = useState("");
  const [originalName, setOriginalName] = useState("");
  const [meta, setMeta] = useState<ExtractedMeta | null>(null);
  // The file could not be read (no OCR): the fields are empty on purpose and one calm line says so (F04).
  const [unreadable, setUnreadable] = useState(false);
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
  // The load failure itself, so ConnectionNotice can tell offline from a
  // server error instead of showing its raw text (BOOKS-15).
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [forceDuplicate, setForceDuplicate] = useState(false);
  const [vendorRuleActive, setVendorRuleActive] = useState(false);
  const [vendorRuleBusy, setVendorRuleBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const draftKey = receiptId ? `receipt:${receiptId}` : "receipt:new";
  const session = useEditorSession({
    sourceId: draftKey,
    draftKey,
    baseline,
    value: formData,
    active: !isEdit || formReady,
    onRestore: setFormData,
  });

  // A refused save lands in view above the save bar, not off screen (F37).
  useEffect(() => {
    if (session.phase === "failed") saveNoteRef.current?.scrollIntoView({ block: "center" });
  }, [session.phase]);

  const connectivity = useConnectivity();
  const offlineQueue = useOfflineReceiptQueue();
  // Guards a batch pick (photo library allows several) so a network
  // failure on the first file only sends this screen away once, not once
  // per remaining file in the same drain pass.
  const offlineNavigatedRef = useRef(false);

  function applyUpload(upload: ReadyUpload) {
    const knownCategory = isKnownCategory(upload.extracted.category);
    setUploadId(upload.uploadId);
    setFilePath(upload.filePath);
    setOriginalName(upload.originalName);
    const unreadableFile = Boolean(upload.extracted.unreadable);
    setUnreadable(unreadableFile);
    setMeta({
      source: unreadableFile ? "manual" : upload.extracted.source || "ocr",
      confidence: unreadableFile ? null : upload.extracted.confidence ?? null,
      rawText: upload.extracted.rawText,
      fieldConfidence: upload.extracted.fieldConfidence,
    });
    const extractedTotal = moneyField(upload.extracted.totalAmount);
    setFormData({
      vendor: upload.extracted.vendor || "",
      date: upload.extracted.date || "",
      totalAmount: extractedTotal,
      category: knownCategory ? upload.extracted.category || "" : "",
      customCategory: knownCategory ? "" : upload.extracted.category || "",
      notes: upload.extracted.notes || "",
      type: upload.extracted.type || "meno",
      // Only a NEW receipt is prefilled: what extraction read, else the general rate of the date.
      vatDetails: newReceiptVatRows(
        upload.extracted.vatDetails?.map((detail) => ({
          rate: detail.rate ?? 0,
          amount: detail.amount ?? 0,
        })),
        extractedTotal,
        upload.extracted.date || ""
      ),
      reference: upload.extracted.reference || "",
      invoiceNumber: upload.extracted.invoiceNumber || "",
    });
    setUseCustomCategory(!knownCategory && Boolean(upload.extracted.category));
    setFormReady(true);
    setError("");
    setUploadProgress(RECEIPT_PHASE.review);
  }

  /** Task 10: the file goes to the offline queue instead of the online
   * upload, and the screen returns to Kuitit -- called both when
   * connectivity is already down at pick time and when an in-flight online
   * upload fails with a genuine network error. Mobile only; on the web
   * build a network failure still shows as a normal "failed" row. */
  async function captureOffline(files: File[]) {
    if (offlineNavigatedRef.current) return;
    offlineNavigatedRef.current = true;
    await offlineQueue.enqueueFiles(files);
    router.push("/kuitit?offline=1");
  }

  function isConnectivityOk(): boolean {
    return connectivity.device === "online" && connectivity.server === "ok";
  }

  function handleFilesPicked(files: File[]) {
    const invalid = files.map((file) => validateUploadFile(file)).find((message) => message);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (IS_MOBILE_BUILD && !isConnectivityOk()) {
      void captureOffline(files);
      return;
    }
    setError("");
    uploadQueue.enqueue(files);
  }

  function handleUploadNetworkFailure(file: File) {
    void captureOffline([file]);
  }

  const uploadQueue = useReceiptUploadQueue(applyUpload, IS_MOBILE_BUILD ? handleUploadNetworkFailure : undefined);

  async function pickNativeOrInput(
    native: () => Promise<NativePick>,
    input: HTMLInputElement | null
  ) {
    if (!isNativeShell()) {
      input?.click();
      return;
    }
    const picked = await native();
    if (picked.kind === "unavailable") {
      input?.click();
      return;
    }
    if (picked.kind === "denied") {
      setError(picked.message);
      return;
    }
    if (picked.kind === "files") {
      handleFilesPicked(picked.files);
    }
  }
  const uploading = uploadQueue.rows.some(
    (row) => row.status === "uploading" || row.status === "processing"
  );

  // OWN-04 / BOOKS-18 / SHELL-02: "Ota kuva" in the Lisää sheet already took
  // the photo. On /kuitit/uusi?from=camera the picked files are drained once
  // and go straight to upload and review; the picker card is never shown.
  // With nothing stashed (reload, deep link, expired) the normal picker shows.
  const fromCamera =
    !isEdit &&
    searchParams.get(PENDING_CAPTURE_PARAMS.receipt.name) === PENDING_CAPTURE_PARAMS.receipt.value;
  const [cameraHandoff, setCameraHandoff] = useState(
    () => fromCamera && hasPendingCapture("receipt", Date.now(), HANDOFF_MAX_AGE_MS)
  );
  const handoffDrainedRef = useRef(false);
  // One-shot per flag: after draining, the flag is stripped from the URL so a
  // second hand-off changes the URL again and drains again. Without the flag a
  // leftover stash is cleared, so it can never attach itself to a later visit.
  useEffect(() => {
    if (!fromCamera) {
      handoffDrainedRef.current = false;
      clearPendingCapture("receipt");
      return;
    }
    if (handoffDrainedRef.current) return;
    handoffDrainedRef.current = true;
    const files = takePendingCapture("receipt", Date.now(), HANDOFF_MAX_AGE_MS);
    stripPendingCaptureFlag("receipt");
    if (!files || files.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the Lisää sheet's hand-off; nothing was waiting, so the picker shows
      setCameraHandoff(false);
      return;
    }
    setCameraHandoff(true);
    handleFilesPicked(files);
    // handleFilesPicked is recreated every render; the drain is one-shot per flag by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromCamera]);
  const handoffFailed = uploadQueue.rows.some((row) => row.status === "failed" || row.status === "cancelled");
  const showHandoff = cameraHandoff && !formReady && !error && !handoffFailed;
  const handoffProgress =
    uploadQueue.rows.find((row) => row.status === "uploading" || row.status === "processing")?.progress ||
    uploadProgress ||
    "Lähetetään kuvaa…";

  function pickDocument() {
    return pickNativeOrInput(
      () => chooseDocuments(["image/jpeg", "image/png", "image/heic", "application/pdf"]),
      fileInputRef.current
    );
  }

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

  /** Shared by the cache-seeded paint below and the live fetch's own
   * success handler, so both apply a `ReceiptResponse["receipt"]` the same
   * way (Task 7-style page-cache wiring for the detail pages). */
  function applyReceiptResponse(r: NonNullable<ReceiptResponse["receipt"]>) {
    const totalText = moneyField(r.totalAmount);
    // Stored VAT only: a receipt without it opens with an empty VAT section (V8, R53, R57).
    let savedVat: { rate: number; amount: number }[] | null = null;
    if (r.vatDetails) {
      try {
        savedVat = JSON.parse(r.vatDetails) as { rate: number; amount: number }[];
      } catch {
        /* ignore */
      }
    }
    const vatDetails = vatRowsFromSaved(savedVat, totalText);
    setFilePath(r.filePath || "");
    setOriginalName(r.fileName || "");
    // A capture nothing could be read from carries the calm line as its note: show it
    // as the line above the form, not as the user's own Selite.
    // Older pending receipts carry the earlier wording of the same note (V13).
    const wasUnreadable = isUnreadableNote(r.notes);
    setUnreadable(wasUnreadable);
    // A receipt typed in by hand has no recognition score to doubt, whatever an old row stored (V11).
    const typedByHand = wasUnreadable || r.source === "manual";
    setMeta({
      source: wasUnreadable ? "manual" : r.source || "manual",
      confidence: typedByHand ? null : r.confidence ?? null,
      rawText: r.rawText,
    });
    const knownCategory = isKnownCategory(r.category);
    const loaded = {
      vendor: r.vendor || "",
      date: r.date ? String(r.date).slice(0, 10) : "",
      totalAmount: totalText,
      category: knownCategory ? r.category || "" : "",
      customCategory: knownCategory ? "" : r.category || "",
      notes: wasUnreadable ? "" : r.notes || "",
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
  }

  // Instant paint from the last-seen copy (mobile: persisted across a
  // relaunch, Task 7) -- applied once per id, before the network request
  // below either confirms it or replaces it with a fresher one.
  useEffect(() => {
    if (!receiptId) return;
    const cached = readPageCache<ReceiptResponse["receipt"]>(`receipt:${receiptId}`);
    if (cached) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot read of a value left by an earlier visit (Task 7's persistent cache), not state derived from props/state here
      applyReceiptResponse(cached);
      setLoading(false);
    }
  }, [receiptId]);

  useEffect(() => {
    if (!receiptId) return;
    const controller = new AbortController();
    apiFetch(`/api/receipts/${receiptId}`, { signal: controller.signal })
      .then((response) =>
        readJson<ReceiptResponse>(response, "Kuitin lataus epäonnistui")
      )
      .then((d) => {
        if (!d.receipt || controller.signal.aborted) return;
        applyReceiptResponse(d.receipt);
        writePageCache(`receipt:${receiptId}`, d.receipt);
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
        // A cached copy (just applied above, or from an earlier mount) is
        // left on screen rather than replaced by the error screen -- see
        // the `isEdit && error && !formReady` render guard below, which
        // only fires when nothing has ever been shown for this receipt.
        setLoadFailure(loadError);
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
      if (!res.ok) await readJson(res, "Kohdistus epäonnistui");
      await reloadReceiptMatch();
    } catch (matchError: unknown) {
      if (isUnauthorized(matchError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(matchError, "Kohdistus epäonnistui"));
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
      if (!res.ok) await readJson(res, "Kohdistuksen poisto epäonnistui");
      await reloadReceiptMatch();
    } catch (unlinkError: unknown) {
      if (isUnauthorized(unlinkError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(unlinkError, "Kohdistuksen poisto epäonnistui"));
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
      reference: formData.reference,
      invoiceNumber: formData.invoiceNumber,
      notes: formData.notes,
    });
    const totalAmount = parseReceiptAmount(formData.totalAmount) ?? NaN;
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      setError("");
      // The category is a chip group until one is chosen: it has its own id to focus (V12).
      focusFirstInvalid(
        nextFieldErrors,
        ["vendor", "date", "totalAmount", "category", "reference", "invoiceNumber", "notes"],
        (key) =>
          key === "category"
            ? receiptCategoryFocusId({ useCustom: useCustomCategory, hasCategory: Boolean(formData.category) })
            : receiptFieldId(key)
      );
      return;
    }
    // What is stored is what the screen shows: an empty amount is refused, never filled in here.
    const vat = vatPayload(formData.vatDetails, formData.totalAmount);
    if ("errorKey" in vat) {
      setFieldErrors({ [vat.errorKey]: vat.message });
      setError("");
      focusFirstInvalid({ [vat.errorKey]: vat.message }, [vat.errorKey], () => `receipt-vat-amount-${vat.errorKey.slice(4)}`);
      return;
    }
    // A saved receipt gets vatDetails only when the user changed the rows (V8, R53, R57, R61).
    const sendVat = !isEdit || vatRowsChanged(formData.vatDetails, baseline.vatDetails);
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
        ...(sendVat ? { vatDetails: vat.lines } : {}),
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
          router.push(detailHref("receipt", data.receipt.id as string, { new: "true" }));
          return;
        }
      }

      router.push("/kuitit");
    } catch (saveError: unknown) {
      if (isUnauthorized(saveError)) {
        redirectToLogin();
        return;
      }
      // A refusal that names fields goes to those fields (F64); the rest is one message.
      const serverFields = fieldErrorsFromApi(saveError);
      const routed = routeFieldErrors(serverFields, (key) => RECEIPT_FORM_SLOTS.includes(key) || /^vat-\d+$/.test(key));
      if (Object.keys(routed.fields).length > 0) {
        setFieldErrors(serverFields);
        setError("");
        session.setPhase("dirty");
        focusFirstInvalid(
          serverFields,
          ["vendor", "date", "totalAmount", "category", "reference", "invoiceNumber", "notes"],
          receiptFieldId
        );
        return;
      }
      // A field the form shows no slot for (the VAT rows as a whole) would vanish: its message is the generic one.
      setError(routed.message || errorMessage(saveError, "Tallennus epäonnistui"));
      session.setPhase("failed");
    } finally {
      setSaving(false);
    }
  }

  async function deleteReceipt() {
    if (!receiptId) return;
    setDeleting(true);
    try {
      const response = await apiFetch(`/api/receipts/${receiptId}`, {
        method: "DELETE",
      });
      await readJson(response, "Poisto epäonnistui");
      router.push("/kuitit");
    } catch (deleteError: unknown) {
      if (isUnauthorized(deleteError)) {
        redirectToLogin();
        return;
      }
      const message = errorMessage(deleteError, "Poisto epäonnistui");
      setError(message);
      throw new Error(message);
    } finally {
      setDeleting(false);
    }
  }

  const formPreviewSrc = isEdit
    ? `/api/receipts/${receiptId}/file`
    : filePath
      ? `/api/uploads/${encodeURIComponent(filePath)}`
      : null;
  // Typed by hand (an unreadable photo, or a manual receipt): there is no recognition to doubt (V11, V13).
  const showUncertainty = !unreadable && meta?.source !== "manual";
  const lowVendor =
    showUncertainty &&
    isLowConfidenceField({
      value: formData.vendor,
      overall: meta?.confidence,
      field: meta?.fieldConfidence?.vendor,
    });
  const lowDate =
    showUncertainty &&
    isLowConfidenceField({
      value: formData.date,
      overall: meta?.confidence,
      field: meta?.fieldConfidence?.date,
    });
  const lowAmount =
    showUncertainty &&
    isLowConfidenceField({
      value: formData.totalAmount,
      overall: meta?.confidence,
      field: meta?.fieldConfidence?.totalAmount,
    });

  if (loading) {
    return <ReceiptDetailSkeleton />;
  }

  if (notFound) {
    return (
      <div className="space-y-4">
        <ErrorState title="Kuittia ei löytynyt" message="Kuitti on voitu poistaa." />
        <Link href="/kuitit" className={buttonClass("secondary", "w-full")}>
          Palaa kuitteihin
        </Link>
      </div>
    );
  }

  if (isEdit && error && !formReady) {
    return (
      <ErrorState
        error={loadFailure ?? undefined}
        message={error}
        onRetry={() => {
          setError("");
          setLoading(true);
          setLoadAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

  const matchStatus = RECEIPT_MATCH_STATUS[receiptMatchStatusKey(matchData)];
  const totalAmountValue = parseReceiptAmount(formData.totalAmount);
  const vatHint = vatMismatchHint(formData.vatDetails, formData.totalAmount);
  const categoryText = useCustomCategory
    ? formData.customCategory || "Ei kategoriaa"
    : formData.category
      ? categoryLabel(formData.category)
      : "Ei kategoriaa";

  return (
    <div className="space-y-6">
      {isNewStep2 && (
        <div className="flex items-center gap-3 rounded-card border border-success/20 bg-success/10 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/20 text-success">
            <Icon icon={Check} strokeWidth={2.5} />
          </div>
          <div>
            <h3 className="text-body font-semibold text-success">Kuitti tallennettu</h3>
            <p className="mt-0.5 text-caption text-ink">Seuraavaksi yhdistä kuitti oikeaan pankkitapahtumaan tiliotteelta.</p>
          </div>
        </div>
      )}

      {isEdit && formReady ? (
        <DetailHero
          amount={
            totalAmountValue !== null
              ? `${formData.type === "tulo" ? "+" : ""}${formatEur(totalAmountValue)}`
              : formatEur(null)
          }
          amountTone={formData.type === "tulo" ? "positive" : "default"}
          title={formData.vendor || "Tuntematon"}
          meta={
            <>
              <span className="block">{formatDate(formData.date)}</span>
              <span className="block">{categoryText}</span>
            </>
          }
          status={<StatusTag tone={matchStatus.tone}>{matchStatus.label}</StatusTag>}
          menu={
            <MoreMenu
              items={[
                {
                  label: "Poista kuitti",
                  onSelect: () => setConfirmDelete(true),
                  tone: "danger",
                  disabled: saving || deleting,
                },
              ]}
            />
          }
        />
      ) : (
        !isEdit && <PageTitle title={isNewStep2 ? "Vaihe 2: Kohdistus" : "Uusi kuitti"} />
      )}

      {showHandoff && (
        <SkeletonGroup label="Käsitellään kuittia" className="space-y-6">
          <div className="flex items-center gap-3 rounded-card border border-line bg-surface p-4" data-testid="camera-handoff">
            <div className="min-w-0">
              <p className="text-body font-medium text-ink">Käsitellään kuittia</p>
              <p className="mt-0.5 text-caption text-ink-2">{handoffProgress}</p>
            </div>
          </div>
          <Skeleton radius="card" className="h-48 w-full" />
          <FieldsSkeleton />
        </SkeletonGroup>
      )}

      {!isEdit && !formReady && !showHandoff && (
        <ReceiptUploadArea
          fileInputRef={fileInputRef}
          cameraInputRef={cameraInputRef}
          photoInputRef={photoInputRef}
          uploading={uploading}
          uploadProgress={uploadProgress}
          uploadQueue={uploadQueue}
          onFilesPicked={handleFilesPicked}
          onPickCamera={() => void pickNativeOrInput(() => captureWithCamera(), cameraInputRef.current)}
          onPickPhoto={() => void pickNativeOrInput(() => choosePhotoLibrary(), photoInputRef.current)}
          onPickFile={() => void pickDocument()}
        />
      )}

      {/* A refused save is shown once, by the note above the save bar (F37). */}
      <FormError
        message={session.phase === "failed" && formReady ? "" : error}
        className="rounded-card bg-danger/10 px-4 py-3"
      />

      {uploadProgress && !uploading && (
        <p className="text-center text-caption text-ink-2" role="status" aria-live="polite">
          {uploadProgress}
        </p>
      )}

      {formReady && (
        <form
          id="receipt-form"
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          {isEdit && (
            <div
              ref={matchPanelRef}
              className={isNewStep2 ? "rounded-card ring-2 ring-accent ring-offset-2 transition-all duration-500" : ""}
            >
              <Section title="Pankkitapahtuma">
                <ErrorBoundary>
                  <ReceiptMatchPanel
                    match={matchData}
                    linkedTransaction={linkedTx}
                    busy={matchBusy}
                    onConfirm={handleMatchConfirm}
                    onUnlink={linkedTx ? handleMatchUnlink : undefined}
                  />
                </ErrorBoundary>
              </Section>
            </div>
          )}

          {!isNewStep2 && (
            <div className="space-y-6">
              <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
                {formPreviewSrc && (
                  <ReceiptPreview
                    src={formPreviewSrc}
                    fileName={originalName || filePath || "kuitti"}
                  />
                )}

                <Section
                  title={isEdit ? "Kuitin tiedot" : "Tarkista tiedot"}
                  action={
                    <div className="flex items-center gap-2">
                      {!isEdit && (
                        <button
                          type="button"
                          onClick={() => void pickDocument()}
                          disabled={uploading}
                          className={tintedButtonClass("accent")}
                        >
                          Vaihda tiedosto
                        </button>
                      )}
                      {meta && meta.source !== "manual" && (
                        <StatusTag tone={meta.source === "ai" ? "success" : "warning"}>
                          {meta.source === "ai" ? "AI" : "OCR"}
                        </StatusTag>
                      )}
                    </div>
                  }
                >
                  <div className="space-y-4 px-4 py-4">
                    {!isEdit && meta?.confidence != null && meta.confidence < 0.6 && (
                      <p className="text-caption text-warning">
                        Automaattinen tunnistus epävarma, tarkista kaikki kentät ennen
                        tallennusta.
                      </p>
                    )}

                    {unreadable && (
                      <p className="text-caption text-ink-2" role="note">
                        {UNREADABLE_RECEIPT_NOTE}
                      </p>
                    )}

                    {originalName && <p className="text-caption text-ink-2">{originalName}</p>}

                    <div>
                      <label htmlFor="receipt-vendor" className={LABEL_CLASS}>Myyjä</label>
                      <input
                        id="receipt-vendor"
                        type="text"
                        autoCapitalize="words"
                        autoComplete="off"
                        enterKeyHint="next"
                        required
                        maxLength={RECEIPT_LIMITS.vendor}
                        value={formData.vendor}
                        onChange={(e) =>
                          setFormData({ ...formData, vendor: e.target.value })
                        }
                        aria-invalid={Boolean(fieldErrors.vendor) || undefined}
                        aria-describedby={fieldErrors.vendor ? "receipt-vendor-error" : undefined}
                        className={fieldClass(lowVendor)}
                      />
                      {lowVendor && !fieldErrors.vendor && (
                        <p className="mt-1.5 text-caption text-warning">Epävarma tunnistus</p>
                      )}
                      {fieldErrors.vendor && (
                        <p id="receipt-vendor-error" className="mt-1.5 text-sm text-danger" role="alert">
                          {fieldErrors.vendor}
                        </p>
                      )}
                    </div>

                    <div className="field-dates">
                      <div>
                        <label htmlFor="receipt-date" className={LABEL_CLASS}>
                          Päivämäärä
                        </label>
                        <input
                          id="receipt-date"
                          type="date"
                          lang="fi"
                          autoComplete="off"
                          required
                          value={formData.date}
                          onChange={(e) => {
                            const date = e.target.value;
                            // A VAT rate nobody chose follows the date: 24 % before 1.9.2024 (V9).
                            setFormData((prev) => ({
                              ...prev,
                              date,
                              vatDetails: followDateRate(prev.vatDetails, date, prev.totalAmount),
                            }));
                          }}
                          aria-invalid={Boolean(fieldErrors.date) || undefined}
                          aria-describedby={fieldErrors.date ? "receipt-date-error" : undefined}
                          className={fieldClass(lowDate)}
                        />
                        {lowDate && !fieldErrors.date && (
                          <p className="mt-1.5 text-caption text-warning">Epävarma tunnistus</p>
                        )}
                        {fieldErrors.date && (
                          <p id="receipt-date-error" className="mt-1.5 text-sm text-danger" role="alert">
                            {fieldErrors.date}
                          </p>
                        )}
                      </div>
                      <div>
                        <label htmlFor="receipt-total" className={LABEL_CLASS}>
                          Summa (€)
                        </label>
                        <input
                          id="receipt-total"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          enterKeyHint="next"
                          placeholder="0,00"
                          required
                          value={formData.totalAmount}
                          onChange={(e) => {
                            const totalAmount = e.target.value;
                            // The VAT follows the total until an amount is typed by hand (F35).
                            setFormData((prev) => ({
                              ...prev,
                              totalAmount,
                              vatDetails: syncAutoVat(prev.vatDetails, totalAmount),
                            }));
                          }}
                          aria-invalid={Boolean(fieldErrors.totalAmount) || undefined}
                          aria-describedby={fieldErrors.totalAmount ? "receipt-total-error" : undefined}
                          className={fieldClass(lowAmount)}
                        />
                        {lowAmount && !fieldErrors.totalAmount && (
                          <p className="mt-1.5 text-caption text-warning">Epävarma tunnistus</p>
                        )}
                        {fieldErrors.totalAmount && (
                          <p id="receipt-total-error" className="mt-1.5 text-sm text-danger" role="alert">
                            {fieldErrors.totalAmount}
                          </p>
                        )}
                      </div>
                    </div>

                    <div>
                      <p className={LABEL_CLASS} id="receipt-type-label">Tyyppi</p>
                      <div
                        role="group"
                        aria-labelledby="receipt-type-label"
                        className="inline-flex gap-1 rounded-full border border-line bg-canvas p-1"
                      >
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, type: "meno" })}
                          aria-pressed={formData.type === "meno"}
                          className={`active-press min-h-11 rounded-full px-4 text-caption font-semibold ${
                            formData.type === "meno" ? "bg-ink text-canvas" : "text-ink-2"
                          }`}
                        >
                          Meno
                        </button>
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, type: "tulo" })}
                          aria-pressed={formData.type === "tulo"}
                          className={`active-press min-h-11 rounded-full px-4 text-caption font-semibold ${
                            formData.type === "tulo" ? "bg-ink text-canvas" : "text-ink-2"
                          }`}
                        >
                          Tulo
                        </button>
                      </div>
                    </div>
                  </div>
                </Section>
              </div>

              <Section title="ALV-erittely">
                <div className="space-y-3 px-4 py-4">
                  {formData.vatDetails.length === 0 && (
                    <p className="text-body text-ink-2" data-testid="vat-empty">
                      Ei ALV-erittelyä. Lisää rivi, jos kuitilla on ALV.
                    </p>
                  )}
                  {formData.vatDetails.map((detail, index) => {
                    const rateChoices = vatRateChoicesForDate(formData.date);
                    const isLegacyRate = !rateChoices.includes(detail.rate);
                    return (
                      <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                        <div>
                          <label htmlFor={`receipt-vat-rate-${index}`} className={LABEL_CLASS}>
                            ALV-%
                          </label>
                          <select
                            id={`receipt-vat-rate-${index}`}
                            value={detail.rate}
                            autoComplete="off"
                            className={controlClass}
                            onChange={(event) => {
                              const newRate = event.target.value;
                              setFormData((prev) => {
                                const single = prev.vatDetails.length === 1;
                                // A rate picked by hand is no longer the default of the date.
                                const rows = prev.vatDetails.map((row, rowIndex) =>
                                  rowIndex === index ? { ...row, rate: newRate, defaulted: false } : row
                                );
                                // Picking the rate of a single row asks for the VAT of the total,
                                // with the same Finnish parser the save uses (F03).
                                const calculated = single ? autoVatAmount(prev.totalAmount, newRate) : null;
                                return {
                                  ...prev,
                                  vatDetails:
                                    calculated !== null
                                      ? [{ rate: newRate, amount: calculated, auto: true }]
                                      : rows,
                                };
                              });
                            }}
                          >
                            {isLegacyRate ? (
                              <option value={detail.rate}>{detail.rate.replace(".", ",")} %</option>
                            ) : null}
                            {rateChoices.map((rate) => (
                              <option key={rate} value={rate}>
                                {rate.replace(".", ",")} %
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`receipt-vat-amount-${index}`} className={LABEL_CLASS}>
                            ALV (€)
                          </label>
                          <input
                            id={`receipt-vat-amount-${index}`}
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            enterKeyHint="next"
                            placeholder="0,00"
                            value={detail.amount}
                            onChange={(event) =>
                              setFormData({
                                ...formData,
                                vatDetails: formData.vatDetails.map((row, rowIndex) =>
                                  rowIndex === index
                                    ? {
                                        ...row,
                                        amount: event.target.value,
                                        // Typed by hand: stop following the total. Emptied: follow again.
                                        auto: event.target.value.trim() === "",
                                      }
                                    : row
                                ),
                              })
                            }
                            aria-invalid={Boolean(fieldErrors[`vat-${index}`]) || undefined}
                            aria-describedby={fieldErrors[`vat-${index}`] ? `receipt-vat-error-${index}` : undefined}
                            className={controlClass}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            // The only row can go too: a receipt may have no VAT breakdown at all.
                            setFormData({
                              ...formData,
                              vatDetails: formData.vatDetails.filter((_, rowIndex) => rowIndex !== index),
                            })
                          }
                          className="active-press flex h-12 w-12 items-center justify-center rounded-card border border-danger/30 text-danger"
                          aria-label={`Poista ALV-rivi ${index + 1}`}
                        >
                          <Icon icon={X} />
                        </button>
                      </div>
                    );
                  })}
                  {Object.entries(fieldErrors)
                    .filter(([key]) => key.startsWith("vat-"))
                    .map(([key, message]) => (
                      <p key={key} id={`receipt-vat-error-${key.slice(4)}`} className="text-sm text-danger" role="alert">
                        {message}
                      </p>
                    ))}
                  {vatHint && !Object.keys(fieldErrors).some((key) => key.startsWith("vat-")) && (
                    <p className="text-caption text-warning">{vatHint}</p>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setFormData({
                        ...formData,
                        vatDetails: addVatRow(formData.vatDetails, formData.totalAmount, formData.date),
                      })
                    }
                    className="active-press min-h-12 w-full rounded-card border border-line bg-surface text-body font-semibold text-ink"
                  >
                    + Lisää ALV-rivi
                  </button>
                </div>
              </Section>

              <Section title="Lisätiedot">
                <div className="space-y-4 px-4 py-4">
                  <div className="field-grid">
                    <div>
                      <label htmlFor="receipt-reference" className={LABEL_CLASS}>
                        Viitenumero
                      </label>
                      <input
                        id="receipt-reference"
                        type="text"
                        value={formData.reference}
                        maxLength={RECEIPT_LIMITS.reference}
                        onChange={(e) =>
                          setFormData({ ...formData, reference: e.target.value })
                        }
                        placeholder="esim. 1009"
                        aria-invalid={Boolean(fieldErrors.reference) || undefined}
                        aria-describedby={fieldErrors.reference ? "receipt-reference-error" : undefined}
                        className={controlClass}
                      />
                      {fieldErrors.reference && (
                        <p id="receipt-reference-error" className="mt-1.5 text-sm text-danger" role="alert">
                          {fieldErrors.reference}
                        </p>
                      )}
                    </div>
                    <div>
                      <label htmlFor="receipt-invoice-number" className={LABEL_CLASS}>
                        Laskun numero
                      </label>
                      <input
                        id="receipt-invoice-number"
                        type="text"
                        value={formData.invoiceNumber}
                        maxLength={RECEIPT_LIMITS.invoiceNumber}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            invoiceNumber: e.target.value,
                          })
                        }
                        aria-invalid={Boolean(fieldErrors.invoiceNumber) || undefined}
                        aria-describedby={fieldErrors.invoiceNumber ? "receipt-invoice-number-error" : undefined}
                        className={controlClass}
                      />
                      {fieldErrors.invoiceNumber && (
                        <p id="receipt-invoice-number-error" className="mt-1.5 text-sm text-danger" role="alert">
                          {fieldErrors.invoiceNumber}
                        </p>
                      )}
                    </div>
                  </div>

                  <div>
                    <label htmlFor="receipt-notes" className={LABEL_CLASS}>
                      Selite / lisätiedot
                    </label>
                    <textarea
                      id="receipt-notes"
                      rows={3}
                      value={formData.notes}
                      maxLength={RECEIPT_LIMITS.notes}
                      onChange={(e) =>
                        setFormData({ ...formData, notes: e.target.value })
                      }
                      placeholder="Valinnainen selite kirjanpitoon..."
                      aria-invalid={Boolean(fieldErrors.notes) || undefined}
                      aria-describedby={fieldErrors.notes ? "receipt-notes-error" : undefined}
                      className={`${controlClass} min-h-[5rem] resize-y py-3`}
                    />
                    {fieldErrors.notes && (
                      <p id="receipt-notes-error" className="mt-1.5 text-sm text-danger" role="alert">
                        {fieldErrors.notes}
                      </p>
                    )}
                  </div>
                </div>
              </Section>

              <div
                // No category yet: the chip group is what the refusal focuses and scrolls to (V12).
                id={formData.category || useCustomCategory ? undefined : "receipt-category-group"}
                tabIndex={formData.category || useCustomCategory ? undefined : -1}
                className="scroll-mb-32 outline-none"
              >
                <p className={LABEL_CLASS} id="receipt-category-label">Kategoria</p>
                {(formData.category || useCustomCategory) ? (
                  <div className="space-y-3">
                    <select
                      id="receipt-category"
                      aria-labelledby="receipt-category-label"
                      className={controlClass}
                      autoComplete="off"
                      value={useCustomCategory ? "custom" : formData.category}
                      onChange={(event) => {
                        const newCat = event.target.value;
                        if (newCat === "custom") {
                          setUseCustomCategory(true);
                        } else {
                          setUseCustomCategory(false);
                          setFormData({ ...formData, category: newCat });
                        }
                      }}
                    >
                      {RECEIPT_CATEGORIES.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.label}
                        </option>
                      ))}
                      <option value="custom">Muu kategoria…</option>
                    </select>
                    {useCustomCategory && (
                      <div>
                        <label htmlFor="receipt-custom-category" className={LABEL_CLASS}>
                          Oma kategoria
                        </label>
                        <input
                          id="receipt-custom-category"
                          type="text"
                          autoCapitalize="sentences"
                          autoComplete="off"
                          enterKeyHint="done"
                          value={formData.customCategory}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              customCategory: e.target.value,
                            })
                          }
                          placeholder="esim. kalusteet, siivous"
                          className={controlClass}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    role="group"
                    aria-labelledby="receipt-category-label"
                    aria-describedby={fieldErrors.category ? "receipt-category-error" : undefined}
                    className="flex flex-wrap gap-2"
                  >
                    {RECEIPT_CATEGORIES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={false}
                        onClick={() => {
                          setUseCustomCategory(false);
                          setFormData({ ...formData, category: c.id });
                        }}
                        className={chipClass(false)}
                      >
                        {c.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      aria-pressed={false}
                      onClick={() => setUseCustomCategory(true)}
                      className={chipClass(false)}
                    >
                      Muu kategoria…
                    </button>
                  </div>
                )}
                {fieldErrors.category && (
                  <p id="receipt-category-error" className="mt-1.5 text-sm text-danger" role="alert">
                    {fieldErrors.category}
                  </p>
                )}
              </div>

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
            </div>
          )}

          {session.notice && (
            <p className="text-caption text-ink" role="status">
              {session.notice}{" "}
              <button
                type="button"
                className="font-medium text-accent underline"
                onClick={() => session.setNotice("")}
              >
                Sulje
              </button>{" "}
              <button
                type="button"
                className="font-medium text-accent underline"
                onClick={() => {
                  session.clearSavedDraft();
                  setFormData(baseline);
                }}
              >
                Hylkää luonnos
              </button>
            </p>
          )}
          <div ref={saveNoteRef} className="scroll-mb-28 space-y-3">
            <SavePhaseNote phase={session.phase} error={error} />
            {conflict && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  clearDraft(draftKey);
                  setConflict(false);
                  setError("");
                  session.setPhase("clean");
                  session.setNotice("");
                  setLoadAttempt((attempt) => attempt + 1);
                }}
              >
                Lataa uudelleen
              </Button>
            )}
          </div>
        </form>
      )}

      {formReady && (
        <BottomActions>
          {isNewStep2 ? (
            <Link
              href="/kuitit"
              className="active-press flex min-h-12 w-full items-center justify-center gap-2 rounded-card bg-success text-body font-semibold text-canvas"
            >
              Kaikki valmista, palaa kuitteihin
            </Link>
          ) : (
            <div className="flex gap-2">
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
                form="receipt-form"
                busy={saving}
                busyLabel="Tallennetaan…"
                // Edit: nothing to save until something changed (BOOKS-20).
                disabled={(!isEdit && !uploadId) || (isEdit && !session.dirty && !forceDuplicate)}
                disabledReason={!isEdit && !uploadId ? "Liitä ensin kuitti." : undefined}
                className="flex-1"
              >
                {forceDuplicate ? "Tallenna silti" : isEdit ? "Tallenna muutokset" : "Tallenna"}
              </Button>
            </div>
          )}
        </BottomActions>
      )}

      <ConfirmModal
        isOpen={confirmDelete}
        title="Poistetaanko kuitti?"
        description="Kuitti poistetaan pysyvästi."
        confirmLabel="Poista"
        onConfirm={() => deleteReceipt()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
