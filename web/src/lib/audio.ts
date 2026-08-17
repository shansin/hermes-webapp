/**
 * Voice input and output.
 *
 * Both Hermes audio endpoints take JSON with a base64 data URL rather than
 * multipart, so recordings are inlined:
 *   POST /api/audio/transcribe  {data_url, mime_type} -> {text}
 *   POST /api/audio/speak       {text}                -> {ok, data_url}
 *
 * Either can be unconfigured on a given install, so callers must treat both as
 * optional features — `probeAudio()` reports what is actually available.
 */
import { api } from '../api/client';

// --- capability probe --------------------------------------------------------

export interface AudioCaps {
  /** Server-side speech-to-text is configured. */
  stt: boolean;
  /** The browser can record audio at all (needs a secure context). */
  canRecord: boolean;
  /** Web Speech API fallback, used when server STT is unavailable. */
  webSpeech: boolean;
}

let cached: AudioCaps | null = null;

export function webSpeechAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  );
}

/**
 * MediaRecorder + getUserMedia require a secure context. On plain HTTP over a
 * LAN IP the browser withholds them, which is exactly our default deployment —
 * hence the Web Speech fallback and the graceful hiding of the mic button.
 */
export function canRecord(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/**
 * Statuses that mean "this endpoint isn't here": not mounted, wrong verb, or
 * mounted but unimplemented. Anything else — including the rejection of the
 * deliberately-empty probe payload — means a handler ran, so the feature is
 * configured.
 *
 * Matching on the *absent* statuses rather than one specific rejection code is
 * deliberate: Hermes has returned both 400 ("Invalid audio payload") and 422
 * for the empty probe across versions, and pinning to either one silently
 * disables working voice support on the other.
 */
const ABSENT = new Set([404, 405, 501]);

function mounted(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  // A network error or a thrown non-ApiError has no status; treat the feature
  // as unavailable rather than advertising a button that cannot work.
  return typeof status === 'number' && !ABSENT.has(status);
}

/**
 * Report what voice input can do here. Cached: the answer only changes when
 * Hermes is reconfigured and restarted.
 *
 * Server STT is only reachable once the browser can hand us a recording, so on
 * the default plain-HTTP LAN deployment — where `canRecord()` is false — the
 * probe is skipped entirely rather than spending a request (and a console
 * error) on an answer that cannot change the outcome.
 *
 * There is deliberately no TTS probe: `speak()` negotiates per call, using
 * Hermes when it answers and the browser voice when it does not.
 */
export async function probeAudio(): Promise<AudioCaps> {
  if (cached) return cached;

  const record = canRecord();
  const stt = record
    ? await api
        .post('/api/audio/transcribe', { data_url: '', mime_type: 'audio/webm' })
        .then(() => true)
        .catch(mounted)
    : false;

  cached = { stt, canRecord: record, webSpeech: webSpeechAvailable() };
  return cached;
}

// --- text to speech ----------------------------------------------------------

let current: HTMLAudioElement | null = null;

export function stopSpeaking(): void {
  current?.pause();
  current = null;
  try {
    speechSynthesis?.cancel();
  } catch {
    // No synthesis engine — nothing to cancel.
  }
}

/** Speak text, preferring Hermes' TTS and falling back to the browser voice. */
export async function speak(text: string): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  stopSpeaking();

  try {
    const res = await api.post<{ ok: boolean; data_url?: string; error?: string }>(
      '/api/audio/speak',
      { text: clean.slice(0, 4000) },
    );
    if (res.ok && res.data_url) {
      const audio = new Audio(res.data_url);
      current = audio;
      await audio.play();
      return;
    }
  } catch {
    // Fall through to the browser's own synthesizer.
  }

  if (typeof speechSynthesis !== 'undefined') {
    const utter = new SpeechSynthesisUtterance(clean.slice(0, 4000));
    speechSynthesis.speak(utter);
    return;
  }

  throw new Error('Text-to-speech is not available');
}

// --- speech to text ----------------------------------------------------------

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('Could not read the recording'));
    fr.readAsDataURL(blob);
  });
}

export interface Recorder {
  stop: () => Promise<string>;
  cancel: () => void;
}

/**
 * Start recording and return a handle whose `stop()` resolves to a transcript.
 * The caller owns the lifetime — hold-to-talk calls `stop`, a drag-away
 * gesture calls `cancel`.
 */
export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // Let the browser choose; Chrome yields webm/opus, Safari mp4.
  const mime = MediaRecorder.isTypeSupported('audio/webm')
    ? 'audio/webm'
    : MediaRecorder.isTypeSupported('audio/mp4')
      ? 'audio/mp4'
      : '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.start();

  const release = () => stream.getTracks().forEach((t) => t.stop());

  return {
    cancel() {
      try {
        rec.stop();
      } catch {
        // Already stopped.
      }
      release();
    },
    stop() {
      return new Promise<string>((resolve, reject) => {
        rec.onstop = async () => {
          release();
          try {
            const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
            if (blob.size < 1200) {
              resolve(''); // Too short to be speech — treat as a cancelled tap.
              return;
            }
            const dataUrl = await blobToDataUrl(blob);
            const res = await api.post<{ text?: string; transcript?: string }>(
              '/api/audio/transcribe',
              { data_url: dataUrl, mime_type: rec.mimeType || 'audio/webm' },
            );
            resolve((res.text ?? res.transcript ?? '').trim());
          } catch (err) {
            reject(err instanceof Error ? err : new Error('Transcription failed'));
          }
        };
        try {
          rec.stop();
        } catch (err) {
          reject(err instanceof Error ? err : new Error('Recorder failed'));
        }
      });
    },
  };
}

/**
 * Browser-native dictation, used when the server has no STT or the page isn't
 * a secure context. Resolves with the final transcript.
 */
export function webSpeechDictate(): { stop: () => Promise<string>; cancel: () => void } {
  const Ctor =
    (window as unknown as { SpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition })
      .webkitSpeechRecognition;

  if (!Ctor) throw new Error('Dictation is not supported in this browser');

  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';

  let text = '';
  rec.onresult = (e: SpeechRecognitionEvent) => {
    let out = '';
    for (let i = 0; i < e.results.length; i++) {
      out += e.results[i]?.[0]?.transcript ?? '';
    }
    text = out;
  };
  rec.start();

  return {
    cancel() {
      try {
        rec.abort();
      } catch {
        // Already stopped.
      }
    },
    stop() {
      return new Promise<string>((resolve) => {
        rec.onend = () => resolve(text.trim());
        try {
          rec.stop();
        } catch {
          resolve(text.trim());
        }
      });
    },
  };
}
