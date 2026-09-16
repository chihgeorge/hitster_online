import Link from "next/link";

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#FFF9F5",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        padding: "0 20px",
        fontFamily: "var(--font-zh)",
      }}
    >
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, #FF6B35 0%, #E85520 34%, #1A1A2E 36%, #1A1A2E 42%, #E85520 44%, #1A1A2E 46%, #1A1A2E 56%, #E85520 58%, #1A1A2E 60%, #1A1A2E 100%)",
          boxShadow: "0 8px 32px rgba(255,107,53,.3)",
          flexShrink: 0,
        }}
      />

      <div style={{ textAlign: "center", maxWidth: 320 }}>
        <p style={{ fontSize: 13, letterSpacing: ".12em", color: "#B0AFBC", textTransform: "uppercase", marginBottom: 8 }}>
          404
        </p>
        <h1 style={{ fontSize: 22, fontWeight: 900, color: "#1A1A2E", marginBottom: 6, lineHeight: 1.3 }}>
          找不到這個頁面
        </h1>
        <p style={{ fontSize: 14, color: "#7B7B9A", marginBottom: 0 }}>
          Page not found
        </p>
      </div>

      <Link
        href="/"
        style={{
          background: "#FF6B35",
          color: "white",
          border: "none",
          borderRadius: 14,
          padding: "12px 28px",
          fontSize: 15,
          fontWeight: 700,
          textDecoration: "none",
          boxShadow: "0 4px 16px rgba(255,107,53,.3)",
        }}
      >
        回首頁 · Home
      </Link>
    </main>
  );
}
