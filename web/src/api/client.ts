/**
 * REST helper for the proxied Hermes API.
 *
 * All calls are same-origin: the proxy adds the upstream Bearer token, so the
 * browser holds no credential. A token is only attached when the user set one
 * explicitly, which supports pointing the app at a Hermes instance directly.
 */
import { useUi } from '../store/ui';

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
  const res = await fetch(path, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
  });

  if (!res.ok) {
    const body = await parse(res).catch(() => null);
    throw new ApiError(errorMessage(body, res), res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return (await parse(res)) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),

  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
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

  /** Multipart upload (audio transcription, attachments). */
  upload: <T>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form }),

  /** Raw response, for blobs such as synthesized speech. */
  raw: (path: string, init: RequestInit = {}) =>
    fetch(path, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } }),
};
