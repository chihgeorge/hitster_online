// Same-browser presence for a room's /screen tab, over BroadcastChannel (TODOS.md, Host & Screen).
//
// The host's screen link finds an open screen tab through window.open("", name), which only works
// while the host tab is that screen tab's opener. Once the host page is reloaded or reopened, the
// lookup misses, a second screen tab opens, and the song plays twice. The screen tab answers here
// instead, so the host can tell a screen is already open even when it can't reach that tab.
//
// Protocol on channel `hitster-screen-<code>`:
//   host → { type: "ping" }            screens answer with "here"
//   screen → { type: "here", id }      on load and in answer to a ping
//   screen → { type: "gone", id }      on pagehide

export const PING_GRACE_MS = 1000;

type Msg ={ type: "ping" } | { type: "here"; id: string } | { type: "gone"; id: string };

function openChannel(code: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(`hitster-screen-${code}`);
  } catch {
    return null;
  }
}

/** Screen side: announce this tab and answer pings until the returned cleanup runs. */
export function announceScreen(code: string): () => void {
  const channel = openChannel(code);
  if (!channel) return () => {};
  const id = Math.random().toString(36).slice(2);
  const post = (m: Msg) => { try { channel.postMessage(m); } catch { /* channel closed */ } };
  channel.onmessage = (e: MessageEvent<Msg>) => { if (e.data?.type === "ping") post({ type: "here", id }); };
  const gone = () => post({ type: "gone", id });
  // A page restored from the back/forward cache comes back without a new mount: announce again.
  const back = (e: PageTransitionEvent) => { if (e.persisted) post({ type: "here", id }); };
  window.addEventListener("pagehide", gone);
  window.addEventListener("pageshow", back);
  post({ type: "here", id });
  return () => {
    gone();
    window.removeEventListener("pagehide", gone);
    window.removeEventListener("pageshow", back);
    channel.close();
  };
}

/**
 * Host side: calls `onChange(true)` while at least one screen tab for this room is open in this
 * browser. Re-checks whenever the host tab regains focus, which clears tabs that closed without
 * saying so (a discarded tab never answers the ping).
 */
export function watchScreens(code: string, onChange: (open: boolean) => void): () => void {
  const channel = openChannel(code);
  if (!channel) return () => {};
  const open = new Set<string>();
  // Tabs that haven't answered the latest ping yet. They stay counted until the grace period ends,
  // so a click right after the host tab regains focus still sees the open screen.
  let unanswered = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = () => onChange(open.size > 0);
  channel.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data;
    if (m?.type === "here") { open.add(m.id); unanswered.delete(m.id); }
    else if (m?.type === "gone") open.delete(m.id);
    else return;
    report();
  };
  const ping = () => {
    unanswered = new Set(open);
    clearTimeout(timer);
    timer = setTimeout(() => {
      unanswered.forEach((id) => open.delete(id));
      report();
    }, PING_GRACE_MS);
    try { channel.postMessage({ type: "ping" } satisfies Msg); } catch { /* channel closed */ }
  };
  window.addEventListener("focus", ping);
  ping();
  return () => {
    clearTimeout(timer);
    window.removeEventListener("focus", ping);
    channel.close();
  };
}
