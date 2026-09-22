/** Spinning vinyl record — the app's recurring brand mark. Used on the homepage, the play page's
 * loading/status screens, and the winner screen. See TODOS.md: previously duplicated verbatim
 * (as `Vinyl` in app/page.tsx and `SmallVinyl` in the play page) before this extraction. */
export default function Vinyl({ size = 160 }: { size?: number }) {
  return (
    <div
      className="animate-vinyl rounded-full flex-shrink-0 relative"
      style={{
        width: size, height: size,
        background: `radial-gradient(circle, var(--orange) 0%, var(--orange-dk) 34%, var(--ink) 36%, var(--ink) 42%, var(--orange-dk) 44%, var(--ink) 46%, var(--ink) 56%, var(--orange-dk) 58%, var(--ink) 60%, var(--ink) 100%)`,
        boxShadow: "0 12px 48px rgba(255,107,53,.38), 0 4px 12px rgba(0,0,0,.2)",
      }}
    >
      <div className="absolute rounded-full" style={{
        top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: size * 0.2, height: size * 0.2,
        background: "var(--bg)",
        boxShadow: `0 0 0 ${size * 0.05}px rgba(255,107,53,.18)`,
      }} />
    </div>
  );
}
