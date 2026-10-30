// The slice of the old PartyKit Room API the party classes use. party/room.ts builds one from a
// PartyServer Durable Object (party/server.ts); unit tests hand-build fakes.

/** Durable Object storage, as far as the parties use it. */
export interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface Connection {
  id: string;
  send(message: string): void;
}

/** Another party's instance, reached server-side. `path` is relative ("/budget"). */
export interface PartyStub {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface Room {
  /** The instance name: the room code, playlist id, host id or "global". */
  id: string;
  env: Record<string, unknown>;
  storage: Storage;
  broadcast(message: string, without?: string[]): void;
  context: { parties: Record<string, { get(id: string): PartyStub }> };
}
