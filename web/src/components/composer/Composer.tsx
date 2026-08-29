/**
 * Message composer: growing textarea, hold-to-talk voice, attachments,
 * quick-action chips, slash-command completion, and the send/stop button.
 *
 * The mic is hidden entirely when neither server STT nor the Web Speech API is
 * usable — a dead button is worse than no button. On plain HTTP (our default)
 * `MediaRecorder` is unavailable, so the Web Speech fallback is what runs.
 */
import { useEffect, useRef, useState } from 'react';
import { IconClose, IconMic, IconPaperclip, IconSend, IconStop } from '../shared/Icons';
import { CostRing } from './CostRing';
import { SlashPopover } from './SlashPopover';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';
import { completeSlash, type CompletionItem } from '../../api/commands';
import { isSlashInput, isSuggestion } from '../../lib/slashCommands';
import {
  canRecord,
  probeAudio,
  startRecording,
  webSpeechAvailable,
  webSpeechDictate,
  type Recorder,
} from '../../lib/audio';
import { hermes } from '../../ws/client';
import { formatImageRef } from '../../lib/localImages';

const QUICK_ACTIONS = [
  { label: '📋 Summarize', text: 'Summarize what we just did in a few bullets.' },
  { label: '🔍 Explain', text: 'Explain that in more detail.' },
  { label: '✅ Next steps', text: 'What are the next steps?' },
  { label: '🐛 Fix it', text: 'Fix the issue you just found.' },
];

interface Attachment {
  /**
   * Identity, because the name is not one: picking two files called
   * `screenshot.png` from different folders is ordinary, and keying on the
   * name meant the second one's completion marked the first as done.
   */
  id: string;
  name: string;
  /** Bytes, so a pill that is going to sit there for a while says why. */
  size: number;
  /** Set once the gateway has accepted the file. */
  attached: boolean;
  /**
   * Where it has got to.
   *
   * Two phases, and only the first can report progress: reading the file is
   * local and `FileReader` fires `onprogress` throughout, while the attach
   * itself is a single JSON-RPC frame over the gateway socket with no
   * progress channel and no partial state to report. Saying which of the two
   * is happening is the honest version of a progress bar — a bar that filled
   * to 40% and then stopped would be a lie about the half that takes longest.
   */
  phase: 'reading' | 'uploading';
  /** 0–1 while reading, null once there is nothing to measure. */
  progress: number | null;
  /**
   * The gateway's own `[User attached image: …]` line, sent as the prompt when
   * an image goes out with no message typed alongside it.
   */
  placeholder?: string;
  /**
   * Where the gateway wrote the image on its own disk.
   *
   * Only so the sent picture can be shown in the transcript straight away.
   * Hermes appends an `@image:<path>` ref to the persisted user message, so a
   * reloaded conversation shows it — but that row is written at the end of the
   * turn, and until then the live bubble had nothing but the caption. The
   * composer carries the same ref into the message's display text, so live and
   * reloaded are the same thing rather than two renderers to keep in step.
   */
  path?: string;
}

let attachSeq = 0;

/** `1.4 MB`. Pills are small; one decimal is as much as fits and as much as helps. */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How long the box must sit still before we ask the gateway for completions. */
const COMPLETE_DEBOUNCE_MS = 90;

interface ComposerProps {
  onOpenContext?: () => void;
  /**
   * Text to seed the box with — used by the Android share target, which hands
   * us the shared page/selection to send as the first message.
   */
  seedText?: string;
  onSeedConsumed?: () => void;
  /**
   * Files to attach without the paperclip — the share sheet's half of the same
   * intent. They run through `onPickFiles`, so a shared photo reaches the
   * gateway by exactly the path a picked one does.
   */
  seedFiles?: File[];
  onSeedFilesConsumed?: () => void;
  /** Run a slash command instead of sending it to the model. */
  onRunCommand: (text: string) => void | Promise<void>;
  /** Command currently executing, shown in place of the quick actions. */
  commandBusy?: string;
  /** A command picked from the palette that still needs its argument typed. */
  commandSeed?: string;
  onCommandSeedConsumed?: () => void;
  onOpenPalette: () => void;
}

