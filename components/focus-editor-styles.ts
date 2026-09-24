// Shared style constants for the two Focus editors (SongItemEditor.tsx, T4;
// LyricRoundItemEditor.tsx, T6, docs/designs/full-page-focus-editor.md) — was duplicated
// byte-for-byte in both files (ponytail-audit finding). The two components stay separate
// (different data models, different data flow for AI editing) — only the CSS objects,
// which genuinely are identical, move here.

export const focusFieldBox: React.CSSProperties = {
  background: "var(--surface2)", border: "2px solid rgba(255,107,53,.2)", borderRadius: 14,
  padding: "12px 16px", outline: "none", fontFamily: "var(--font-zh)", color: "var(--ink)",
  textAlign: "center", width: "100%",
};

export const focusNavBtn: React.CSSProperties = {
  background: "rgba(26,26,46,.06)", border: "none", borderRadius: 12, padding: "10px 18px",
  fontSize: 13, fontWeight: 700, color: "var(--ink)", cursor: "pointer",
};
