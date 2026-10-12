/**
 * Live dictation: the transcript appears while you are still talking.
 *
 * Hermes 0.21.6 added `WS /api/audio/transcribe-stream` — microphone PCM in,
 * `{type:"partial"}` text out as speech is recognised, one `{type:"final"}`
 * after `{eos:true}`. Before it, voice input was a blind wait: hold the
 * button, talk, release, and only then find out whether anything was heard.
 *
 * It is strictly an *addition* to the recorded-blob path in `audio.ts`, never
 * a replacement. The MediaRecorder keeps recording alongside this the whole
 * time, and anything short of a clean `final` — no live STT for the configured
 * provider (the backend says so with `type:"error"` and closes), an older
 * Hermes or proxy that refuses the upgrade, a socket that drops mid-sentence,
 * a browser without AudioWorklet — resolves `finish()` to `null`, and the
 * caller uploads the blob exactly as it did before this existed. So a failure
 * here costs a missing preview, never a lost recording.
 *
 * Three details are load-bearing:
 *
 *  - **16 kHz, resampled here.** The endpoint takes 8–48 kHz and resamples
 *    itself, but a phone's mic runs at 44.1 or 48 kHz and every sample of
 *    that crosses the phone's uplink; speech recognisers want 16 kHz anyway.
 *    A third of the bytes for the same transcript.
 *  - **The header goes first and as text.** Hermes reads the first frame with
 *    `receive_text()`; the PCM that follows is binary. (The proxy used to
 *    replay frames held before its upstream leg opened as binary, which broke
 *    exactly this — see `wsProxy.ts`.)
 *  - **Lazy.** This module and its worklet load on the first tap of the mic,
 *    not with the composer, which sits in the eager bundle.
 */

/** What the endpoint can send. Anything else is ignored rather than trusted. */
export type TranscriptFrame =
  | { type: 'partial'; text: string }
  | { type: 'final'; transcript: string }
  | { type: 'error'; message: string };

export const TARGET_RATE = 16_000;

/**
 * Parse one server frame. Tolerant of unknown fields (a newer Hermes adding
 * `provider` or timing data) and of frame types this client does not know,
 * which come back `null` and are skipped.
 */
export function parseTranscriptFrame(raw: unknown): TranscriptFrame | null {
  if (typeof raw !== 'string') return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const f = data as { type?: unknown; text?: unknown; transcript?: unknown; message?: unknown };
  if (f.type === 'partial' && typeof f.text === 'string') return { type: 'partial', text: f.text };
  if (f.type === 'final') return { type: 'final', transcript: typeof f.transcript === 'string' ? f.transcript : '' };
  if (f.type === 'error') return { type: 'error', message: typeof f.message === 'string' ? f.message : 'transcription failed' };
  return null;
}

/**
 * Average `input` down to `TARGET_RATE`.
 *
 * Box-filter decimation over each output sample's source span: cheap enough
 * for the main thread at a few frames a second, and the averaging is a crude
 * low-pass that keeps a 48 kHz mic's high band from aliasing into the speech
 * band the way picking every third sample would. A source already at or below
 * the target is returned as-is — upsampling would only add bytes.
 */
