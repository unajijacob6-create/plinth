// Small HTTP helpers shared by every route. Nothing here touches a secret.

/** What a route needs from the outside world; tests replace all of it. */
export interface Deps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** Wait between RPC retries (tests pass a no-op). */
  sleep: (ms: number) => Promise<void>;
}

export const realDeps = (): Deps => ({
  fetch: (input, init) => fetch(input, init),
  env: process.env,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** CORS: every route is public, read-only or proxied, and sends no cookies, so any origin may call it.
 *  Set here (not in vercel.json) so the same header is never sent twice. */
export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-expose-headers": "x-plinth-jwt, x-plinth-source, retry-after",
  "access-control-max-age": "86400",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...CORS, ...headers },
  });
}

/** A JSON error every client can read the same way: {error: <code>, message: <plain sentence>}. */
export function fail(status: number, error: string, message: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Response {
  return json({ error, message, ...extra }, status, headers);
}

export const methodNotAllowed = (allow: string) => fail(405, "method_not_allowed", `Use ${allow}.`, { allow });

/** Thrown by helpers; the router turns it into `fail(...)`. */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The request body as bytes, refusing more than `max` bytes without buffering the rest. */
export async function readBody(request: Request, max: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, "body_too_large", `The request body may be at most ${max} bytes.`);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "body_too_large", `The request body may be at most ${max} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}

/** A JSON object body (not an array, not a scalar) of at most `max` bytes, sent as application/json. */
export async function readJsonObject(request: Request, max: number): Promise<Record<string, unknown>> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "not_json", "Send the body as application/json.");
  const bytes = await readBody(request, max);
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "bad_json", "The body is not valid JSON.");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "bad_json", "The body must be a JSON object.");
  return v as Record<string, unknown>;
}

/** The caller's address as Vercel reports it (it overwrites these headers, so a client cannot set them). */
export function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = request.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

/** Token bucket per key, in the memory of one function instance. Best effort: Vercel may run several
 *  instances and restarts them at will, so this slows abuse down, it does not stop it. */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private capacity: number,
    private refillPerSecond: number,
    private maxKeys = 5000,
  ) {}
  take(key: string, nowMs: number): { ok: boolean; retryAfterSeconds: number } {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.clear();
      b = { tokens: this.capacity, at: nowMs };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (Math.max(0, nowMs - b.at) / 1000) * this.refillPerSecond);
    b.at = nowMs;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterSeconds: 0 };
    }
    return { ok: false, retryAfterSeconds: Math.ceil((1 - b.tokens) / this.refillPerSecond) };
  }
}

export const tooMany = (retryAfterSeconds: number) => fail(429, "rate_limited", `Too many requests. Try again in ${retryAfterSeconds} s.`, { "retry-after": String(retryAfterSeconds) });

export const escapeHtml = (s: unknown): string => String(s).replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[c]!);

/** A value for an inline <script>: JSON with every character that could end the script or start markup escaped. */
export const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/[<>&  ]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** The public origin of this deployment, for absolute URLs in share pages. PLINTH_SITE_URL wins. */
export function publicOrigin(request: Request, env: Record<string, string | undefined>): string {
  const fixed = env.PLINTH_SITE_URL;
  if (fixed && /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(fixed)) return fixed.replace(/\/$/, "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  if (/^[a-z0-9.-]+(:\d+)?$/i.test(host)) {
    const proto = request.headers.get("x-forwarded-proto") === "http" || /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
    return `${proto}://${host.toLowerCase()}`;
  }
  return new URL(request.url).origin;
}
