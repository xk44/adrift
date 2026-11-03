"use client";

/**
 * Last-resort boundary for errors in the root layout itself. It replaces
 * the whole document, so globals.css and theme tokens are not loaded:
 * styles are inline and self-contained.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0d0e12",
          color: "#e8e8ec",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          padding: 16,
        }}
      >
        <div
          role="alert"
          style={{
            maxWidth: 420,
            width: "100%",
            border: "1px solid #2a2c33",
            borderRadius: 12,
            background: "#16171c",
            padding: 24,
          }}
        >
          <h1 style={{ fontSize: 16, fontWeight: 500, margin: "0 0 8px" }}>
            Adrift could not start
          </h1>
          <p style={{ fontSize: 14, color: "#a0a3ad", margin: "0 0 16px" }}>
            Something failed while loading the app shell. Your images and
            settings are safe.
          </p>
          {error.message ? (
            <pre
              style={{
                fontSize: 12,
                color: "#8a8d96",
                background: "#1e2026",
                borderRadius: 8,
                padding: 12,
                margin: "0 0 16px",
                maxHeight: 128,
                overflow: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {error.message}
            </pre>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={reset}
              style={{
                background: "#e8e8ec",
                color: "#0d0e12",
                border: 0,
                borderRadius: 8,
                padding: "8px 16px",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: "transparent",
                color: "#e8e8ec",
                border: "1px solid #2a2c33",
                borderRadius: 8,
                padding: "8px 16px",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
