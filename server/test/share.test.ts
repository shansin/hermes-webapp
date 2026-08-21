/**
 * The share target's server-side fallback.
 *
 * This route only runs when the service worker did not — an install whose
 * worker is being replaced, or a browser that offered the share target before
 * registration finished. That makes it both rare and completely invisible in
 * normal use, which is exactly the shape of thing that rots: the day it does
 * run, someone is standing in a share sheet watching this decide whether they
 * get their text back or a browser error.
 */
import { describe, expect, it } from 'vitest';
import { shareRouter } from '../src/routers/share.js';

async function share(form: FormData, headers: Record<string, string> = {}) {
  const res = await shareRouter.request(
    new Request('http://proxy.test/share', { method: 'POST', body: form, headers }),
  );
  const location = res.headers.get('location') ?? '';
  return { res, location, params: new URL(location, 'http://proxy.test').searchParams };
}

describe('POST /share', () => {
  /**
   * 303 is the whole point of the route. A 302 has the browser repeat the
   * POST at `/chat`, which nothing answers.
   */
  it('turns the POST into a GET at a new chat', async () => {
    const form = new FormData();
    form.set('text', 'hello');

    const { res, params } = await share(form);

    expect(res.status).toBe(303);
    expect(params.get('new')).toBe('1');
  });

  it('carries the text fields the share sheet filled in', async () => {
    const form = new FormData();
    form.set('title', 'A page');
    form.set('url', 'https://example.com');

    const { params } = await share(form);

    expect(params.get('title')).toBe('A page');
    expect(params.get('url')).toBe('https://example.com');
  });

  it('leaves out the fields it was not given, rather than sending them empty', async () => {
    const form = new FormData();
    form.set('title', 'Only a title');
    form.set('text', '   ');

    const { params } = await share(form);

    expect(params.has('text')).toBe(false);
    expect(params.has('url')).toBe(false);
  });

  /**
   * The apology. A file cannot survive this path — there is no session to
   * attach it to — and an empty `share` is what makes the chat screen say so
   * instead of opening a blank chat as though nothing had been shared.
   */
  it('flags a share whose files it had to drop', async () => {
    const form = new FormData();
    form.set('text', 'look at this');
    form.set('files', new File(['bytes'], 'photo.jpg', { type: 'image/jpeg' }));

    const { params } = await share(form);

    expect(params.get('share')).toBe('');
    expect(params.get('text')).toBe('look at this');
  });

  it('does not flag a text-only share', async () => {
    const form = new FormData();
    form.set('text', 'just words');

    const { params } = await share(form);

    expect(params.has('share')).toBe(false);
  });

  /**
   * The body is never read above the limit: buffering a photo on the event
   * loop that also relays the chat socket, in order to discard it, is the one
   * thing this route must not do.
   */
  it('refuses to buffer a large body, and still lands somewhere', async () => {
    const form = new FormData();
    form.set('text', 'ignored');

    const { res, params } = await share(form, { 'content-length': String(8 * 1024 * 1024) });

    expect(res.status).toBe(303);
    expect(params.get('share')).toBe('');
    expect(params.has('text')).toBe(false);
  });

  it('redirects rather than throwing when the body is unreadable', async () => {
    const res = await shareRouter.request(
      new Request('http://proxy.test/share', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=nope' },
        body: 'not actually multipart',
      }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/chat');
  });
});
