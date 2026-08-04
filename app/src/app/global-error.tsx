"use client";

export default function GlobalError({
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="fi">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1rem",
          boxSizing: "border-box",
          background: "#faf8f5",
          color: "#2d2d2d",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <main style={{ maxWidth: "24rem", textAlign: "center" }}>
          <h1>Palvelu ei ole juuri nyt käytettävissä</h1>
          <p>Yritä ladata sovellus uudelleen.</p>
          <button
            type="button"
            onClick={unstable_retry}
            style={{
              minHeight: "44px",
              padding: "0 1rem",
              border: 0,
              borderRadius: "0.75rem",
              background: "#9a5650",
              color: "white",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Yritä uudelleen
          </button>
        </main>
      </body>
    </html>
  );
}