export function Composer({
  onOpenContext,
  seedText,
  onSeedConsumed,
  seedFiles,
  onSeedFilesConsumed,
  onRunCommand,
  commandBusy,
  commandSeed,
  onCommandSeedConsumed,
  onOpenPalette,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [voiceOk, setVoiceOk] = useState(false);
  const [completions, setCompletions] = useState<CompletionItem[]>([]);
  const [replaceFrom, setReplaceFrom] = useState(1);
  const [active, setActive] = useState(0);
  /** Suppressed after accepting a completion, so the list doesn't re-open. */
  const [popoverOpen, setPopoverOpen] = useState(true);

  const running = useSession((s) => s.running);
  const sessionId = useSession((s) => s.sessionId);
  const submit = useSession((s) => s.submitPrompt);
  const interrupt = useSession((s) => s.interrupt);
  const queued = useSession((s) => s.queued);
  const clearQueued = useSession((s) => s.clearQueued);
  const toast = useUi((s) => s.toast);
  /**
   * Whether a send would reach anything. `hermes.call` rejects immediately
   * with "not connected" on a socket that is not OPEN, so a press while the
   * connection is down did not hang — it produced a bubble stamped `failed`
   * and an error banner, a second after the press, for a message that had
   * simply never left. Recoverable (the bubble carries a resend) and still the
   * wrong shape: the answer arrives after the action rather than before it.
   *
   * The textarea deliberately stays live. A drop on a phone is routine and
   * usually brief, and drafting through one is the normal thing to be doing —
   * taking the keyboard away would cost more than the failed send did.
   */
  const live = useUi((s) => s.connection) === 'open';

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<Recorder | { stop: () => Promise<string>; cancel: () => void } | null>(null);

  // Whether a mic button can do anything useful here, decided from local
  // capabilities alone. Asking the server whether STT is mounted needs a
  // request that fails by design (an empty body, so a 400 means "mounted"),
  // and doing that at mount spent one failed request and one red console
  // error on every cold start — on every phone launch, once the app moved to
  // HTTPS and recording became possible at all. The answer is only needed
  // when someone actually taps the mic, so `startVoice` asks for it there and
  // `probeAudio` caches it from then on.
  useEffect(() => {
    setVoiceOk(canRecord() || webSpeechAvailable());
  }, []);

  // Adopt shared text once, appending rather than clobbering a draft.
  useEffect(() => {
    if (!seedText) return;
    setText((t) => (t ? `${t}\n${seedText}` : seedText));
    taRef.current?.focus();
    onSeedConsumed?.();
  }, [seedText, onSeedConsumed]);

  // A palette pick lands here: replace the draft with `/cmd ` ready for its
  // argument, and don't immediately re-open the completion list over it.
  useEffect(() => {
    if (!commandSeed) return;
    setText(`${commandSeed} `);
    setPopoverOpen(false);
    taRef.current?.focus();
    onCommandSeedConsumed?.();
  }, [commandSeed, onCommandSeedConsumed]);

  // Ask the gateway to complete a partially typed command. `complete.slash`
  // does the ranking (names *and* descriptions, skills by usage); we only drop
  // commands with no phone surface so the list can't dead-end.
  useEffect(() => {
    const query = text;
    // `complete.slash` requires a leading slash at index 0, so an indented
    // draft gets no completions — it still runs fine when sent.
    if (!popoverOpen || !query.startsWith('/') || !isSlashInput(query) || query.includes('\n')) {
      setCompletions([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      completeSlash(query, sessionId ?? undefined)
        .then((res) => {
          if (!alive) return;
          setCompletions(res.items.filter((i) => isSuggestion(i.display || i.text)));
          setReplaceFrom(res.replace_from);
          setActive(0);
        })
        .catch(() => {
          // No completions is a degraded but working composer — the command
          // still runs when sent. An older gateway simply has no such method.
          if (alive) setCompletions([]);
        });
    }, COMPLETE_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [text, popoverOpen, sessionId]);

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  /**
   * An image already sits in the session's queue by the time it shows as a
   * pill, so a send with nothing typed still has something to carry — it goes
   * out under the gateway's own `[User attached image: …]` line rather than an
   * empty prompt.
   */
  const imagePlaceholders = () =>
    attachments
      .filter((a) => a.attached && a.placeholder)
      .map((a) => a.placeholder)
      .join('\n');

  const sendable = Boolean(text.trim() || imagePlaceholders());

  /**
   * `@image:` refs for the pictures going out with this message, so the bubble
   * can show them the moment it appears. Display only — the prompt itself is
   * left exactly as typed, because the gateway already holds the bytes and
   * writes these refs into history itself.
   */
  const imageRefs = () =>
    attachments
      .filter((a) => a.attached && a.path)
      .map((a) => formatImageRef(a.path!))
      .join('\n');

  const send = () => {
    const value = text.trim() || imagePlaceholders();
    if (!value || !sessionId) return;
    const refs = imageRefs();
    setText('');
    setAttachments([]);
    setCompletions([]);
    setPopoverOpen(true);
    // A leading slash is a command, not a message. The runner decides whether
    // that means a local screen, a gateway RPC, or a backend execution.
    if (isSlashInput(value)) {
      void onRunCommand(value);
      return;
    }
    buzz('tap');
    void submit(value, refs ? { display: `${value}\n${refs}` } : undefined);
  };

  /** Splice the chosen completion in at the index the gateway gave us. */
  const accept = (item: CompletionItem) => {
    const completed = `${text.slice(0, replaceFrom)}${item.text} `;
    setText(completed);
    setCompletions([]);
    setPopoverOpen(false);
    taRef.current?.focus();
  };

  const startVoice = async () => {
    if (recording) return;
    buzz('tap');
    try {
      const caps = await probeAudio();
      // Server STT is more accurate, but needs a secure context to record.
      if (!(caps.stt && caps.canRecord) && !caps.webSpeech) {
        toast('Voice input is not available on this device', 'warn');
        return;
      }
      recRef.current =
        caps.stt && canRecord() ? await startRecording() : webSpeechDictate();
      setRecording(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start recording', 'error');
    }
  };

  const finishVoice = async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setRecording(false);
    buzz('tap');
    try {
      const transcript = await rec.stop();
      if (transcript) {
        setText((t) => (t ? `${t} ${transcript}` : transcript));
        taRef.current?.focus();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Transcription failed', 'error');
    }
  };

  /**
   * Uploads that can be called off, and the readers doing the work.
   *
   * Refs rather than state because both are read from inside an async loop
   * that closed over its own render — a cancel recorded in state would not be
   * visible to the upload it was cancelling. The ids in `cancelled` are the
   * authority: every await in the loop below checks it before doing anything
   * with what it just got back.
   */
  const cancelled = useRef(new Set<string>());
  const readers = useRef(new Map<string, FileReader>());

  /**
   * Stop attaching this file.
   *
   * What "stop" can mean depends on where it got to. While reading, the
   * `FileReader` is genuinely aborted and nothing was ever sent. Once the
   * gateway call is in flight there is no cancel on the other end — it is one
   * JSON-RPC frame and Hermes will finish what it started — so the honest
   * thing is to stop waiting for it: the pill goes, no ref text is pasted into
   * the box, no placeholder joins the next send. The file may still land in
   * the session workspace, which is why this says "Removed" rather than
   * claiming the upload was undone.
   */
  const cancelAttachment = (a: Attachment) => {
    buzz('tap');
    cancelled.current.add(a.id);
    readers.current.get(a.id)?.abort();
    readers.current.delete(a.id);
    setAttachments((list) => list.filter((x) => x.id !== a.id));
  };

  const onPickFiles = async (files: FileList | File[] | null) => {
    if (!files?.length || !sessionId) return;
    for (const file of Array.from(files)) {
      const id = `att-${++attachSeq}`;
      setAttachments((a) => [
        ...a,
        { id, name: file.name, size: file.size, attached: false, phase: 'reading', progress: 0 },
      ]);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          readers.current.set(id, fr);
          // The one phase with a real measurement. A phone camera's photo is
          // several megabytes and this is not instant on an old device.
          fr.onprogress = (e) => {
            if (!e.lengthComputable) return;
            const ratio = e.loaded / e.total;
            setAttachments((a) => a.map((x) => (x.id === id ? { ...x, progress: ratio } : x)));
          };
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(new Error('read failed'));
          // `abort()` fires this rather than `onerror`; the cancelled check
          // below turns it into a quiet stop instead of an error toast.
          fr.onabort = () => reject(new Error('cancelled'));
          fr.readAsDataURL(file);
        });
        readers.current.delete(id);
        if (cancelled.current.has(id)) continue;

        setAttachments((a) =>
          a.map((x) => (x.id === id ? { ...x, phase: 'uploading', progress: null } : x)),
        );

        // Images and other files take different gateway methods, and the two
        // disagree on how bytes arrive: `image.attach_bytes` wants bare base64
        // under `content_base64`, `file.attach` wants the whole data: URL.
        let placeholder: string | undefined;
        let attachedPath: string | undefined;
        if (file.type.startsWith('image/')) {
          const res = await hermes.call<{ text?: string; path?: string }>('image.attach_bytes', {
            session_id: sessionId,
            content_base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
            filename: file.name,
          });
          if (cancelled.current.has(id)) continue;
          placeholder = res?.text || `[User attached image: ${file.name}]`;
          attachedPath = res?.path;
        } else {
          // Non-images aren't queued as vision tiles — they land in the session
          // workspace and come back as an `@file:` ref the agent's file tools
          // can read, so it has to go into the prompt text.
          const res = await hermes.call<{ ref_text?: string }>('file.attach', {
            session_id: sessionId,
            name: file.name,
            data_url: dataUrl,
          });
          // Checked before the paste, not after: a ref dropped into the box
          // after the pill was cancelled is the one piece of this that the
          // user would have to undo by hand.
          if (cancelled.current.has(id)) continue;
          if (res?.ref_text) {
            setText((t) => (t ? `${t} ${res.ref_text}` : `${res.ref_text} `));
          }
        }
        setAttachments((a) =>
          a.map((x) =>
            x.id === id ? { ...x, attached: true, progress: null, placeholder, path: attachedPath } : x,
          ),
        );
        buzz('tap');
      } catch (err) {
        readers.current.delete(id);
        setAttachments((a) => a.filter((x) => x.id !== id));
        if (cancelled.current.has(id)) continue; // Asked for; not a failure.
        toast(
          `Couldn't attach ${file.name}: ${err instanceof Error ? err.message : 'failed'}`,
          'error',
        );
      } finally {
        cancelled.current.delete(id);
      }
    }
  };

  /**
   * Attach what the share sheet sent, once there is a session to attach it to.
   *
   * Guarded on identity rather than on emptiness: attaching is not idempotent
   * — every run uploads the bytes again and adds a second pill — and this
   * effect can re-run for reasons that have nothing to do with new files
   * arriving (a session id landing, a StrictMode double-mount in development).
   */
  const seededRef = useRef<File[] | null>(null);
  useEffect(() => {
    if (!seedFiles?.length || !sessionId) return;
    if (seededRef.current === seedFiles) return;
    seededRef.current = seedFiles;
    void onPickFiles(seedFiles).then(() => onSeedFilesConsumed?.());
    // `onPickFiles` is redefined every render and would re-trigger this on each
    // one; the identity guard above is what actually keeps it to a single run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedFiles, sessionId, onSeedFilesConsumed]);

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="composer__attachments">
          {attachments.map((a) => (
            <span
              className={`attach-pill${a.attached ? '' : ' attach-pill--busy'}`}
              key={a.id}
            >
              <span className="attach-pill__name">{a.name}</span>
              {a.attached ? (
                <span className="attach-pill__meta">{fileSize(a.size)}</span>
              ) : (
                <>
                  <span className="attach-pill__meta">
                    {a.phase === 'reading'
                      ? a.progress
                        ? `${Math.round(a.progress * 100)}%`
                        : 'Reading…'
                      : 'Sending…'}
                  </span>
                  {/* The pill used to be a spinner and nothing else: a large
                      file over a slow link left the composer occupied with no
                      way out short of reloading. */}
                  <button
                    type="button"
                    className="attach-pill__cancel"
                    aria-label={`Cancel attaching ${a.name}`}
                    onClick={() => cancelAttachment(a)}
                  >
                    <IconClose size={13} />
                  </button>
                </>
              )}
              {/* A track under the pill, not a bar beside it — there is no room
                  beside it, and the pill is already the thing being waited on.
                  Indeterminate during the send, which has no progress to
                  report. */}
              {!a.attached && (
                <span
                  className={`attach-pill__bar${
                    a.phase === 'uploading' ? ' attach-pill__bar--indeterminate' : ''
                  }`}
                  style={
                    a.phase === 'reading'
                      ? { transform: `scaleX(${a.progress ?? 0})` }
                      : undefined
                  }
                />
              )}
            </span>
          ))}
        </div>
      )}

      {popoverOpen && (
        <SlashPopover
          items={completions}
          active={active}
          onPick={accept}
          onBrowseAll={() => {
            setCompletions([]);
            onOpenPalette();
          }}
        />
      )}

      {commandBusy && (
        <div className="composer__running">
          <span className="spin" style={{ fontSize: 'var(--type-label-sm)' }}>◌</span>
          Running {commandBusy}…
        </div>
      )}

      {queued && (
        <div className="composer__queued">
          <span className="composer__queued-label">Queued</span>
          <span className="composer__queued-text">{queued.display ?? queued.text}</span>
          {/* An interrupted turn leaves the message held rather than firing it
              at an agent the user just stopped — so offer to send it by hand. */}
          {!running && (
            <button
              className="chip"
              onClick={() => {
                const { text: t, display } = queued;
                clearQueued();
                void submit(t, display ? { display } : undefined);
              }}
            >
              Send now
            </button>
          )}
          <button className="icon-btn" onClick={clearQueued} aria-label="Discard queued message">
            <IconClose size={16} />
          </button>
        </div>
      )}

      {!text && !running && (
        <div className="composer__quick">
          <button
            className="chip"
            onClick={() => {
              buzz('tap');
              onOpenPalette();
            }}
            aria-label="Browse commands"
          >
            / Commands
          </button>
          {QUICK_ACTIONS.map((q) => (
            <button
              key={q.label}
              className="chip"
              onClick={() => {
                buzz('tap');
                setText(q.text);
                taRef.current?.focus();
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}

      <div className="composer__row">
        <CostRing onClick={onOpenContext} />

        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept="image/*,text/*,application/pdf,.md,.json,.csv,.log"
          onChange={(e) => {
            void onPickFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          className="composer__btn"
          onClick={() => {
            buzz('tap');
            fileRef.current?.click();
          }}
          aria-label="Attach a file"
          disabled={!sessionId}
        >
          <IconPaperclip size={19} />
        </button>

        <textarea
          ref={taRef}
          className="composer__input"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Any further typing means the user wants suggestions again.
            setPopoverOpen(true);
          }}
          placeholder={
            recording ? 'Listening…' : live ? 'Message Hem…' : 'Reconnecting…'
          }
          rows={1}
          // The on-screen keyboard offers a newline key rather than "send",
          // matching what Enter now does. Sending is the button beside it.
          enterKeyHint="enter"
          onKeyDown={(e) => {
            const suggesting = completions.length > 0;
            if (suggesting && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive((i) => (i + step + completions.length) % completions.length);
              return;
            }
            if (suggesting && e.key === 'Escape') {
              e.preventDefault();
              setPopoverOpen(false);
              setCompletions([]);
              return;
            }
            // Tab and Enter both complete while a suggestion is highlighted —
            // the list is the thing in front of you, and picking from it is
            // what Enter means there.
            if (suggesting && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
              const item = completions[active];
              if (item) {
                e.preventDefault();
                accept(item);
                return;
              }
            }
            // Enter is a newline, everywhere. A message to an agent is a
            // paragraph more often than it is a line, and losing one to a
            // reflex press costs more than a modifier does. Ctrl/Cmd+Enter
            // sends, as does the button — which is the only way to send on a
            // phone anyway, where the key is a return key regardless.
            if (
              e.key === 'Enter' &&
              (e.metaKey || e.ctrlKey) &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
        />

        {voiceOk && !text && (
          <button
            className={`composer__btn${recording ? ' composer__btn--rec' : ''}`}
            aria-label="Hold to talk"
            onPointerDown={(e) => {
              e.preventDefault();
              void startVoice();
            }}
            onPointerUp={() => void finishVoice()}
            onPointerLeave={() => {
              if (recording) void finishVoice();
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <IconMic size={19} />
          </button>
        )}

        {/* While a turn runs, stop stays available *and* send still works —
            sending mid-turn queues the message rather than dropping it, so
            hiding the button would hide the feature. The mic yields the space,
            since it's already hidden whenever there's text to send. */}
        {running && (
          <button
            className="composer__btn composer__btn--stop"
            onClick={() => void interrupt()}
            aria-label="Stop generating"
          >
            <IconStop size={17} />
          </button>
        )}
        {(!running || sendable) && (
          <button
            className="composer__btn composer__btn--send"
            onClick={send}
            /*
             * Gated on the socket only where the press would actually use it.
             * A send *during* a turn never touches the gateway — the gateway
             * runs one turn per session, so `submitPrompt` holds the message
             * locally and fires it when the turn ends — and that is worth
             * having offline, since a drop mid-turn is exactly when queueing
             * the next thing is useful.
             */
            disabled={!sendable || !sessionId || (!live && !running)}
            aria-label={
              running ? 'Queue this message' : live ? 'Send' : 'Waiting for the connection'
            }
          >
            <IconSend size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
