"use client";

import { useEffect, useRef, useState } from "react";

type PreviewKind = "rendered" | "raster" | "other";

function previewKind(fileName: string): PreviewKind {
  const lower = fileName.toLowerCase();
  if (/\.(pdf|heic|heif)$/.test(lower)) return "rendered";
  if (/\.(jpe?g|png|webp|gif|bmp)$/.test(lower)) return "raster";
  return "other";
}

function previewSrc(src: string, kind: PreviewKind): string {
  if (kind === "rendered") {
    const base = src.replace(/\/preview\/?$/, "");
    return `${base}/preview`;
  }
  return src;
}

interface ReceiptPreviewProps {
  /** Authenticated URL that returns the file bytes */
  src: string;
  /** Original or stored file name — used to pick image vs PDF renderer */
  fileName: string;
  /** Compact thumbnail style for list cards */
  compact?: boolean;
}

export default function ReceiptPreview({
  src,
  fileName,
  compact = false,
}: ReceiptPreviewProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const kind = previewKind(fileName);
  const imageSrc = previewSrc(src, kind);

  useEffect(() => {
    setPreviewFailed(false);
    setLoading(true);
  }, [imageSrc]);

  useEffect(() => {
    if (!fullscreen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], img, [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      (previouslyFocused || openButtonRef.current)?.focus();
    };
  }, [fullscreen]);

  const viewer = (
    <PreviewBody
      src={src}
      imageSrc={imageSrc}
      kind={kind}
      fileName={fileName}
      fill={fullscreen}
      failed={previewFailed}
      loading={loading}
      onLoad={() => setLoading(false)}
      onError={() => {
        setLoading(false);
        setPreviewFailed(true);
      }}
    />
  );

  return (
    <>
      <div
        className={
          compact
            ? "relative rounded-xl overflow-hidden bg-cream border border-warm-gray-light/40"
            : "relative rounded-xl overflow-hidden bg-cream border border-warm-gray-light/40"
        }
      >
        <div className={compact ? "h-28" : "h-48 sm:h-56"}>
          {viewer}
        </div>
        <button
          ref={openButtonRef}
          type="button"
          onClick={() => setFullscreen(true)}
          className="absolute bottom-2 right-2 min-h-11 px-3 rounded-lg bg-charcoal/80 text-white text-xs font-medium hover:bg-charcoal transition-colors backdrop-blur-sm"
        >
          Koko näyttö
        </button>
      </div>

      {fullscreen && (
        <div
          ref={dialogRef}
          className="fixed inset-0 z-[100] bg-charcoal/90 flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-labelledby="receipt-preview-title"
        >
          <div className="flex items-center justify-between px-4 py-3 shrink-0">
            <p id="receipt-preview-title" className="text-sm text-white truncate pr-4">
              {fileName}
            </p>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => setFullscreen(false)}
              className="min-h-11 px-4 rounded-lg bg-white/15 text-white text-sm hover:bg-white/25 transition-colors"
            >
              Sulje
            </button>
          </div>
          <div className="flex-1 min-h-0 px-2 pb-4">{viewer}</div>
        </div>
      )}
    </>
  );
}

function PreviewBody({
  src,
  imageSrc,
  kind,
  fileName,
  fill,
  failed,
  loading,
  onLoad,
  onError,
}: {
  src: string;
  imageSrc: string;
  kind: PreviewKind;
  fileName: string;
  fill: boolean;
  failed: boolean;
  loading: boolean;
  onLoad: () => void;
  onError: () => void;
}) {
  if (kind === "other") {
    return <UnsupportedPreview src={src} />;
  }

  if (failed) {
    return (
      <UnsupportedPreview
        src={src}
        message={
          kind === "rendered"
            ? "Esikatselun luonti epäonnistui. Voit avata alkuperäisen tiedoston."
            : "Esikatselun lataus epäonnistui."
        }
      />
    );
  }

  return (
    <div className={`relative w-full h-full bg-white ${fill ? "rounded-xl" : ""}`}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-cream/80 z-10">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageSrc}
        alt={fileName}
        onLoad={onLoad}
        onError={onError}
        className="w-full h-full object-contain"
      />
      {kind === "rendered" && !loading && (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-2 left-2 right-2 min-h-11 flex items-center justify-center rounded-xl bg-charcoal/75 text-white text-xs font-medium backdrop-blur-sm"
        >
          Avaa alkuperäinen tiedosto
        </a>
      )}
    </div>
  );
}

function UnsupportedPreview({
  src,
  message = "Esikatselu ei ole saatavilla tälle tiedostotyypille.",
}: {
  src: string;
  message?: string;
}) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-sm text-warm-gray p-4">
      <p className="text-center">{message}</p>
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent font-medium hover:underline min-h-11 inline-flex items-center"
      >
        Avaa tiedosto
      </a>
    </div>
  );
}
