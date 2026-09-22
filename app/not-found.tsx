import Link from "next/link";

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
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
            "radial-gradient(circle, var(--orange) 0%, var(--orange-dk) 34%, var(--ink) 36%, var(--ink) 42%, var(--orange-dk) 44%, var(--ink) 46%, var(--ink) 56%, var(--orange-dk) 58%, var(--ink) 60%, var(--ink) 100%)",
          boxShadow: "0 8px 32px rgba(255,107,53,.3)",
          flexShrink: 0,
        }}
      />

      <div style={{ textAlign: "center", maxWidth: 320 }}>
        <p style={{ fontSize: 13, letterSpacing: ".12em", color: "var(--text3)", textTransform: "uppercase", marginBottom: 8 }}>
          404
        </p>
        <h1 style={{ fontSize: 22, fontWeight: 900, color: "var(--ink)", marginBottom: 6, lineHeight: 1.3 }}>
          找不到這個頁面
        </h1>
        <p style={{ fontSize: 14, color: "var(--text2)", marginBottom: 0 }}>
          Page not found
        </p>
      </div>

      <Link
        href="/"
        style={{
          background: "var(--orange)",
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
