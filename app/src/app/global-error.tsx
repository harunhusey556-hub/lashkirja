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
          background: "#f6f3ef",
          color: "#26221f",
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
              minHeight: "48px",
              padding: "0 1.25rem",
              border: 0,
              borderRadius: "14px",
              background: "#26221f",
              color: "#f6f3ef",
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
