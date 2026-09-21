// Loads the YouTube IFrame API once and tells every caller when it is ready.
// Shared by MusicPlayer (Timeline) and LyricsPlayer: each used to inject the script and set
// window.onYouTubeIframeAPIReady itself, and the last writer silently won.

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

/** Calls `cb` once `window.YT.Player` exists (immediately if it already does). Chains any earlier ready handler. */
export function whenYouTubeApiReady(cb: () => void): void {
  if (window.YT?.Player) {
    cb();
    return;
  }
  if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  }
  const previous = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    previous?.();
    cb();
  };
}
