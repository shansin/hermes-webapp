/**
 * The flagship screen: live streaming conversation with the agent.
 *
 * Session lifecycle:
 *  - `?resume=<storedId>` reopens a stored conversation and replays history
 *  - `?new=1` (or no session yet) creates a fresh one
 *  - the gateway session handle is kept in the store; it is *not* the same as
 *    the stored session id used by the REST endpoints
 */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageList } from '../components/chat/MessageList';
import { Composer } from '../components/composer/Composer';
import { CommandPalette } from '../components/composer/CommandPalette';
import { ApprovalSheet } from '../components/chat/ApprovalSheet';
import { ModelSheet } from '../components/chat/ModelSheet';
import { ContextSheet } from '../components/chat/ContextSheet';
import { IconPlus, IconChevron } from '../components/shared/Icons';
import { Empty, Loader } from '../components/shared/misc';
import { useSession } from '../store/session';
import { MenuButton } from '../components/shared/MenuButton';
import { useUi } from '../store/ui';
import { hermes } from '../ws/client';
import { createSession, fetchHistory, resumeSession } from '../api/gateway';
import { fetchSessionTitle, fetchStoredMessages } from '../api/sessions';
import { useSlashRunner } from '../lib/useSlashRunner';

export function ChatScreen() {
  const [params, setParams] = useSearchParams();
  const [modelSheet, setModelSheet] = useState(false);
  const [contextSheet, setContextSheet] = useState(false);
  const [palette, setPalette] = useState(false);
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
  const title = useSession((s) => s.title);
  const info = useSession((s) => s.info);
  const error = useSession((s) => s.error);
  const reset = useSession((s) => s.reset);
  const adopt = useSession((s) => s.adoptSession);
  const loadHistory = useSession((s) => s.loadHistory);
  const setTitle = useSession((s) => s.setTitle);
  const refreshUsage = useSession((s) => s.refreshUsage);

  const connection = useUi((s) => s.connection);
  const toast = useUi((s) => s.toast);

  /** A socket that is actually usable, as opposed to one that merely says so. */
  const live = online && connection === 'open';

  // Guards against double-boot in StrictMode and against a reconnect
  // re-running session setup for a session we already hold.
  const bootingRef = useRef(false);

  const resumeId = params.get('resume');
  const wantNew = params.get('new') === '1';
  // Android share-sheet target: /chat?text=…&title=…&url=…
  const shared = [params.get('title'), params.get('text'), params.get('url')]
    .filter(Boolean)
    .join('\n');

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
      const res = await resumeSession(storedId);
      adopt({
        sessionId: res.session_id,
        storedSessionId: res.stored_session_id ?? storedId,
        info: res.info,
      });
      const history = await fetchHistory(res.session_id);
      loadHistory(history);
      void refreshUsage();

      // Warm the offline copy. The live transcript comes over the socket, so
      // without this the REST mirror the service worker caches would never be
      // requested while online — and would therefore never be there when it
      // is the only thing that can answer.
      void fetchStoredMessages(res.stored_session_id ?? storedId).catch(() => {});

      // Restore the stored title: `session.title` only fires when the agent
      // names a conversation, so a resumed one would keep the placeholder.
      // Prefer a title the resume result already carried (schema passes
      // unknown fields through) over a second round trip.
      const carried = (res as { title?: unknown }).title;
      if (typeof carried === 'string' && carried) {
        setTitle(carried);
      } else {
        const stored = await fetchSessionTitle(res.stored_session_id ?? storedId);
        if (stored) setTitle(stored);
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
    // Deliberately keyed on the connection + URL intent only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, resumeId, wantNew]);

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
  const sharedRef = useRef(false);
  useEffect(() => {
    if (shared && sessionId && !sharedRef.current) {
      sharedRef.current = true;
      setSeed(shared);
      toast('Shared content added to the composer', 'info');
    }
  }, [shared, sessionId, toast]);

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
        <button className="icon-btn" onClick={() => void startNew()} aria-label="New chat">
          <IconPlus size={21} />
        </button>
      </div>

      {error && (
        <div className="conn-banner conn-banner--closed" onClick={() => useSession.setState({ error: null })}>
          {error}
        </div>
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
          hint="Hermes is unreachable. This screen picks up on its own once the socket is back."
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
        <MessageList />
      )}

      <Composer
        onOpenContext={() => setContextSheet(true)}
        seedText={seed}
        onSeedConsumed={() => {
          setSeed('');
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

      <ApprovalSheet />
      <ModelSheet open={modelSheet} onClose={() => setModelSheet(false)} />
      <ContextSheet open={contextSheet} onClose={() => setContextSheet(false)} />
    </div>
  );
}
