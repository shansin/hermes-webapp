/**
 * The flagship screen: live streaming conversation with the agent.
 *
 * Session lifecycle:
 *  - `?resume=<storedId>` reopens a stored conversation and replays history
 *  - `?session=<id>` is the same intent under the name every *notification*
 *    uses — see the note on `resumeId` below
 *  - `?new=1` (or no session yet) creates a fresh one
 *  - `?share=<id>` claims a payload the share-target service worker filed for
 *    us — see `lib/sharedIntake.ts`
 *  - the gateway session handle is kept in the store; it is *not* the same as
 *    the stored session id used by the REST endpoints
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MessageList } from '../components/chat/MessageList';
import { Composer } from '../components/composer/Composer';
import { CommandPalette } from '../components/composer/CommandPalette';
import { ModelSheet } from '../components/chat/ModelSheet';
import { ContextSheet } from '../components/chat/ContextSheet';
import { SessionActionsSheet } from '../components/sessions/SessionActionsSheet';
import { IconPlus, IconChevron, IconSearch, IconClose } from '../components/shared/Icons';
import { Empty, Loader } from '../components/shared/misc';
import { useSession } from '../store/session';
import { MenuButton } from '../components/shared/MenuButton';
import { useUi } from '../store/ui';
import { hermes } from '../ws/client';
import { createSession, fetchHistory, resumeSession } from '../api/gateway';
import { fetchSessionTitle, fetchStoredMessages, useSessionRow } from '../api/sessions';
import { useSlashRunner } from '../lib/useSlashRunner';
import { takeShared } from '../lib/sharedIntake';
import { useActivity } from '../lib/useActivity';
import { buzz } from '../lib/haptics';

export function ChatScreen() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  /**
   * Sessions only. A count in the chat header must not make the busiest screen
   * in the app poll the kanban board and the cron list — and a running
   * delegation, which is what this is for, is a session either way.
   */
  const { running: activityRunning } = useActivity(false);
  const [modelSheet, setModelSheet] = useState(false);
  const [contextSheet, setContextSheet] = useState(false);
  const [palette, setPalette] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [commandSeed, setCommandSeed] = useState('');
  const [booting, setBooting] = useState(false);
  /**
   * Transcript read from the REST cache because the socket is down. The
   * conversation is visible but frozen — the composer already refuses to send
   * without a gateway session, and the banner says why.
   */
  const [offlineView, setOfflineView] = useState(false);
  /**
   * Browser connectivity, which leads `connection` — a WebSocket can read OPEN
   * for a long while after the radio drops, and the screen should not wait for
   * a timeout to admit what the browser already knows.
   */
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);


  const sessionId = useSession((s) => s.sessionId);
  const storedSessionId = useSession((s) => s.storedSessionId);
  const title = useSession((s) => s.title);
  const info = useSession((s) => s.info);
  const error = useSession((s) => s.error);
  const reset = useSession((s) => s.reset);
  const adopt = useSession((s) => s.adoptSession);
  const loadHistory = useSession((s) => s.loadHistory);
  const restoreClarifyAnswers = useSession((s) => s.restoreClarifyAnswers);
  const applyResync = useSession((s) => s.applyResync);
  const setTitle = useSession((s) => s.setTitle);
  const refreshUsage = useSession((s) => s.refreshUsage);

  const connection = useUi((s) => s.connection);
  const toast = useUi((s) => s.toast);

  /** A socket that is actually usable, as opposed to one that merely says so. */
  const live = online && connection === 'open';

  // Guards against double-boot in StrictMode and against a reconnect
  // re-running session setup for a session we already hold.
  const bootingRef = useRef(false);

  /**
   * `session=` is an alias for `resume=`, and it is not optional.
   *
   * Every notification the proxy sends points here under that name: the push
   * payloads built in `server/src/push/events.ts` use `/chat?session=<id>`,
   * and so does every row of the cron feed (`server/src/push/cron.ts`). Only
   * `resume` was ever read, so tapping any of them opened the chat screen and
   * ignored which conversation it was about — landing the user in whatever
   * happened to be open, or in a brand new session. For an approval banner
   * that is precisely backwards: the turn waiting to be unblocked is the one
   * conversation you cannot reach.
   *
   * Aliasing here rather than renaming the parameter server-side keeps every
   * banner already sitting on a lock screen working.
   */
  const resumeId = params.get('resume') ?? params.get('session');
  /**
   * Which profile's store holds `resumeId`.
   *
   * Sessions are per-profile, so a link from the Sessions screen (or from a
   * kanban card) to a session belonging to another profile carries the profile
   * with it. Absent means the gateway's own launch profile, which is every
   * link written before this existed.
   */
  const resumeProfile = params.get('profile');

  /**
   * The stored row behind this conversation, fetched only once the actions
   * sheet is asked for — an ordinary chat should not pay a request for a sheet
   * nobody opened.
   *
   * Below `resumeProfile` because it needs it: the row lives in the profile
   * the link named, and asking the active profile for another one's session
   * answers 404.
   */
  const actionsRow = useSessionRow(actionsOpen ? storedSessionId : null, resumeProfile);
  const wantNew = params.get('new') === '1';
  /**
   * Android share-sheet target, which reaches us in two shapes.
   *
   * The share itself is a POST — the only kind that can carry files — so it
   * never lands here directly. `share-sw.js` receives it in the service worker
   * and redirects to `?share=<id>`, pointing at bytes filed in Cache Storage.
   * The `?title=&text=&url=` form is what the *server* fallback produces when
   * no worker was there to catch the POST: the text survives, the files don't.
   */
  const shared = [params.get('title'), params.get('text'), params.get('url')]
    .filter(Boolean)
    .join('\n');
  const shareId = params.get('share') ?? '';

  const startNew = async () => {
    if (bootingRef.current) return;
    bootingRef.current = true;
    setBooting(true);
    reset();
    try {
      const res = await createSession();
      adopt({
        sessionId: res.session_id,
        storedSessionId: res.stored_session_id,
        info: res.info,
      });
      void refreshUsage();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start a session', 'error');
    } finally {
      bootingRef.current = false;
      setBooting(false);
    }
  };

  /** Resolves true when a live session was adopted. */
  const doResume = async (storedId: string): Promise<boolean> => {
    if (bootingRef.current) return false;
    // The socket can still read OPEN for a while after the radio drops, so
    // asking it first would buy a full timeout before learning what the
    // browser already knows. The cached-transcript effect takes it from here.
    if (!navigator.onLine) return false;
    bootingRef.current = true;
    setBooting(true);
    reset();
    try {
      /**
       * Only this call decides whether the resume succeeded.
       *
       * Everything below it is decoration on a conversation that already
       * exists, and it all used to sit inside this same `try` — so a slow
       * history fetch, or a payload that failed its schema, fell into the
       * `catch` and was handled as "this session could not be opened". The
       * catch starts a *fresh* session, which is how tapping a cron
       * notification could load the right conversation and then replace it
       * with an empty one. From the outside that is indistinguishable from
       * being taken to a random session.
       *
       * `fetchHistory` is the realistic trigger: it parses strictly and
       * carries the 15s control timeout, and a cron run with a long transcript
       * on a phone's radio is exactly the shape that hits it.
       */
      const res = await resumeSession(storedId, resumeProfile);
      adopt({
        sessionId: res.session_id,
        storedSessionId: res.stored_session_id ?? storedId,
        info: res.info,
        // A question asked while we were away. Only a resume can surface it —
        // `clarify.request` already fired, at a client that wasn't listening.
        pendingClarify: res.pending_clarify,
      });

      // Past this point the conversation is open and must stay open. Each of
      // these degrades on its own rather than costing the session.
      const storedIdForRest = res.stored_session_id ?? storedId;

      try {
        loadHistory(await fetchHistory(res.session_id));

        /**
         * The gateway's history projection keeps what a tool was called with
         * but not what it returned, so a replayed clarify is a question with
         * no answer under it — the half you probably came back for. The stored
         * transcript has the results.
         *
         * Gated on actually having one, so an ordinary conversation does not
         * pay a second request for a card it will never show. Best-effort by
         * design: failing here costs the answers, not the transcript.
         */
        const needsAnswers = useSession
          .getState()
          .messages.some((m) => m.kind === 'tool' && m.name === 'clarify' && m.result === undefined);

        if (needsAnswers) {
          try {
            restoreClarifyAnswers(await fetchStoredMessages(storedIdForRest, resumeProfile));
          } catch {
            // The questions are on screen; only the answers are missing.
          }
        }
      } catch {
        // The transcript is the one thing genuinely worth reporting: the
        // conversation is live, it just has nothing on screen yet. Anything
        // streaming from here still lands, and the resync on the next
        // reconnect fills the rest in.
        toast('Opened the conversation, but its history did not load.', 'warn');
      }

      void refreshUsage();

      // Warm the offline copy. The live transcript comes over the socket, so
      // without this the REST mirror the service worker caches would never be
      // requested while online — and would therefore never be there when it
      // is the only thing that can answer.
      void fetchStoredMessages(storedIdForRest, resumeProfile).catch(() => {});

      // Restore the stored title: `session.title` only fires when the agent
      // names a conversation, so a resumed one would keep the placeholder.
      // Prefer a title the resume result already carried (schema passes
      // unknown fields through) over a second round trip.
      try {
        const carried = (res as { title?: unknown }).title;
        if (typeof carried === 'string' && carried) {
          setTitle(carried);
        } else {
          const stored = await fetchSessionTitle(storedIdForRest, resumeProfile);
          if (stored) setTitle(stored);
        }
      } catch {
        // A conversation with a placeholder title is fine; one that vanished
        // because its name could not be looked up is not.
      }

      return true;
    } catch (err) {
      // Offline is not a failed resume, it is a missing network: falling back
      // to `startNew` would spend a second timeout on a socket that cannot
      // answer either, and the cached-transcript effect below covers the case
      // properly. Leave the `resume=` intent in the URL so a reconnect picks
      // it up.
      if (!navigator.onLine || connection !== 'open') return false;

      toast(err instanceof Error ? err.message : 'Could not resume', 'error');
      // Fall back to a fresh session rather than leaving a dead screen.
      bootingRef.current = false;
      await startNew();
      return false;
    } finally {
      bootingRef.current = false;
      setBooting(false);
    }
  };

  // Slash commands: this screen owns the surfaces a command can open, so it
  // hands them to the runner rather than the runner knowing about sheets.
  const { run: runCommand, busy: commandBusy } = useSlashRunner({
    onNewChat: () => void startNew(),
    onOpenModel: () => setModelSheet(true),
    onOpenContext: () => setContextSheet(true),
    onOpenPalette: () => setPalette(true),
  });

  // Boot / re-boot when the URL intent changes, once the socket is up.
  useEffect(() => {
    if (connection !== 'open') return;

    if (resumeId) {
      /**
       * Already here. A push banner for the conversation on screen — the
       * common case, since the phone was backgrounded mid-turn — names the
       * gateway handle we are already holding, and resuming it would tear a
       * live session down to rebuild the same one.
       */
      if (resumeId === sessionId || resumeId === storedSessionId) {
        setParams({}, { replace: true });
        return;
      }

      void doResume(resumeId).then((ok) => {
        // Clear the intent so a reconnect doesn't resume all over again —
        // but only on success, or a resume that failed for want of a network
        // would lose the very id the reconnect needs.
        if (ok) setParams({}, { replace: true });
      });
      return;
    }

    if (wantNew || !sessionId) {
      void startNew().then(() => {
        if (wantNew) setParams({}, { replace: true });
      });
    }
    // Deliberately keyed on the connection + URL intent only. The two session
    // ids are read for the already-here short-circuit above, not as triggers:
    // adopting a session sets them, and re-running on that would undo the
    // boot that just happened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, resumeId, wantNew]);

  /**
   * Reattach to the gateway session, and reconcile, when the socket comes back.
   *
   * The gateway session outlives the socket — the socket is only transport —
   * so the boot effect above deliberately does nothing on a reconnect that
   * already holds a session. Two things still have to happen here, and the
   * first one is not optional.
   *
   * **`session.resume` is what tells the gateway this socket owns the session.**
   * A dropped socket leaves the session parked on Hermes' detached-transport
   * sentinel with a reap timer armed (`dashboard.ws_orphan_reap_grace_s`, 20s
   * by default): when it fires, a turn that is still running is **hard
   * interrupted** and the runtime reaped. Only `session.resume` /
   * `session.create` cancel that timer — `session.history` reads the
   * transcript without rebinding anything, so reconnecting in two seconds and
   * resyncing looked completely healthy from here and the agent was killed
   * eighteen seconds later, mid-tool-call, with `Operation interrupted.` in
   * the transcript. It also gets the stream pointed back at this socket: until
   * the transport is rebound, the events of a live turn go to the sentinel and
   * are gone.
   *
   * Second, and the reason this effect existed at all: events emitted while
   * the connection was down are lost. A turn that finished in that window
   * never delivered its `message.complete`, so the reply stayed frozen
   * mid-sentence and `running` stayed true.
   *
   * The resume answers with the live record when there is one, and with a
   * rebuilt runtime when there is not (the reap already fired, or Hermes
   * restarted) — a different gateway handle, which has to be adopted or every
   * later call addresses a session that no longer exists. That case gets the
   * transcript loaded outright rather than resynced: it is a runtime rebuilt
   * from disk, not the one we were watching.
   */
  const wasLive = useRef(false);
  useEffect(() => {
    const live = connection === 'open';
    const reconnected = live && !wasLive.current;
    wasLive.current = live;

    // The boot effect owns anything with a URL intent behind it, and a session
    // still being adopted has nothing to reconcile against yet.
    if (!reconnected || !sessionId || resumeId || wantNew || bootingRef.current) return;

    let alive = true;
    void (async () => {
      try {
        // No stored id — a session.create that has not answered yet, or one
        // Hermes never persisted. Nothing to resume against; reconcile alone.
        if (!storedSessionId) {
          const history = await fetchHistory(sessionId);
          if (alive) applyResync(history);
          void refreshUsage();
          return;
        }

        const res = await resumeSession(storedSessionId, resumeProfile);
        if (!alive) return;
        const rebuilt = res.session_id !== sessionId;
        if (rebuilt) {
          adopt({
            sessionId: res.session_id,
            storedSessionId: res.stored_session_id ?? storedSessionId,
            info: res.info,
            // Asked while we were away, and only a resume can surface it.
            pendingClarify: res.pending_clarify,
          });
        }

        const history = await fetchHistory(res.session_id);
        if (!alive) return;
        if (rebuilt) loadHistory(history);
        else applyResync(history);
        void refreshUsage();
      } catch {
        // The resume itself failed — a gateway that is up but refusing (a
        // reap still settling), or a socket that dropped again underneath us.
        // The full rebuild is the fallback it always was.
        if (!alive || !storedSessionId) return;
        await doResume(storedSessionId);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, sessionId]);

  /**
   * Offline: show the stored transcript instead of a spinner.
   *
   * The live transcript arrives over the socket (`session.history`), which is
   * exactly what is unavailable here, so this reads the REST copy that the
   * service worker caches. The `resume=` intent is deliberately left in the
   * URL: when the socket comes back the boot effect above resumes the session
   * for real and replaces this with the live one.
   */
  useEffect(() => {
    if (live || !resumeId || sessionId) return;
    let alive = true;
    void (async () => {
      try {
        const stored = await fetchStoredMessages(resumeId);
        if (!alive || !stored.length) return;
        loadHistory(
          stored.map((m) => ({
            role: m.role,
            text: m.content ?? '',
            name: m.tool_name ?? undefined,
            reasoning: m.reasoning ?? undefined,
            /**
             * Only clarify carries its result through here. Its whole exchange
             * — question, choices and answer — lives in that one object, so
             * without it an offline transcript shows a question card with
             * nothing in it. Whether every tool's output should show offline
             * is a separate question, and not one this change answers.
             */
            result: m.tool_name === 'clarify' ? (m.content ?? undefined) : undefined,
          })),
        );
        setOfflineView(true);
        const stitle = await fetchSessionTitle(resumeId);
        if (alive && stitle) setTitle(stitle);
      } catch {
        // Nothing cached for this session — the waiting state below stands.
      }
    })();
    return () => {
      alive = false;
    };
  }, [live, resumeId, sessionId, loadHistory, setTitle]);

  // Drop the read-only view the moment a real session is adopted.
  useEffect(() => {
    if (sessionId && offlineView) setOfflineView(false);
  }, [sessionId, offlineView]);

  // Feed gateway events into the session store.
  useEffect(() => hermes.onEvent((params) => useSession.getState().applyEvent(params)), []);

  // Prefill from an Android share, once there's a session to send it to. The
  // seed is handed to the composer and then cleared from the URL so a reload
  // doesn't re-insert it.
  const [seed, setSeed] = useState('');
  const [seedFiles, setSeedFiles] = useState<File[]>([]);
  const sharedRef = useRef(false);
  useEffect(() => {
    if (shared && sessionId && !sharedRef.current) {
      sharedRef.current = true;
      setSeed(shared);
      toast('Shared content added to the composer', 'info');
    }
  }, [shared, sessionId, toast]);

  /**
   * The file-carrying share. Claimed once — the worker deletes the payload as
   * it hands it over — and only once a session exists, since `image.attach_bytes`
   * needs one and there is nowhere to put the bytes until then.
   *
   * A claim that comes back empty is reported rather than ignored. The person
   * chose this app from the share sheet and is now looking at a blank new
   * chat; saying nothing would read as the photo having been silently dropped,
   * which is exactly what happened.
   */
  const claimedRef = useRef(false);
  useEffect(() => {
    if (!shareId || !sessionId || claimedRef.current) return;
    claimedRef.current = true;
    let alive = true;
    void takeShared(shareId).then((payload) => {
      if (!alive) return;
      if (!payload) {
        toast("That share didn't come through — try the paperclip", 'warn');
        setParams({}, { replace: true });
        return;
      }
      if (payload.text) setSeed(payload.text);
      if (payload.files.length) setSeedFiles(payload.files);
    });
    return () => {
      alive = false;
    };
  }, [shareId, sessionId, toast, setParams]);

  return (
    <div className="screen">
      <div className="header">
        <MenuButton />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="header__title">{title || 'New chat'}</div>
          <button
            className="header__sub"
            onClick={() => setModelSheet(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 3 }}
          >
            {info?.model ?? 'default model'}
            <IconChevron size={11} style={{ transform: 'rotate(90deg)' }} />
          </button>
        </div>
        {/* Only when something is actually running. The header is already
            four controls wide, so this has to cost nothing the rest of the
            time — which is most of the time. Sessions only: see `useActivity`. */}
        {activityRunning > 0 && (
          <button
            className="chip chip--live"
            onClick={() => navigate('/activity')}
            aria-label={`${activityRunning} running — open Activity`}
          >
            <span className="tool__pulse" />
            {activityRunning}
          </button>
        )}
        {/* Pin, archive and export, from the conversation they are about.
            The same sheet the Sessions list opens from a row's `⋯` — which
            was the only way in, so exporting the chat you were reading meant
            leaving it to find its row. Hidden until there is a stored session
            to act on. */}
        {storedSessionId && (
          <button
            className="icon-btn"
            onClick={() => {
              buzz('tap');
              setActionsOpen(true);
            }}
            aria-label="Session actions"
          >
            ⋯
          </button>
        )}
        <button
          className="icon-btn"
          onClick={() => setSearchOpen((o) => !o)}
          aria-label="Find in conversation"
          aria-pressed={searchOpen}
        >
          <IconSearch size={19} />
        </button>
        <button className="icon-btn" onClick={() => void startNew()} aria-label="New chat">
          <IconPlus size={21} />
        </button>
      </div>

      {error && (
        /* A button, not a div with a handler: it was already tap-to-dismiss,
           but nothing said so and a keyboard could not reach it. `alert` so it
           is announced — this is where a failed send surfaces. */
        <button
          type="button"
          className="conn-banner conn-banner--closed conn-banner--dismiss"
          role="alert"
          onClick={() => useSession.setState({ error: null })}
          aria-label={`${error}. Dismiss`}
        >
          <span>{error}</span>
          <IconClose size={15} />
        </button>
      )}

      {offlineView && (
        <div className="conn-banner conn-banner--reconnecting">
          Offline — showing the saved transcript. It goes live when the
          connection returns.
        </div>
      )}

      {!live && !sessionId && !offlineView ? (
        <Empty
          icon="⚡"
          title="Waiting for connection…"
          hint="Hem is unreachable. This screen picks up on its own once the socket is back."
          action={
            // "Now" means now: `resume` drops any pending backoff.
            <button className="btn" onClick={() => hermes.connect({ resume: true })}>
              Retry now
            </button>
          }
        />
      ) : booting && !sessionId ? (
        <div className="empty">
          <Loader />
          <div className="empty__title">Starting a session…</div>
        </div>
      ) : (
        <MessageList searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} />
      )}

      <Composer
        onOpenContext={() => setContextSheet(true)}
        seedText={seed}
        onSeedConsumed={() => {
          setSeed('');
          // Hold the URL until the files have gone up too, or clearing it here
          // would strip `?share=` out from under a claim still in flight.
          if (!seedFiles.length) setParams({}, { replace: true });
        }}
        seedFiles={seedFiles}
        onSeedFilesConsumed={() => {
          setSeedFiles([]);
          setParams({}, { replace: true });
        }}
        onRunCommand={runCommand}
        commandBusy={commandBusy}
        commandSeed={commandSeed}
        onCommandSeedConsumed={() => setCommandSeed('')}
        onOpenPalette={() => setPalette(true)}
      />

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onRun={(command) => void runCommand(command)}
        onSeed={setCommandSeed}
      />

      {actionsOpen && actionsRow.data && (
        <SessionActionsSheet session={actionsRow.data} onClose={() => setActionsOpen(false)} />
      )}

      <ModelSheet open={modelSheet} onClose={() => setModelSheet(false)} />
      <ContextSheet open={contextSheet} onClose={() => setContextSheet(false)} />
    </div>
  );
}
