"use client";

import type { RefObject } from "react";
import Link from "next/link";
import { FileUp } from "lucide-react";
import { Icon, Section } from "@/components/ds";
import { filePickDecision } from "@/lib/native-file-flow";
import { detailHref } from "@/lib/routes";
import type { useReceiptUploadQueue } from "@/components/useReceiptUploadQueue";

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

/** Same check+enqueue the three file inputs below all performed inline before this split. */
function enqueueFromInput(
  event: React.ChangeEvent<HTMLInputElement>,
  enqueue: (files: File[]) => void
) {
  const files = Array.from(event.target.files ?? []);
  if (filePickDecision(files.length).kind === "upload") enqueue(files);
  event.currentTarget.value = "";
}

interface ReceiptUploadAreaProps {
  fileInputRef: RefObject<HTMLInputElement | null>;
  cameraInputRef: RefObject<HTMLInputElement | null>;
  photoInputRef: RefObject<HTMLInputElement | null>;
  uploading: boolean;
  uploadProgress: string;
  uploadQueue: ReturnType<typeof useReceiptUploadQueue>;
  onPickCamera: () => void;
  onPickPhoto: () => void;
  onPickFile: () => void;
}

/** The pre-upload picker Card plus the upload queue list, for the new-receipt flow. */
export default function ReceiptUploadArea({
  fileInputRef,
  cameraInputRef,
  photoInputRef,
  uploading,
  uploadProgress,
  uploadQueue,
  onPickCamera,
  onPickPhoto,
  onPickFile,
}: ReceiptUploadAreaProps) {
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_UPLOAD}
        multiple
        aria-label="Valitse kuitti tai lasku tiedostona"
        className="hidden"
        onChange={(e) => enqueueFromInput(e, uploadQueue.enqueue)}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*,.heic,.heif,image/heic"
        capture="environment"
        aria-label="Ota kuva kuitista tai laskusta"
        className="hidden"
        onChange={(e) => enqueueFromInput(e, uploadQueue.enqueue)}
      />
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*,.heic,.heif,image/heic"
        multiple
        aria-label="Valitse kuvia kuvakirjastosta"
        className="hidden"
        onChange={(e) => enqueueFromInput(e, uploadQueue.enqueue)}
      />

      <div className="space-y-4 rounded-card border border-line bg-surface p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-canvas text-ink-2">
          <Icon icon={FileUp} size="tab" />
        </div>
        <p className="text-[15px] font-medium text-ink">Lisää kuitti tai lasku kuvana tai PDF-tiedostona</p>

        <div className="mx-auto flex max-w-sm flex-col gap-3">
          <button
            type="button"
            onClick={onPickCamera}
            disabled={uploading}
            className="active-press min-h-12 w-full rounded-card bg-ink px-4 text-[15px] font-semibold text-canvas disabled:opacity-60"
          >
            Ota kuva
          </button>
          <button
            type="button"
            onClick={onPickPhoto}
            disabled={uploading}
            className="active-press min-h-12 w-full rounded-card border border-line bg-surface px-4 text-[15px] font-semibold text-ink disabled:opacity-60"
          >
            Valitse kuvista
          </button>
          <button
            type="button"
            onClick={onPickFile}
            disabled={uploading}
            className="active-press min-h-12 w-full rounded-card border border-line bg-surface px-4 text-[15px] font-semibold text-ink disabled:opacity-60"
          >
            Valitse tiedosto
          </button>
        </div>

        {uploading && (
          <div className="flex items-center justify-center gap-3 pt-4 text-[13px] text-ink-2" role="status" aria-live="polite">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent motion-reduce:animate-none" aria-hidden="true" />
            {uploadQueue.rows.find((row) => row.status === "uploading" || row.status === "processing")?.progress || uploadProgress}
          </div>
        )}
      </div>

      {uploadQueue.rows.length > 0 && (
        <Section
          title="Lähetysjono"
          action={
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => uploadQueue.cancel()}
                className="min-h-11 text-[13px] font-medium text-ink"
              >
                Peruuta
              </button>
              <button
                type="button"
                onClick={() => uploadQueue.retryFailed()}
                className="min-h-11 text-[13px] font-medium text-accent"
              >
                Yritä epäonnistuneet
              </button>
            </div>
          }
        >
          {uploadQueue.rows.map((row) => (
            <div key={row.localId} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 truncate text-[15px] font-medium text-ink">{row.name}</p>
                <p className="shrink-0 text-[13px] text-ink-2">{queueStatusLabel(row.status)}</p>
              </div>
              {row.progress && <p className="mt-1 text-[13px] text-ink-2">{row.progress}</p>}
              {row.error && (
                <p className="mt-1 text-[13px] text-danger" role="alert">
                  {row.error}
                </p>
              )}
              {row.duplicateReceiptId && (
                <Link
                  href={detailHref("receipt", row.duplicateReceiptId)}
                  className="mt-1 inline-flex min-h-11 items-center text-[13px] font-medium text-accent"
                >
                  Avaa olemassa oleva
                </Link>
              )}
              {row.status === "ready" && (
                <button
                  type="button"
                  onClick={() => uploadQueue.useReady(row.localId)}
                  className="min-h-11 text-[13px] font-medium text-accent"
                >
                  Käytä lomakkeessa
                </button>
              )}
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
