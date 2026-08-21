/**
 * `public/share-sw.js`, evaluated in a fake worker global.
 *
 * Like `push-sw.js` this file gets no type checking and no bundling, and it
 * runs somewhere nobody can open a console on it. It is also the only thing
 * standing between a POST from the Android share sheet and a browser error
 * page: if `respondWith` rejects, the person who picked this app out of the
 * share sheet gets a network error instead of a chat.
 *
 * The behaviour worth pinning down is the filing and the claiming — that a
 * share is stored under an id, handed over once, and then gone. Handing it
 * over twice would attach the same photo to a second turn; never deleting it
 * would leave megabytes in Cache Storage forever.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../public/share-sw.js'), 'utf8');

interface ClaimReply {
  ok: boolean;
  text?: string;
  files?: { name: string; type: string; blob: Blob }[];
}

interface Worker {
  listeners: Map<string, (event: unknown) => void>;
  /** Everything currently filed, by synthetic URL. */
  stored(): Promise<string[]>;
  /** Run the share-sheet POST and return where it redirected to. */
  share(form: FormData): Promise<{ status: number; location: string }>;
  /** Ask for a filed share the way the page does. */
  claim(id: string): Promise<ClaimReply | null>;
}

/**
 * A Cache Storage stand-in.
 *
 * Real enough to matter: it keeps whole `Response` objects keyed by request
 * URL, because that is the property the worker relies on to move a Blob from
 * a multipart body to the page without ever decoding it.
 */
function fakeCaches() {
  const store = new Map<string, Map<string, FakeResponse>>();
  return {
    store,
    async open(name: string) {
      if (!store.has(name)) store.set(name, new Map());
      const cache = store.get(name)!;
      const absolute = (req: string | { url: string }) =>
        new URL(typeof req === 'string' ? req : req.url, 'https://host.ts.net').toString();
      return {
        async put(req: string, res: FakeResponse) {
          cache.set(absolute(req), res);
        },
        async match(req: string | { url: string }) {
          const hit = cache.get(absolute(req));
          return hit ? hit.clone() : undefined;
        },
        async keys() {
          return [...cache.keys()].map((url) => ({ url }));
        },
        async delete(req: string | { url: string }) {
          return cache.delete(absolute(req));
        },
      };
    },
  };
}

/**
 * A `Response` stand-in that keeps its body as the object it was given.
 *
 * The real one would too — putting a `File` in and getting a `Blob` out is the
 * whole reason the worker stores parts this way, with no decode step. But
 * under jsdom the global `Response` comes from undici while `File` comes from
 * jsdom, and undici does not recognise it: the file lands in the body as the
 * string "[object File]". Passing the platform's own `Response` here would
 * therefore test the mismatch rather than the worker.
 */
class FakeResponse {
  constructor(
    readonly body: unknown,
    readonly init: { headers?: Record<string, string> } = {},
  ) {}

  clone() {
    return new FakeResponse(this.body, this.init);
  }

  async json() {
    return JSON.parse(String(this.body));
  }

  async blob() {
    return this.body instanceof Blob ? this.body : new Blob([String(this.body)]);
  }

  static redirect(url: string, status: number) {
    return {
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? url : null) },
    };
  }
}

function loadWorker(): Worker {
  const listeners = new Map<string, (event: unknown) => void>();
  const caches = fakeCaches();

  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'caches', 'Response', 'URL', 'JSON', 'Date', 'Promise', source)(
    self,
    caches,
    FakeResponse,
    URL,
    JSON,
    Date,
    Promise,
  );

  const waited: unknown[] = [];
  async function dispatch(type: string, event: Record<string, unknown>) {
    const fn = listeners.get(type);
    if (!fn) throw new Error(`no ${type} listener registered`);
    fn({ waitUntil: (p: unknown) => waited.push(p), ...event });
    await Promise.all(waited.splice(0));
  }

  return {
    listeners,
    async stored() {
      const cache = [...caches.store.values()][0];
      return cache ? [...cache.keys()].map((u) => new URL(u).pathname).sort() : [];
    },
    async share(form: FormData) {
      let responded: Promise<Response> | Response | null = null;
      await dispatch('fetch', {
        request: shareRequest(form),
        respondWith: (r: Promise<Response> | Response) => {
          responded = r;
        },
      });
      if (!responded) throw new Error('the worker did not answer the POST');
      const res = (await responded) as unknown as {
        status: number;
        headers: { get(name: string): string | null };
      };
      return { status: res.status, location: res.headers.get('location') ?? '' };
    },
    async claim(id: string) {
      let reply: ClaimReply | null = null;
      const port = { postMessage: (m: ClaimReply) => (reply = m) };
      await dispatch('message', {
        data: { source: 'hermes-share-claim', id },
        ports: [port],
      });
      return reply;
    },
  };
}

/**
 * The POST as the worker sees it.
 *
 * Deliberately a stub rather than a real `Request`: under jsdom the global
 * `FormData` and the global `Request` come from different implementations and
 * do not agree on multipart encoding, so a real one arrives with the body
 * unreadable. None of that is what these tests are about — the worker only
 * ever asks a request for its method, its URL, and its form.
 */
