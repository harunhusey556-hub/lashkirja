"use client";

import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { Icon } from "@/components/ds";
import { useAuthedObjectUrl } from "@/lib/authed-file";
import { RECEIPT_THUMB_PX } from "@/lib/receipt-thumb";

/**
 * The receipt's small picture in a list row. Size is fixed (no layout shift),
 * the image is lazy and decoded off the main thread, and a missing or broken
 * file falls back to the plain glyph. On the mobile build the bytes need the
 * bearer token, so the fetch starts only once the row scrolls into view.
 */
export function ReceiptThumb({ url }: { url: string }) {
  const holder = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const node = holder.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { src, failed } = useAuthedObjectUrl(near ? url : null);

  return (
    <span ref={holder} className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full">
      {src && !failed && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- an authenticated API image at a fixed 40 px, not a static asset next/image can optimise
        <img
          src={src}
          alt=""
          width={RECEIPT_THUMB_PX}
          height={RECEIPT_THUMB_PX}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          className="h-10 w-10 object-cover"
        />
      ) : (
        <Icon icon={FileText} />
      )}
    </span>
  );
}
