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
import { hasPendingCapture, PENDING_CAPTURE_PARAMS, takePendingCapture } from "@/lib/pending-capture";
import ConfirmModal from "@/components/ConfirmModal";
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
import { detailHref } from "@/lib/routes";
import { Button, FormError, SavePhaseNote, buttonClass, chipClass, controlClass } from "@/components/ui";
import { SelectMenu } from "@/components/SelectMenu";
import { Check, X } from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { formatDate, formatEur, parseMoneyInput } from "@/lib/format";
import { focusFirstInvalid } from "@/lib/focus-field";
import {
  captureWithCamera,
  chooseDocuments,
  choosePhotoLibrary,
  isNativeShell,
  type NativePick,
} from "@/lib/native-pick";
import { clearDraft } from "@/lib/draft-store";
import { receiptFieldId, validateReceiptFields } from "@/lib/receipt-form";
import { RECEIPT_PHASE } from "@/lib/screen-state";
import { isLowConfidenceField } from "@/lib/receipt-confidence";
import {
  categoryLabel,
  isKnownCategory,
  RECEIPT_CATEGORIES,
} from "@/lib/receipt-categories";
import { RECEIPT_MATCH_STATUS, receiptMatchStatusKey } from "@/lib/status-labels";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { useReceiptUploadQueue, validateUploadFile, type ReadyUpload } from "@/components/useReceiptUploadQueue";
import ReceiptUploadArea from "@/components/ReceiptUploadArea";
import { BottomActions, DetailHero, MoreMenu, PageTitle, Section, StatusTag } from "@/components/ds";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { useConnectivity } from "@/lib/connectivity";
import { useOfflineReceiptQueue } from "@/components/useOfflineReceiptQueue";

const LABEL_CLASS = "mb-1.5 block text-[13px] font-normal text-ink-2";
/** Same recipe as controlClass (see components/ui.tsx) but with a swappable border
 * colour, so a low-confidence field can show `border-warning` instead of `border-line`
 * without stacking two competing border-color utilities on one element. */
const FIELD_BASE = "box-border block w-full min-w-0 max-w-full px-3 min-h-12 rounded-card border bg-surface text-[16px] text-ink";
const uncertainClass = "border-warning ring-2 ring-warning";

