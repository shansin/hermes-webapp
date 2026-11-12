/**
 * The updates feed read.
 *
 * The saving on the badge's 60s poll happens entirely in the browser's HTTP
 * cache: the proxy tags the feed `no-cache` with an ETag, and a default-mode
 * `fetch` revalidates with `If-None-Match` and is handed the stored body on a
 * 304. Nothing in the app would look different if a cache override crept onto
 * this request — the poll would simply download the whole feed again every
 * minute — so the absence of one is pinned here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFeed } from '../src/api/notifications';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('fetchFeed', () => {
  it('reads /push/feed in the default cache mode, so the browser revalidates it', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ entries: [], total: 0, unread: 0, lastReadAt: 0 }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(fetchFeed()).resolves.toEqual({ entries: [], total: 0, unread: 0, lastReadAt: 0 });

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/push/feed');
    expect((init as RequestInit).cache).toBeUndefined();
    // Setting the validator by hand would bypass the browser's cache: a 304
    // would then reach the app as an empty, non-ok response.
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has('if-none-match')).toBe(false);
  });
});
