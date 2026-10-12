/**
 * Live dictation's pure parts, and when it gives up.
 *
 * The audio itself cannot be exercised here — jsdom has no microphone and no
 * audio graph — so the worklet and context are stubbed and what is pinned is
 * everything *around* the sound: the encoding Hermes will decode, the frame
 * order it insists on (a text header before any binary PCM), and above all
 * the fallback decision. A live path that resolved a transcript when it should
 * have handed back to the blob upload would lose a recording; one that gave up
 * when it should not would only lose a preview. These tests are about which.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockSocket, installMockSocket } from './helpers/mockSocket';
import {
  downsample,
  openLiveTranscriber,
  parseTranscriptFrame,
  resetLiveSupport,
  toS16le,
  TARGET_RATE,
} from '../src/lib/liveDictation';

describe('parseTranscriptFrame', () => {
  it('reads a partial', () => {
    expect(parseTranscriptFrame('{"type":"partial","text":"hello wor"}')).toEqual({ type: 'partial', text: 'hello wor' });
  });

  it('reads a final, tolerating extra fields', () => {
    expect(parseTranscriptFrame('{"type":"final","transcript":"hello world","provider":"local"}')).toEqual({
      type: 'final',
      transcript: 'hello world',
    });
  });

  it('reads the "no live STT" refusal as an error', () => {
    expect(parseTranscriptFrame('{"type":"error","message":"no live STT for the configured provider"}')?.type).toBe('error');
  });

  it.each([['not json'], ['null'], ['{"type":"surprise"}'], ['{"type":"partial"}'], [42]])(
    'ignores %j',
    (raw) => {
      expect(parseTranscriptFrame(raw)).toBeNull();
    },
  );
});

describe('downsample', () => {
  it('takes 48 kHz to 16 kHz, averaging each span', () => {
    const input = new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6]);
    const out = downsample(input, 48_000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.3);
    expect(out[1]).toBeCloseTo(-0.6);
  });

  it('handles a ratio that is not a whole number (44.1 kHz)', () => {
    const out = downsample(new Float32Array(441), 44_100);
    expect(out.length).toBe(160);
  });

  it('never upsamples', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downsample(input, 8_000)).toBe(input);
    expect(downsample(input, TARGET_RATE)).toBe(input);
  });
});

describe('toS16le', () => {
  it('encodes little-endian 16-bit and clamps out-of-range samples', () => {
    const view = new DataView(toS16le(new Float32Array([0, 1, -1, 2, -2])));
    expect(view.byteLength).toBe(10);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7fff);
    expect(view.getInt16(4, true)).toBe(-0x8000);
    expect(view.getInt16(6, true)).toBe(0x7fff);
    expect(view.getInt16(8, true)).toBe(-0x8000);
  });
});

/** Minimal audio graph: enough for the transcriber to wire itself up. */
let lastNode: { port: { onmessage: ((ev: { data: Float32Array }) => void) | null } } | null = null;
let restoreSocket: () => void;

