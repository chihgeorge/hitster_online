import type * as Party from "partykit/server";
import { isValidYear, sanitizeText } from "../lib/utils";
import type { EditableSong, SavedPlaylist } from "../lib/game";
import { extractPlaylistId } from "../lib/game";
import {
  resolvePlaylistFromUrl,
  resolveEnv,
  parseResolveErrorCode,
  PLAYLIST_ID_PATTERN,
} from "../lib/playlist-resolver";
import { proposeEdits } from "../lib/ai-metadata";

const MAX_SONGS = 500;
const MAX_NAME_LEN = 80;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

function validateSongs(songs: unknown): songs is EditableSong[] {
  if (!Array.isArray(songs)) return false;
  if (songs.length === 0 || songs.length > MAX_SONGS) return false;
  return songs.every(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as EditableSong).videoId === "string" &&
      (s as EditableSong).videoId.length > 0 &&
      typeof (s as EditableSong).title === "string" &&
      (s as EditableSong).title.trim().length > 0 &&
      typeof (s as EditableSong).artist === "string" &&
      typeof (s as EditableSong).year === "number" &&
      isValidYear((s as EditableSong).year)
  );
}

function sanitizeSongs(songs: EditableSong[]): EditableSong[] {
  return songs.map((s) => ({
    videoId: s.videoId,
    title: sanitizeText(s.title, 200),
    artist: sanitizeText(s.artist, 100),
    year: s.year,
  }));
}

export default class PlaylistParty implements Party.Server {
  constructor(readonly room: Party.Room) {}

  /**
   * D2a (docs/designs/decouple-quiz-bank.md): keeps the owner's library index in sync with
   * this playlist's own storage — called from POST (create) and DELETE, server-side, so a
   * client never has to make two calls itself (and can't half-fail into an orphan by
   * closing the tab between them). Durable Objects don't support cross-DO transactions, so
   * this is best-effort: a failure here is logged but never fails the playlist write/delete
   * that already succeeded. Accepted gap, not a hard guarantee — see D2a's Implementation
   * Task for the self-heal path (a library read missing an entry the client expects
   * triggers a reconcile), not built in this PR.
   */
  private async syncLibrary(action: "UPSERT" | "REMOVE", ownerHostId: string, entry: { id: string; name: string; songCount: number } | { id: string }) {
    try {
      const stub = this.room.context.parties.library.get(ownerHostId);
      const body = action === "UPSERT" ? { action, entry } : { action, id: entry.id };
      const res = await stub.fetch("/", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        console.error(JSON.stringify({ event: "library_sync_failed", action, ownerHostId, playlistId: entry.id, status: res.status }));
      }
    } catch (err) {
      console.error(JSON.stringify({ event: "library_sync_failed", action, ownerHostId, playlistId: entry.id, error: String(err) }));
    }
  }

