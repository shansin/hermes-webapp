/**
 * Claiming a share from the service worker.
 *
 * The interesting cases here are all failures, because the successful one is
 * two `postMessage`s and the failures are what a person actually hits: a
 * reload of an already-consumed `?share=`, an app opened in a tab that no
 * worker controls, a worker swapped out mid-flight. Every one of them has to
 * end in "no share" rather than a promise that never settles — the chat screen
 * waits on this before it will say anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { takeShared } from '../src/lib/sharedIntake';

type Reply = { ok: boolean; text?: string; files?: { name: string; type: string; blob: Blob }[] };

/**
 * Stand in for the worker on the other end of the MessagePort.
 *
 * `answer` returning null models a worker that receives the claim and never
 * replies, which is the failure the timeout exists for.
 */
function withController(answer: (id: string) => Reply | null) {
  const postMessage = vi.fn((message: { id: string }, transfer: MessagePort[]) => {
    const reply = answer(message.id);
    if (reply === null) return;
    // Asynchronous, as a real port is: a synchronous reply would hide an
    // ordering bug in code that closes the port around the await.
    setTimeout(() => transfer[0]!.postMessage(reply), 0);
  });

  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { controller: { postMessage } },
  });
  return postMessage;
}

function withoutController() {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { controller: null },
  });
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('takeShared', () => {
  it('turns the worker’s blobs into files the composer can attach', async () => {
    withController(() => ({
      ok: true,
      text: 'A page',
      files: [{ name: 'photo.jpg', type: 'image/jpeg', blob: new Blob(['bytes']) }],
    }));

    const payload = await takeShared('abc');

    expect(payload?.text).toBe('A page');
    expect(payload?.files).toHaveLength(1);
    // A File, not a Blob: the composer keys its pills on `name`, and the
    // gateway puts the filename in the line the agent reads.
    expect(payload!.files[0]).toBeInstanceOf(File);
    expect(payload!.files[0]!.name).toBe('photo.jpg');
    expect(payload!.files[0]!.type).toBe('image/jpeg');
  });

  it('asks for the id it was given', async () => {
    const postMessage = withController(() => ({ ok: true, text: 'x', files: [] }));

    await takeShared('the-id');

    expect(postMessage.mock.calls[0]![0]).toMatchObject({ id: 'the-id' });
  });

  /** A reload of a consumed `?share=` — an ordinary outcome, not an error. */
  it('reports nothing for a share the worker has already given up', async () => {
    withController(() => ({ ok: false }));
    expect(await takeShared('spent')).toBeNull();
  });

  it('reports nothing for an empty id, without troubling the worker', async () => {
    const postMessage = withController(() => ({ ok: true, text: 'x' }));

    expect(await takeShared('')).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });

  /**
   * The app open in a plain tab, or on http where no worker registers at all.
   * There is no share to claim, and nothing to wait for.
   */
  it('reports nothing when no worker controls the page', async () => {
    withoutController();
    expect(await takeShared('abc')).toBeNull();
  });

  /**
   * The failure that would otherwise be permanent. Without the timeout the
   * chat screen sits on a promise that never settles, showing an empty chat
   * and never explaining why.
   */
  it('gives up rather than waiting forever on a worker that never answers', async () => {
    vi.useFakeTimers();
    withController(() => null);

    const pending = takeShared('abc');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toBeNull();
  });

  it('treats a share with neither text nor files as nothing at all', async () => {
    withController(() => ({ ok: true, text: '', files: [] }));
    expect(await takeShared('abc')).toBeNull();
  });
});
