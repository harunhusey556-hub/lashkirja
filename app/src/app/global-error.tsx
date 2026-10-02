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
          background: "#f7f3ef",
          color: "#1a1a1a",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <main style={{ maxWidth: "24rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.0625rem", fontWeight: 600 }}>Jotain meni pieleen</h1>
          <p style={{ fontSize: "0.9375rem" }}>Sovellusta ei voitu näyttää. Yritä ladata se uudelleen.</p>
          <button
            type="button"
            onClick={unstable_retry}
            style={{
              minHeight: "48px",
              padding: "0 1.25rem",
              border: 0,
              borderRadius: "999px",
              background: "#1a1a1a",
              color: "#f7f3ef",
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