  async onRequest(req: Party.Request): Promise<Response> {
    const method = req.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET /parties/playlist/:id — fetch playlist
    if (method === "GET") {
      const stored = await this.room.storage.get<SavedPlaylist>("playlist");
      if (!stored) return err("Not found", 404);
      return json(stored);
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return err("Invalid JSON");
    }

    // POST /parties/playlist/:id — save new playlist. Either the client already resolved
    // songs (the original path) or asks THIS party to resolve them from a YouTube URL
    // itself (action: "RESOLVE_FROM_URL" — docs/designs/decouple-quiz-bank.md, D1/D2): the
    // one entry point a room-less standalone page needs, since this party never had a
    // WebSocket to stream progress over, this blocks until the whole pipeline finishes.
    if (method === "POST") {
      const existing = await this.room.storage.get<SavedPlaylist>("playlist");
      if (existing) return err("Playlist already exists — use PUT to update", 409);

      const { ownerHostId, name, action } = body as {
        ownerHostId?: unknown;
        name?: unknown;
        action?: unknown;
      };
      if (typeof ownerHostId !== "string" || ownerHostId.trim().length === 0)
        return err("ownerHostId required");
      if (typeof name !== "string" || name.trim().length === 0)
        return err("name required");

      let songs: EditableSong[];
      if (action === "RESOLVE_FROM_URL") {
        const { playlistUrl } = body as { playlistUrl?: unknown };
        if (typeof playlistUrl !== "string" || !playlistUrl.trim()) return err("playlistUrl required");
        const playlistId = extractPlaylistId(playlistUrl);
        if (!PLAYLIST_ID_PATTERN.test(playlistId)) return err("playlist_load_failed");
        try {
          const keys = resolveEnv(this.room.env);
          const resolved = await resolvePlaylistFromUrl(playlistId, keys, this.room.storage);
          if (resolved.allSongs.length < 2) return err("not_enough_songs");
          songs = resolved.allSongs;
        } catch (e) {
          return err(parseResolveErrorCode(e));
        }
      } else {
        const { songs: rawSongs } = body as { songs?: unknown };
        if (!validateSongs(rawSongs)) return err("songs invalid — array of {videoId,title,artist,year} required");
        songs = sanitizeSongs(rawSongs);
      }

      const playlist: SavedPlaylist = {
        id: this.room.id,
        name: sanitizeText(name, MAX_NAME_LEN),
        songs,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.room.storage.put("playlist", playlist);
      await this.room.storage.put("ownerHostId", ownerHostId.trim());
      await this.syncLibrary("UPSERT", ownerHostId.trim(), { id: playlist.id, name: playlist.name, songCount: playlist.songs.length });
      return json({ playlistId: playlist.id }, 201);
    }

    // PUT /parties/playlist/:id — update name or songs, or update a single song
    if (method === "PUT") {
      const [stored, storedOwner] = await Promise.all([
        this.room.storage.get<SavedPlaylist>("playlist"),
        this.room.storage.get<string>("ownerHostId"),
      ]);
      if (!stored) return err("Not found", 404);
      const { ownerHostId } = body as { ownerHostId?: unknown };
      if (ownerHostId !== storedOwner) return err("Unauthorized", 403);

      const action = (body as { action?: unknown }).action;

      // UPDATE_SONG: patch a single song by videoId
      if (action === "UPDATE_SONG") {
        const { videoId, title, artist, year } = body as {
          videoId?: unknown;
          title?: unknown;
          artist?: unknown;
          year?: unknown;
        };
        if (typeof videoId !== "string") return err("videoId required");
        const idx = stored.songs.findIndex((s) => s.videoId === videoId);
        if (idx === -1) return err("Song not found", 404);
        if (title !== undefined) {
          if (typeof title !== "string" || title.trim().length === 0)
            return err("title must be non-empty string");
          stored.songs[idx].title = sanitizeText(title as string, 200);
        }
        if (artist !== undefined) {
          if (typeof artist !== "string") return err("artist must be string");
          stored.songs[idx].artist = sanitizeText(artist as string, 100);
        }
        if (year !== undefined) {
          if (typeof year !== "number" || !isValidYear(year as number))
            return err("year must be valid (1900–current+1)");
          stored.songs[idx].year = year as number;
        }
        stored.updatedAt = Date.now();
        await this.room.storage.put("playlist", stored);
        return json({ ok: true });
      }

      // DELETE_SONG: remove a song by videoId
      if (action === "DELETE_SONG") {
        const { videoId } = body as { videoId?: unknown };
        if (typeof videoId !== "string") return err("videoId required");
        const before = stored.songs.length;
        stored.songs = stored.songs.filter((s) => s.videoId !== videoId);
        if (stored.songs.length === before) return err("Song not found", 404);
        if (stored.songs.length < 2) return err("Cannot delete — playlist must keep at least 2 songs", 400);
        stored.updatedAt = Date.now();
        await this.room.storage.put("playlist", stored);
        return json({ ok: true });
      }

      // PROPOSE_EDITS: AI chat-to-diff editing (T3, docs/designs/full-page-focus-editor.md;
      // HTTP-shaped like RESOLVE_FROM_URL above, not WebSocket-shaped like party/index.ts's
      // handleProposeEdits, which this mirrors otherwise). Never mutates the stored playlist —
      // returns a diff for the client to review and PUT back via UPDATE_SONG, same contract
      // as the room's own chat-to-diff editing.
      if (action === "PROPOSE_EDITS") {
        const { instruction } = body as { instruction?: unknown };
        if (typeof instruction !== "string" || !instruction.trim()) return err("instruction required");
        const { anthropicKey } = resolveEnv(this.room.env);
        if (!anthropicKey) return err("api_key_missing", 503);
        try {
          const diff = await proposeEdits(instruction, stored.songs, anthropicKey);
          return json({ diff });
        } catch (e) {
          console.error(JSON.stringify({ event: "propose_edits_failed", playlistId: this.room.id, error: String(e) }));
          return err("propose_failed", 502);
        }
      }

      // Default PUT: replace name and/or songs
      const { name, songs } = body as { name?: unknown; songs?: unknown };
      if (name !== undefined) {
        if (typeof name !== "string" || name.trim().length === 0)
          return err("name must be non-empty string");
        stored.name = sanitizeText(name, MAX_NAME_LEN);
      }
      if (songs !== undefined) {
        if (!validateSongs(songs)) return err("songs invalid");
        stored.songs = sanitizeSongs(songs as EditableSong[]);
      }
      stored.updatedAt = Date.now();
      await this.room.storage.put("playlist", stored);
      return json({ ok: true });
    }

    // DELETE /parties/playlist/:id — delete playlist
    if (method === "DELETE") {
      const storedOwner = await this.room.storage.get<string>("ownerHostId");
      const { ownerHostId } = body as { ownerHostId?: unknown };
      if (ownerHostId !== storedOwner) return err("Unauthorized", 403);
      await this.room.storage.deleteAll();
      if (storedOwner) await this.syncLibrary("REMOVE", storedOwner, { id: this.room.id });
      return json({ ok: true });
    }

    return err("Method not allowed", 405);
  }

  // No WebSocket needed — this party is HTTP-only
  onConnect(_conn: Party.Connection): void {}
}
