"use client";

import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/components/useFocusTrap";

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    setPreviewFailed(false);
    setLoading(true);
  }, [imageSrc]);

  useFocusTrap(dialogRef, fullscreen, {
    onEscape: () => setFullscreen(false),
    initialFocusRef: closeButtonRef,
  });

  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
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
          <div
            className="flex items-center justify-between px-4 py-3 shrink-0"
            style={{ paddingTop: "max(0.75rem, var(--safe-top))" }}
          >
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
          <div
            className="flex-1 min-h-0 px-2"
            style={{ paddingBottom: "max(1rem, var(--safe-bottom))" }}
          >
            {viewer}
          </div>
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
          <div
            className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
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