function shareRequest(form: FormData) {
  return {
    method: 'POST',
    url: 'https://host.ts.net/share',
    formData: async () => form,
  };
}

/**
 * Read a blob the way the composer does. jsdom's `Blob` implements neither
 * `arrayBuffer()` nor `text()`, and `FileReader` is what `onPickFiles` reaches
 * for anyway — so this is both the available route and the honest one.
 */
function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
    fr.onerror = () => reject(new Error('read failed'));
    fr.readAsArrayBuffer(blob);
  });
}

/** A photo, as the share sheet would hand one over. */
const photo = (name = 'IMG_0042.jpg') =>
  new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type: 'image/jpeg' });

const shareIdFrom = (location: string) =>
  new URL(location, 'https://host.ts.net').searchParams.get('share') ?? '';

let worker: Worker;

beforeEach(() => {
  worker = loadWorker();
});

describe('registration', () => {
  it('registers only the two listeners the feature needs', () => {
    expect([...worker.listeners.keys()].sort()).toEqual(['fetch', 'message']);
  });
});

describe('receiving a share', () => {
  it('redirects a POST into a GET the app can route', async () => {
    const form = new FormData();
    form.set('files', photo());

    const { status, location } = await worker.share(form);

    // 303 specifically: a 302 would have the browser repeat the POST.
    expect(status).toBe(303);
    expect(location).toContain('/chat');
    expect(location).toContain('new=1');
    expect(shareIdFrom(location)).toBeTruthy();
  });

  it('hands back the file it was given, bytes intact', async () => {
    const form = new FormData();
    form.set('files', photo());

    const { location } = await worker.share(form);
    const claimed = await worker.claim(shareIdFrom(location));

    expect(claimed?.ok).toBe(true);
    expect(claimed?.files).toHaveLength(1);
    expect(claimed!.files![0]!.name).toBe('IMG_0042.jpg');
    expect(claimed!.files![0]!.type).toBe('image/jpeg');
    expect(await readBytes(claimed!.files![0]!.blob)).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    );
  });

  it('keeps several files, which is what the share sheet sends', async () => {
    const form = new FormData();
    form.append('files', photo('one.jpg'));
    form.append('files', photo('two.jpg'));

    const { location } = await worker.share(form);
    const claimed = await worker.claim(shareIdFrom(location));

    expect(claimed?.files?.map((f) => f.name)).toEqual(['one.jpg', 'two.jpg']);
  });

  /**
   * The composer keys its pills on the name and the gateway puts it in the
   * `[User attached image: …]` line the agent reads, so an unnamed file must
   * still come out with something rather than `undefined`.
   */
  it('names a file that arrived without one', async () => {
    const form = new FormData();
    form.set('files', new File([new Uint8Array([1])], '', { type: 'image/png' }));

    const { location } = await worker.share(form);
    const claimed = await worker.claim(shareIdFrom(location));

    expect(claimed!.files![0]!.name).toBeTruthy();
  });

  it('joins the text fields, skipping the ones the sheet left out', async () => {
    const form = new FormData();
    form.set('title', 'A page');
    form.set('url', 'https://example.com');
    form.set('text', '   ');

    const { location } = await worker.share(form);
    const claimed = await worker.claim(shareIdFrom(location));

    expect(claimed?.text).toBe('A page\nhttps://example.com');
  });
});

describe('claiming', () => {
  /**
   * The reason the delete lives in the worker rather than the page: a share
   * handed over twice attaches the same photo to a second turn, and reloading
   * `?share=<id>` is one back gesture away.
   */
  it('gives a share up exactly once', async () => {
    const form = new FormData();
    form.set('files', photo());

    const { location } = await worker.share(form);
    const id = shareIdFrom(location);

    expect((await worker.claim(id))?.ok).toBe(true);
    expect((await worker.claim(id))?.ok).toBe(false);
  });

  it('leaves nothing behind after a claim', async () => {
    const form = new FormData();
    form.set('files', photo());
    form.set('text', 'hello');

    const { location } = await worker.share(form);
    expect((await worker.stored()).length).toBeGreaterThan(0);

    await worker.claim(shareIdFrom(location));
    expect(await worker.stored()).toEqual([]);
  });

  it('reports an id it never filed rather than hanging', async () => {
    expect((await worker.claim('nope'))?.ok).toBe(false);
  });
});

describe('what it leaves alone', () => {
  /**
   * The listener runs ahead of every Workbox route, so anything it answers by
   * mistake is a page or an API call that stops being cached — or stops
   * working. It must claim the share POST and nothing else.
   */
  const untouched = [
    { method: 'GET', url: 'https://host.ts.net/share' },
    { method: 'POST', url: 'https://host.ts.net/api/ws' },
    { method: 'GET', url: 'https://host.ts.net/chat' },
    { method: 'POST', url: 'https://host.ts.net/push/subscribe' },
  ];

  for (const { method, url } of untouched) {
    it(`does not answer ${method} ${new URL(url).pathname}`, async () => {
      const fn = worker.listeners.get('fetch')!;
      let answered = false;
      fn({
        request: { method, url, formData: async () => new FormData() },
        respondWith: () => {
          answered = true;
        },
        waitUntil: () => {},
      });
      expect(answered).toBe(false);
    });
  }
});
