"use client";

import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/components/useFocusTrap";
import { AuthedFileLink } from "@/components/AuthedFileLink";
import { useAuthedObjectUrl } from "@/lib/authed-file";
import { nextRotation, nextZoom } from "@/lib/document-viewer";
import { X } from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { useOverlayLock } from "@/lib/overlay-lock";
import { DECIDE_SLOP, sheetDragCommits, SPRING_BACK_MS, VelocityTracker } from "@/lib/gesture";
import { tintedButtonClass } from "@/components/control-styles";

const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;

type Pan = { x: number; y: number };

/**
 * The full-screen viewer's gestures (C8, IA-22): pinch to zoom (1x-4x), drag
 * to pan while zoomed, double-tap to zoom in at the finger / back out, and
 * at 1x a swipe down dismisses (the shared sheet thresholds).
 */
function useViewerGestures(
  stageRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  view: { zoom: number; pan: Pan },
  set: (zoom: number, pan: Pan) => void,
  onDismiss: () => void
) {
  const viewRef = useRef(view);
  const setRef = useRef(set);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    viewRef.current = view;
    setRef.current = set;
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!active || !stage) return;
    let mode: "none" | "pinch" | "pan" | "dismiss" | "undecided" = "none";
    let startDist = 1;
    let startZoom = 1;
    let startPan: Pan = { x: 0, y: 0 };
    let startX = 0;
    let startY = 0;
    let moved = false;
    let dy = 0;
    let lastTap = { t: 0, x: 0, y: 0 };
    const tracker = new VelocityTracker();
    const dialog = stage.closest<HTMLElement>('[role="dialog"]');

    const distance = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

    const onStart = (event: TouchEvent) => {
      const { zoom, pan } = viewRef.current;
      if (event.touches.length === 2) {
        mode = "pinch";
        startDist = distance(event.touches) || 1;
        startZoom = zoom;
        startPan = pan;
        moved = true;
        return;
      }
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      startPan = pan;
      moved = false;
      dy = 0;
      tracker.reset(startY);
      mode = zoom > 1 ? "pan" : "undecided";
    };

    const onMove = (event: TouchEvent) => {
      if (mode === "pinch" && event.touches.length === 2) {
        event.preventDefault();
        const next = Math.min(MAX_ZOOM, Math.max(1, (startZoom * distance(event.touches)) / startDist));
        setRef.current(next, next === 1 ? { x: 0, y: 0 } : startPan);
        return;
      }
      if (event.touches.length !== 1) return;
      const mx = event.touches[0].clientX - startX;
      const my = event.touches[0].clientY - startY;
      if (!moved && Math.abs(mx) < DECIDE_SLOP && Math.abs(my) < DECIDE_SLOP) return;
      moved = true;
      if (mode === "pan") {
        event.preventDefault();
        setRef.current(viewRef.current.zoom, { x: startPan.x + mx, y: startPan.y + my });
        return;
      }
      if (mode === "undecided") {
        mode = my > 0 && Math.abs(my) > Math.abs(mx) ? "dismiss" : "none";
        if (mode === "dismiss") stage.style.transition = "none";
      }
      if (mode === "dismiss") {
        event.preventDefault();
        tracker.add(event.touches[0].clientY);
        dy = Math.max(0, my);
        stage.style.transform = `translateY(${dy}px)`;
        if (dialog) dialog.style.backgroundColor = `rgb(38 34 31 / ${0.9 * (1 - Math.min(1, dy / 400))})`;
      }
    };

    const springBack = () => {
      stage.style.transition = `transform ${SPRING_BACK_MS}ms var(--ease-drawer)`;
      stage.style.transform = "";
      if (dialog) dialog.style.backgroundColor = "";
      window.setTimeout(() => {
        stage.style.transition = "";
      }, SPRING_BACK_MS + 20);
    };

    const onEnd = (event: TouchEvent) => {
      if (mode === "dismiss") {
        mode = "none";
        if (sheetDragCommits(dy, stage.offsetHeight || 1, tracker.velocity())) {
          dismissRef.current();
        } else springBack();
        return;
      }
      if (mode === "pinch") {
        if (event.touches.length === 0) mode = "none";
        return;
      }
      const wasTap = !moved && event.changedTouches.length === 1;
      mode = "none";
      if (!wasTap) return;
      const touch = event.changedTouches[0];
      const now = performance.now();
      if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) < 30) {
        lastTap = { t: 0, x: 0, y: 0 };
        event.preventDefault();
        const { zoom } = viewRef.current;
        if (zoom > 1) setRef.current(1, { x: 0, y: 0 });
        else {
          const rect = stage.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          setRef.current(DOUBLE_TAP_ZOOM, {
            x: (touch.clientX - cx) * (1 - DOUBLE_TAP_ZOOM),
            y: (touch.clientY - cy) * (1 - DOUBLE_TAP_ZOOM),
          });
        }
        return;
      }
      lastTap = { t: now, x: touch.clientX, y: touch.clientY };
    };

    stage.addEventListener("touchstart", onStart, { passive: true });
    stage.addEventListener("touchmove", onMove, { passive: false });
    stage.addEventListener("touchend", onEnd);
    stage.addEventListener("touchcancel", onEnd);
    return () => {
      stage.removeEventListener("touchstart", onStart);
      stage.removeEventListener("touchmove", onMove);
      stage.removeEventListener("touchend", onEnd);
      stage.removeEventListener("touchcancel", onEnd);
      stage.style.transform = "";
      stage.style.transition = "";
    };
  }, [active, stageRef]);
}

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
  // Exit motion (SHELL-13): the viewer stays mounted for its fade/scale out.
  const [closing, setClosing] = useState(false);
  // "Yritä uudelleen" after a failed preview (BOOKS-21) refetches with a fresh URL.
  const [retryKey, setRetryKey] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const kind = previewKind(fileName);
  const baseImageSrc = previewSrc(src, kind);
  const imageSrc = retryKey
    ? `${baseImageSrc}${baseImageSrc.includes("?") ? "&" : "?"}retry=${retryKey}`
    : baseImageSrc;
  // Web: `authedSrc` is `imageSrc` unchanged, exactly like today. Mobile:
  // fetched with the bearer token and exposed as a `blob:` object URL --
  // there is no cookie for a bare `<img src>` to ride along on.
  const { src: authedSrc, failed: authedFailed } = useAuthedObjectUrl(
    kind === "other" ? null : imageSrc
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    setPreviewFailed(false);
    setLoading(true);
  }, [imageSrc]);

  useEffect(() => {
    if (!authedFailed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing external state (the authed fetch failing) into local state, same as the img onError handler below
    setLoading(false);
    setPreviewFailed(true);
  }, [authedFailed]);

  function closeViewer() {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => {
      setFullscreen(false);
      setClosing(false);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setRotation(0);
    }, 200);
  }

  // AX-10 / IA-22: the page behind the viewer is locked and inert.
  useOverlayLock(fullscreen);
  useViewerGestures(
    stageRef,
    fullscreen && !closing,
    { zoom, pan },
    (nextZoomValue, nextPan) => {
      setZoom(nextZoomValue);
      setPan(nextPan);
    },
    closeViewer
  );

  useFocusTrap(dialogRef, fullscreen, {
    onEscape: closeViewer,
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

  function renderViewer(fill: boolean) {
    return (
      <PreviewBody
        src={src}
        imageSrc={authedSrc}
        kind={kind}
        fileName={fileName}
        fill={fill}
        zoom={fill ? zoom : 1}
        pan={fill ? pan : { x: 0, y: 0 }}
        rotation={fill ? rotation : 0}
        failed={previewFailed}
        loading={loading}
        onRetry={() => setRetryKey((value) => value + 1)}
        onLoad={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setPreviewFailed(true);
        }}
      />
    );
  }

  return (
    <>
      <div className="relative overflow-hidden rounded-card border border-line bg-surface">
        <div className={compact ? "h-28" : "h-48 sm:h-56"}>
          {renderViewer(false)}
        </div>
        {!previewFailed && kind !== "other" && (
        <button
          ref={openButtonRef}
          type="button"
          onClick={() => setFullscreen(true)}
          className="active-press absolute bottom-2 right-2 min-h-11 rounded-card bg-ink/80 px-3 text-caption font-medium text-canvas backdrop-blur-sm"
        >
          Koko näyttö
        </button>
        )}
      </div>

      {fullscreen && (
        <div
          ref={dialogRef}
          className={`fixed inset-0 z-[100] bg-ink/90 flex flex-col ${closing ? "animate-backdrop-out pointer-events-none" : "animate-fade-in"}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="receipt-preview-title"
          data-overlay-root=""
        >
          <div
            className="flex items-center justify-between px-4 py-3 shrink-0"
            style={{ paddingTop: "max(0.75rem, var(--safe-top))" }}
          >
            <p id="receipt-preview-title" className="text-sm text-white truncate pr-4">
              {fileName}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                data-testid="preview-zoom"
                onClick={() => {
                  setZoom((current) => nextZoom(current));
                  setPan({ x: 0, y: 0 });
                }}
                className="min-h-11 px-3 rounded-lg bg-white/15 text-white text-sm hover:bg-white/25 transition-colors"
              >
                Suurenna
              </button>
              <button
                type="button"
                data-testid="preview-rotate"
                onClick={() => setRotation((current) => nextRotation(current))}
                className="min-h-11 px-3 rounded-lg bg-white/15 text-white text-sm hover:bg-white/25 transition-colors"
              >
                Kierrä
              </button>
              {/* Close is an X, top-right, as on every modal (IA-21). */}
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeViewer}
                aria-label="Sulje"
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 transition-colors"
              >
                <Icon icon={X} strokeWidth={2} />
              </button>
            </div>
          </div>
          {/\.(heic|heif)$/i.test(fileName) && (
            <p className="px-4 text-xs text-white/80">
              HEIC-esikatselu riippuu laitteen tuesta. Tätä ei ole varmennettu kameran rullalla.
            </p>
          )}
          <div
            ref={stageRef}
            className={`flex-1 min-h-0 px-2 overflow-auto ${closing ? "animate-scale-out" : "animate-scale-in"}`}
            // The stage owns every touch (pinch, pan, double-tap, swipe down).
            style={{ paddingBottom: "max(1rem, var(--safe-bottom))", touchAction: "none" }}
            data-testid="preview-stage"
          >
            {renderViewer(true)}
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
  zoom,
  pan,
  rotation,
  failed,
  loading,
  onLoad,
  onError,
  onRetry,
}: {
  src: string;
  imageSrc: string | null;
  kind: PreviewKind;
  fileName: string;
  fill: boolean;
  zoom: number;
  pan: Pan;
  rotation: number;
  failed: boolean;
  loading: boolean;
  onLoad: () => void;
  onError: () => void;
  onRetry: () => void;
}) {
  if (kind === "other") {
    return <UnsupportedPreview src={src} fileName={fileName} />;
  }

  if (failed) {
    return (
      <UnsupportedPreview
        src={src}
        fileName={fileName}
        message={
          kind === "rendered"
            ? "Esikatselun luonti epäonnistui. Voit avata alkuperäisen tiedoston."
            : "Esikatselua ei saatu ladattua."
        }
        onRetry={onRetry}
      />
    );
  }

  return (
    <div className={`relative w-full h-full bg-surface ${fill ? "rounded-xl" : ""}`}>
      {(loading || !imageSrc) && (
        <div className="absolute inset-0 flex items-center justify-center bg-canvas/80 z-10">
          <div
            className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        </div>
      )}
      {imageSrc && (
        // imageSrc is a blob: object URL on mobile (Task 9) or the
        // authenticated API path on web, neither of which next/image can
        // optimize, and the mobile static export has no image optimizer anyway.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageSrc}
          alt={fileName}
          onLoad={onLoad}
          onError={onError}
          className="w-full h-full object-contain"
          data-testid={fill ? "preview-image" : undefined}
          style={
            fill
              ? {
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
                  transformOrigin: "center center",
                }
              : undefined
          }
        />
      )}
      {kind === "rendered" && !loading && imageSrc && (
        <AuthedFileLink
          href={src}
          fallbackName={fileName}
          title={fileName}
          className="absolute bottom-2 left-2 right-2 min-h-11 flex items-center justify-center rounded-card bg-ink/75 text-canvas text-caption font-medium backdrop-blur-sm"
        >
          Avaa alkuperäinen tiedosto
        </AuthedFileLink>
      )}
    </div>
  );
}

function UnsupportedPreview({
  src,
  fileName,
  message = "Esikatselu ei ole saatavilla tälle tiedostotyypille.",
  onRetry,
}: {
  src: string;
  fileName: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-sm text-ink-2 p-4">
      <p className="text-center">{message}</p>
      <AuthedFileLink
        href={src}
        fallbackName={fileName}
        title={fileName}
        className="text-accent font-medium hover:underline min-h-11 inline-flex items-center"
      >
        Avaa tiedosto
      </AuthedFileLink>
      {onRetry && (
        <button type="button" onClick={onRetry} className={tintedButtonClass("accent")}>
          Yritä uudelleen
        </button>
      )}
    </div>
  );
}
