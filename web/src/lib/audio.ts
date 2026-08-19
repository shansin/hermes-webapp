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

/**
 * Web Speech dictation is usable here.
 *
 * The constructor is present on insecure origins but `start()` immediately
 * fails with `not-allowed` — so presence alone is not availability, and
 * checking only for it renders a mic button that cannot ever work. Both Chrome
 * and Safari gate SpeechRecognition on a secure context, which over plain HTTP
 * on a LAN IP we are not.
 */
export function webSpeechAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
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
/**
 * The utterance on the synthesis path, tracked for the same reason as
 * `current`: `cancel()` fires `onend` on whatever it stopped, and without an
 * identity check that late event would clear the state belonging to the clip
 * that replaced it.
 */
let currentUtter: SpeechSynthesisUtterance | null = null;

type SpeakListener = (speaking: boolean) => void;
const speakListeners = new Set<SpeakListener>();
let speaking = false;

function setSpeaking(next: boolean): void {
  if (speaking === next) return;
  speaking = next;
  for (const l of speakListeners) l(next);
}

/** Whether anything is being read aloud right now. */
export function isSpeaking(): boolean {
  return speaking;
}

/**
 * Subscribe to playback starting and stopping.
 *
 * Playback ends on its own — the clip runs out — so a button that offers to
 * stop it needs telling, or it sits there offering to stop silence. Returns an
 * unsubscribe.
 */
export function onSpeakingChange(cb: SpeakListener): () => void {
  speakListeners.add(cb);
  return () => {
    speakListeners.delete(cb);
  };
}

export function stopSpeaking(): void {
  current?.pause();
  current = null;
  currentUtter = null;
  try {
    speechSynthesis?.cancel();
  } catch {
    // No synthesis engine — nothing to cancel.
  }
  setSpeaking(false);
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
      // Only the clip that is still current may report itself finished.
      const done = () => {
        if (current !== audio) return;
        current = null;
        setSpeaking(false);
      };
      audio.addEventListener('ended', done);
      audio.addEventListener('error', done);
      await audio.play();
      // `play()` can resolve after something else already took over — a second
      // tap while this clip was still loading. Reporting playback then would
      // leave the state describing audio that has already been stopped.
      if (current !== audio) {
        audio.pause();
        return;
      }
      setSpeaking(true);
      return;
    }
  } catch {
    // Fall through to the browser's own synthesizer.
  }

  if (typeof speechSynthesis !== 'undefined') {
    const utter = new SpeechSynthesisUtterance(clean.slice(0, 4000));
    currentUtter = utter;
    const done = () => {
      if (currentUtter !== utter) return;
      currentUtter = null;
      setSpeaking(false);
    };
    utter.onend = done;
    utter.onerror = done;
    speechSynthesis.speak(utter);
    setSpeaking(true);
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

/** Readable causes for the `SpeechRecognitionErrorEvent.error` codes we can hit. */
const DICTATION_ERRORS: Record<string, string> = {
  'not-allowed': 'Dictation was blocked. Over plain HTTP the browser refuses it — serve the app over HTTPS (see the README).',
  'service-not-allowed': 'The browser blocked its dictation service. Allow microphone access and try again.',
  'audio-capture': 'No microphone was available.',
  network: 'Dictation needs a network connection to the browser’s speech service.',
  'no-speech': 'Nothing was heard — try again.',
  aborted: 'Dictation was cancelled.',
};

/**
 * Browser-native dictation, used when the server has no STT. Resolves with the
 * final transcript, or rejects with why the engine refused.
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

  // Without this the engine fails silently: the button sits in its recording
  // state, the user talks, and release yields an empty transcript with no
  // explanation. Hold the error so `stop()` can report it instead.
  let failure: string | null = null;
  rec.onerror = (e: SpeechRecognitionErrorEvent) => {
    failure = DICTATION_ERRORS[e.error] ?? `Dictation failed (${e.error})`;
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
      return new Promise<string>((resolve, reject) => {
        const done = () => (failure ? reject(new Error(failure)) : resolve(text.trim()));
        rec.onend = done;
        try {
          rec.stop();
        } catch {
          done();
        }
      });
    },
  };
}