function installAudioStubs(): void {
  class FakeNode {
    port = { onmessage: null as ((ev: { data: Float32Array }) => void) | null, close: () => undefined };
    constructor() {
      lastNode = this;
    }
    disconnect() {}
  }
  class FakeContext {
    sampleRate = 48_000;
    audioWorklet = { addModule: async () => undefined };
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  vi.stubGlobal('AudioContext', FakeContext);
  URL.createObjectURL = () => 'blob:worklet';
  URL.revokeObjectURL = () => undefined;
}

const stream = {} as MediaStream;
const flushAsync = () => new Promise((r) => setTimeout(r, 0));
/** Feed the transcriber `n` samples' worth of audio from the fake worklet. */
const speak = (n: number) => lastNode!.port.onmessage!({ data: new Float32Array(n).fill(0.1) });

beforeEach(() => {
  restoreSocket = installMockSocket();
  installAudioStubs();
  lastNode = null;
  resetLiveSupport();
});

afterEach(() => {
  restoreSocket();
  vi.unstubAllGlobals();
});

describe('openLiveTranscriber', () => {
  it('sends the text header before any audio, then PCM as binary', async () => {
    const live = openLiveTranscriber(stream, () => undefined);
    await flushAsync();
    // Audio captured before the socket opened is held, not dropped or sent first.
    speak(4800);
    const socket = MockSocket.last;
    expect(socket.url).toMatch(/\/api\/audio\/transcribe-stream$/);
    socket.open();

    const sent = socket.sent as unknown[];
    expect(sent[0]).toBe(JSON.stringify({ sample_rate: TARGET_RATE }));
    expect(sent[1]).toBeInstanceOf(ArrayBuffer);
    // 4800 samples at 48 kHz → 1600 at 16 kHz → 3200 bytes.
    expect((sent[1] as ArrayBuffer).byteLength).toBe(3200);
    live.cancel();
  });

  it('reports partials and resolves the final transcript on finish', async () => {
    const partials: string[] = [];
    const live = openLiveTranscriber(stream, (t) => partials.push(t));
    await flushAsync();
    const socket = MockSocket.last;
    socket.open();
    socket.deliverJson({ type: 'partial', text: 'turn the' });

    const done = live.finish();
    expect((socket.sent as unknown[]).at(-1)).toBe(JSON.stringify({ eos: true }));
    socket.deliverJson({ type: 'final', transcript: ' turn the lights off ' });

    expect(await done).toBe('turn the lights off');
    expect(partials).toEqual(['turn the']);
  });

  /* The backend's way of saying "this provider has no live mode": fall back. */
  it('falls back when the server sends an error', async () => {
    const live = openLiveTranscriber(stream, () => undefined);
    await flushAsync();
    const socket = MockSocket.last;
    socket.open();
    socket.deliverJson({ type: 'error', message: 'no live STT for the configured provider' });

    expect(await live.finish()).toBeNull();
  });

  /**
   * "No live STT" is about the backend's provider, not the recording — local
   * whisper, the usual setup, has no live mode. Asking again on every mic tap
   * spun up an AudioContext and a socket only to be told no.
   */
  it('stops asking a backend that has no live STT', async () => {
    const first = openLiveTranscriber(stream, () => undefined);
    await flushAsync();
    MockSocket.last.open();
    MockSocket.last.deliverJson({ type: 'error', message: 'no live STT for the configured provider' });
    await first.finish();
    const opened = MockSocket.instances.length;

    const second = openLiveTranscriber(stream, () => undefined);
    expect(MockSocket.instances).toHaveLength(opened);
    expect(await second.finish()).toBeNull();
  });

  it('keeps asking after an error that was about this recording', async () => {
    const first = openLiveTranscriber(stream, () => undefined);
    await flushAsync();
    MockSocket.last.open();
    MockSocket.last.deliverJson({ type: 'error', message: 'transcription failed' });
    await first.finish();
    const opened = MockSocket.instances.length;

    openLiveTranscriber(stream, () => undefined).cancel();
    expect(MockSocket.instances).toHaveLength(opened + 1);
  });

  it('falls back when the socket drops before the final', async () => {
    const live = openLiveTranscriber(stream, () => undefined);
    await flushAsync();
    const socket = MockSocket.last;
    socket.open();
    const done = live.finish();
    socket.drop();

    expect(await done).toBeNull();
  });

  /* An older proxy or Hermes refuses the upgrade: nothing ever opened. */
  it('falls back when the socket never opened', async () => {
    const live = openLiveTranscriber(stream, () => undefined);
    await flushAsync();
    expect(await live.finish()).toBeNull();
  });

  it('falls back on a browser without AudioWorklet', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    const live = openLiveTranscriber(stream, () => undefined);
    await flushAsync();
    MockSocket.last.open();
    expect(await live.finish()).toBeNull();
  });

  it('keeps a final that arrives after the server closes cleanly', async () => {
    const live = openLiveTranscriber(stream, () => undefined);
    await flushAsync();
    const socket = MockSocket.last;
    socket.open();
    const done = live.finish();
    socket.deliverJson({ type: 'final', transcript: 'ok' });
    socket.drop();

    expect(await done).toBe('ok');
  });

  it('stops reporting partials once cancelled', async () => {
    const partials: string[] = [];
    const live = openLiveTranscriber(stream, (t) => partials.push(t));
    await flushAsync();
    const socket = MockSocket.last;
    socket.open();
    live.cancel();
    socket.onmessage?.({ data: JSON.stringify({ type: 'partial', text: 'late' }) });

    expect(partials).toEqual([]);
  });
});
