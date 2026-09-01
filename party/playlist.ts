import type * as Party from "partykit/server";
import { isValidYear, sanitizeText } from "../lib/utils";
import type { EditableSong, SavedPlaylist } from "../lib/game";

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

  async onRequest(req: Party.Request): Promise<Response> {
    const url = new URL(req.url);
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

    // POST /parties/playlist/:id — save new playlist
    if (method === "POST") {
      const existing = await this.room.storage.get<SavedPlaylist>("playlist");
      if (existing) return err("Playlist already exists — use PUT to update", 409);

      const { ownerHostId, name, songs } = body as {
        ownerHostId?: unknown;
        name?: unknown;
        songs?: unknown;
      };
      if (typeof ownerHostId !== "string" || ownerHostId.trim().length === 0)
        return err("ownerHostId required");
      if (typeof name !== "string" || name.trim().length === 0)
        return err("name required");
      if (!validateSongs(songs)) return err("songs invalid — array of {videoId,title,artist,year} required");

      const playlist: SavedPlaylist = {
        id: this.room.id,
        name: sanitizeText(name, MAX_NAME_LEN),
        songs: sanitizeSongs(songs),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.room.storage.put("playlist", playlist);
      await this.room.storage.put("ownerHostId", ownerHostId.trim());
      return json({ playlistId: playlist.id }, 201);
    }

    // PUT /parties/playlist/:id — update name or songs, or update a single song
    if (method === "PUT") {
      const stored = await this.room.storage.get<SavedPlaylist>("playlist");
      if (!stored) return err("Not found", 404);

      const storedOwner = await this.room.storage.get<string>("ownerHostId");
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
        stored.updatedAt = Date.now();
        await this.room.storage.put("playlist", stored);
        return json({ ok: true });
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
      return json({ ok: true });
    }

    return err("Method not allowed", 405);
  }

  // No WebSocket needed — this party is HTTP-only
  onConnect(_conn: Party.Connection): void {}
}
