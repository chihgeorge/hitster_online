/**
 * Reads a persisted per-browser id from localStorage, generating and storing one if missing.
 * Used for the host credential (hostId), the screen credential (screenId) and the player id — same
 * "one random token per device, kept in localStorage" shape, different keys.
 */
export function getOrCreatePersistedId(key: string): string {
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}