export function downsample(input: Float32Array, inputRate: number, outputRate = TARGET_RATE): Float32Array {
  if (inputRate <= outputRate || input.length === 0) return input;
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Float samples in [-1, 1] → signed 16-bit little-endian PCM. */
export function toS16le(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/**
 * The worklet: copy each 128-sample render quantum out to the main thread.
 *
 * Inline and loaded from a Blob URL so there is no extra file for the service
 * worker's precache to carry or for Vite to hash. Batching happens on the main
 * thread, where the downsampling is.
 */
const WORKLET_SOURCE = `
class HemPcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('hem-pcm-tap', HemPcmTap);
`;

/** Roughly 100 ms of audio per frame sent: few frames, low latency. */
const SEND_EVERY_SAMPLES = TARGET_RATE / 10;
/** How long `finish()` waits for the final transcript before giving up on it. */
const FINAL_TIMEOUT_MS = 20_000;

export interface LiveTranscriber {
  /** Send end-of-stream and wait for the final transcript; `null` means fall back. */
  finish: () => Promise<string | null>;
  /** Drop the stream without a transcript — closing without `eos` cancels server-side. */
  cancel: () => void;
}

/**
 * When the backend last said it has no live STT at all.
 *
 * That answer is about the backend's configured provider, not this recording
 * — a local whisper model, the common case, has no live mode — so asking again
 * on every mic tap spun up an AudioContext and a socket only to be told no.
 * Remembered for a while rather than for good, so a provider switched to one
 * with a live mode is picked up without a reload.
 */
let unsupportedAt = 0;
const UNSUPPORTED_TTL_MS = 10 * 60_000;

/** Test seam. */
export function resetLiveSupport(): void {
  unsupportedAt = 0;
}

function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/audio/transcribe-stream`;
}

/**
 * Start streaming `stream`'s audio. Never throws: anything that goes wrong,
 * now or later, makes `finish()` resolve to `null`.
 */
export function openLiveTranscriber(
  stream: MediaStream,
  onPartial: (text: string) => void,
): LiveTranscriber {
  if (unsupportedAt && Date.now() - unsupportedAt < UNSUPPORTED_TTL_MS) {
    return { finish: () => Promise.resolve(null), cancel: () => undefined };
  }

  let failed = false;
  let finalText: string | null = null;
  let settleFinal: ((v: string | null) => void) | null = null;
  const finalPromise = new Promise<string | null>((resolve) => {
    settleFinal = resolve;
  });
  const settle = (v: string | null) => {
    settleFinal?.(v);
    settleFinal = null;
  };

  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let ws: WebSocket | null = null;
  let workletUrl: string | null = null;
  let pendingSamples: Float32Array[] = [];
  let pendingCount = 0;

  const fail = () => {
    if (failed) return;
    failed = true;
    teardownAudio();
    try {
      ws?.close();
    } catch {
      // Already gone.
    }
    settle(null);
  };

  const teardownAudio = () => {
    try {
      source?.disconnect();
      node?.disconnect();
      node?.port.close();
    } catch {
      // Nothing to disconnect.
    }
    void ctx?.close().catch(() => undefined);
    ctx = null;
    if (workletUrl) URL.revokeObjectURL(workletUrl);
    workletUrl = null;
  };

  const flush = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || pendingCount === 0) return;
    const joined = new Float32Array(pendingCount);
    let offset = 0;
    for (const part of pendingSamples) {
      joined.set(part, offset);
      offset += part.length;
    }
    pendingSamples = [];
    pendingCount = 0;
    ws.send(toS16le(joined));
  };

  try {
    ws = new WebSocket(socketUrl());
    ws.binaryType = 'arraybuffer';
  } catch {
    fail();
    return { finish: () => finalPromise, cancel: () => undefined };
  }

  ws.onopen = () => {
    ws?.send(JSON.stringify({ sample_rate: TARGET_RATE }));
    flush();
  };
  ws.onmessage = (ev) => {
    const frame = parseTranscriptFrame(ev.data);
    if (!frame) return;
    if (frame.type === 'partial') {
      if (!failed) onPartial(frame.text);
    } else if (frame.type === 'final') {
      finalText = frame.transcript;
      settle(frame.transcript.trim());
    } else {
      // Includes "no live STT for the configured provider": the blob path is
      // the answer, so this is not an error worth showing anyone.
      if (/no live stt/i.test(frame.message ?? '')) unsupportedAt = Date.now();
      fail();
    }
  };
  // A close before the final transcript arrived is a failure; after it, the
  // normal end of the exchange.
  ws.onclose = () => {
    if (finalText === null) fail();
  };
  ws.onerror = () => fail();

  void (async () => {
    try {
      if (typeof AudioWorkletNode === 'undefined') throw new Error('no AudioWorklet');
      ctx = new AudioContext();
      workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(workletUrl);
      if (failed || !ctx) return;
      const rate = ctx.sampleRate;
      source = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'hem-pcm-tap');
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        if (failed) return;
        const chunk = downsample(ev.data, rate);
        pendingSamples.push(chunk);
        pendingCount += chunk.length;
        if (pendingCount >= SEND_EVERY_SAMPLES) flush();
      };
      // Connected to the graph's input only. Routing it to the destination
      // would play the user's own voice back at them.
      source.connect(node);
    } catch {
      fail();
    }
  })();

  return {
    finish() {
      if (failed) return Promise.resolve(null);
      teardownAudio();
      // `onopen` has not fired yet: the header and audio are still to go, so
      // there is nothing the server could transcribe. Give up on live.
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        fail();
        return finalPromise;
      }
      flush();
      ws.send(JSON.stringify({ eos: true }));
      const timer = setTimeout(fail, FINAL_TIMEOUT_MS);
      return finalPromise.finally(() => clearTimeout(timer));
    },
    cancel() {
      failed = true;
      teardownAudio();
      try {
        ws?.close();
      } catch {
        // Already gone.
      }
      settle(null);
    },
  };
}