function fieldClass(uncertain: boolean): string {
  return `${FIELD_BASE} ${uncertain ? uncertainClass : "border-line"}`;
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
  const photoInputRef = useRef<HTMLInputElement>(null);
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
  const [cameraHandoff, setCameraHandoff] = useState(() => fromCamera && hasPendingCapture("receipt"));
  const handoffDrainedRef = useRef(false);
  useEffect(() => {
    if (!cameraHandoff || handoffDrainedRef.current) return;
    handoffDrainedRef.current = true;
    const files = takePendingCapture("receipt");
    if (!files || files.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of the Lisää sheet's hand-off; nothing was waiting, so the picker shows
      setCameraHandoff(false);
      return;
    }
    handleFilesPicked(files);
    // handleFilesPicked is recreated every render; the drain is one-shot by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraHandoff]);
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
      setError(errorMessage(saveError, "Tallennus epäonnistui"));
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

  if (loading) {
    return <ReceiptDetailSkeleton />;
  }

  if (notFound) {
    return (
      <div className="space-y-4">
        <ErrorState message="Kuittia ei löytynyt" />
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
  const totalAmountValue = parseMoneyInput(formData.totalAmount);
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
            <h3 className="text-[15px] font-semibold text-success">Kuitti tallennettu</h3>
            <p className="mt-0.5 text-[13px] text-ink">Seuraavaksi yhdistä kuitti oikeaan pankkitapahtumaan tiliotteelta.</p>
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
        !isEdit && <PageTitle title={isNewStep2 ? "Vaihe 2: Linkitys" : "Uusi kuitti"} />
      )}

      {showHandoff && (
        <SkeletonGroup label="Luetaan kuittia" className="space-y-6">
          <div className="flex items-center gap-3 rounded-card border border-line bg-surface p-4" data-testid="camera-handoff">
            <span
              className="h-5 w-5 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            <div className="min-w-0">
              <p className="text-[15px] font-medium text-ink">Luetaan kuittia</p>
              <p className="mt-0.5 text-[13px] text-ink-2">{handoffProgress}</p>
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

      <FormError message={error} className="rounded-card bg-danger/10 px-4 py-3" />

      {uploadProgress && !uploading && (
        <p className="text-center text-[13px] text-ink-2" role="status" aria-live="polite">
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
                          className="min-h-11 text-[13px] font-medium text-accent disabled:opacity-50"
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
                      <p className="text-[13px] text-warning">
                        Automaattinen tunnistus epävarma, tarkista kaikki kentät ennen
                        tallennusta.
                      </p>
                    )}

                    {originalName && <p className="text-[13px] text-ink-2">{originalName}</p>}

                    <div>
                      <label htmlFor="receipt-vendor" className={LABEL_CLASS}>Myyjä</label>
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
                        className={fieldClass(lowVendor)}
                      />
                      {lowVendor && !fieldErrors.vendor && (
                        <p className="mt-1.5 text-[13px] text-warning">Epävarma tunnistus</p>
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
                          required
                          value={formData.date}
                          onChange={(e) =>
                            setFormData({ ...formData, date: e.target.value })
                          }
                          aria-invalid={Boolean(fieldErrors.date) || undefined}
                          aria-describedby={fieldErrors.date ? "receipt-date-error" : undefined}
                          className={fieldClass(lowDate)}
                        />
                        {lowDate && !fieldErrors.date && (
                          <p className="mt-1.5 text-[13px] text-warning">Epävarma tunnistus</p>
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
                          placeholder="0,00"
                          required
                          value={formData.totalAmount}
                          onChange={(e) =>
                            setFormData({ ...formData, totalAmount: e.target.value })
                          }
                          aria-invalid={Boolean(fieldErrors.totalAmount) || undefined}
                          aria-describedby={fieldErrors.totalAmount ? "receipt-total-error" : undefined}
                          className={fieldClass(lowAmount)}
                        />
                        {lowAmount && !fieldErrors.totalAmount && (
                          <p className="mt-1.5 text-[13px] text-warning">Epävarma tunnistus</p>
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
                          className={`active-press min-h-11 rounded-full px-4 text-[13px] font-semibold ${
                            formData.type === "meno" ? "bg-ink text-canvas" : "text-ink-2"
                          }`}
                        >
                          Meno
                        </button>
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, type: "tulo" })}
                          aria-pressed={formData.type === "tulo"}
                          className={`active-press min-h-11 rounded-full px-4 text-[13px] font-semibold ${
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
                  {formData.vatDetails.map((detail, index) => {
                    const standardRates = ["25.5", "13.5", "10", "0"];
                    const isLegacyRate = !standardRates.includes(detail.rate);
                    return (
                      <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
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
                                  const total = parseFloat(prev.totalAmount.replace(",", "."));
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
                          <label htmlFor={`receipt-vat-amount-${index}`} className={LABEL_CLASS}>
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
                            className={controlClass}
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
                          className="active-press flex h-12 w-12 items-center justify-center rounded-card border border-danger/30 text-danger disabled:opacity-40"
                          aria-label={`Poista ALV-rivi ${index + 1}`}
                          disabled={
                            formData.vatDetails.length === 1 &&
                            detail.amount === "" &&
                            detail.rate === "25.5"
                          }
                        >
                          <Icon icon={X} />
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
                    className="active-press min-h-12 w-full rounded-card border border-line bg-surface text-[15px] font-semibold text-ink"
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
                        onChange={(e) =>
                          setFormData({ ...formData, reference: e.target.value })
                        }
                        placeholder="esim. 1009"
                        className={controlClass}
                      />
                    </div>
                    <div>
                      <label htmlFor="receipt-invoice-number" className={LABEL_CLASS}>
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
                        className={controlClass}
                      />
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
                      onChange={(e) =>
                        setFormData({ ...formData, notes: e.target.value })
                      }
                      placeholder="Valinnainen selite kirjanpitoon..."
                      className={`${controlClass} min-h-[5rem] resize-y py-3`}
                    />
                  </div>
                </div>
              </Section>

              <div>
                <p className={LABEL_CLASS} id="receipt-category-label">Kategoria</p>
                {(formData.category || useCustomCategory) ? (
                  <div className="space-y-3">
                    <SelectMenu
                      id="receipt-category"
                      label="Valittu kategoria"
                      value={useCustomCategory ? "custom" : formData.category}
                      options={[
                        ...RECEIPT_CATEGORIES.map((c) => ({ value: c.id, label: c.label })),
                        { value: "custom", label: "Muu kategoria…" },
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
                      <div>
                        <label htmlFor="receipt-custom-category" className={LABEL_CLASS}>
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
                          className={controlClass}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div role="group" aria-labelledby="receipt-category-label" className="flex flex-wrap gap-2">
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
            <p className="text-[13px] text-ink" role="status">
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
        </form>
      )}

      {formReady && (
        <BottomActions>
          {isNewStep2 ? (
            <Link
              href="/kuitit"
              className="active-press flex min-h-12 w-full items-center justify-center gap-2 rounded-card bg-success text-[15px] font-semibold text-canvas"
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
