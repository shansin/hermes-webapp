/**
 * REST helper for the proxied Hermes API.
 *
 * All calls are same-origin: the proxy adds the upstream Bearer token, so the
 * browser holds no credential. A token is only attached when the user set one
 * explicitly, which supports pointing the app at a Hermes instance directly.
 */
import { useUi } from '../store/ui';
import { probeAccess, markAccessRefused } from '../lib/accessSession';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function authHeaders(): Record<string, string> {
  const token = useUi.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function parse(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return res.json();
  return res.text();
}

/**
 * Turn an error body into one readable sentence.
 *
 * FastAPI reports validation failures as `detail: [{loc, msg, …}]`, which
 * stringifies to "[object Object]" if handed straight to the UI — so unpack
 * those into "field: message" before falling back to the status text.
 */
function errorMessage(body: unknown, res: Response): string {
  const detail = (body as { detail?: unknown } | null)?.detail;

  if (typeof detail === 'string' && detail) return detail;

  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        const item = d as { loc?: unknown[]; msg?: string };
        const field = Array.isArray(item.loc) ? item.loc.slice(1).join('.') : '';
        return field ? `${field}: ${item.msg ?? 'invalid'}` : (item.msg ?? '');
      })
      .filter(Boolean);
    if (parts.length) return parts.join('; ');
  }

  const err = (body as { error?: unknown } | null)?.error;
  if (typeof err === 'string' && err) return err;

  if (typeof body === 'string' && body.trim() && body.length < 300) return body;

  return res.statusText || `HTTP ${res.status}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { ...authHeaders(), ...(init.headers ?? {}) },
    });
  } catch (err) {
    // A rejected fetch is either the network being gone or Cloudflare Access
    // bouncing us to a login page that sends no CORS headers — the two are
    // indistinguishable from here, so ask. See `lib/accessSession.ts`.
    //
    // Do not treat this as the app's expiry detector. The service worker's
    // NetworkFirst route answers a failed GET of the list endpoints out of the
    // cache, so those never get here — see the comment on that route in
    // `vite.config.ts`. Writes and uncached reads do; the gateway socket covers
    // the rest.
    void probeAccess();
    throw err;
  }

  // The proxy's own gate answers 401 when it holds no valid Access assertion.
  // Believe it directly rather than probing: `/healthz` is exempt from the
  // gate, so a probe would answer 200 and we would go on reconnecting for ever.
  if (res.status === 401 || res.status === 403) markAccessRefused();

  if (!res.ok) {
    const body = await parse(res).catch(() => null);
    throw new ApiError(errorMessage(body, res), res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return (await parse(res)) as T;
}

export const api = {
  /**
   * `init` is forwarded so a caller can pass an `AbortSignal` — `fetch` has no
   * timeout of its own, and a request that dials sleeping hosts (the model
   * catalogue's refresh) would otherwise hang until the browser gives up with
   * no way to say how long is too long.
   */
  get: <T>(path: string, init?: RequestInit) => request<T>(path, init),

  /**
   * `init` is forwarded for the same reason `get` forwards it, plus one of its
   * own: a POST can be the *slowest* call the app makes. The kanban specifier
   * and decomposer each run an auxiliary model to completion inside the
   * request, which is tens of seconds on a reasoning model and minutes on a
   * local one, so those callers pass a signal with a deadline that says so
   * rather than inheriting the browser's.
   */
  post: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, {
      ...init,
      method: 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),

  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),

  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),

  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  /**
   * DELETE carrying a JSON body. `/api/files` requires one — it takes the
   * target path in the body rather than the query string, and rejects a
   * bodyless request with a 422.
   */
  delBody: <T>(path: string, body: unknown) =>
    request<T>(path, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  /** Multipart upload (audio transcription, attachments). */
  upload: <T>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form }),

  /** Raw response, for blobs such as synthesized speech. */
  raw: (path: string, init: RequestInit = {}) =>
    fetch(path, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } }),
};
