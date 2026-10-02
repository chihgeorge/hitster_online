// JSON responses with CORS for the HTTP parties (playlist, library). Shared so the two can't drift.
// One method list for both: a preflight advertising a method a party doesn't handle is harmless (the handler 405s it).
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

export function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}
