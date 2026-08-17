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
import { ApprovalSheet } from '../components/chat/ApprovalSheet';
import { ModelSheet } from '../components/chat/ModelSheet';
import { ContextSheet } from '../components/chat/ContextSheet';
import { IconPlus, IconChevron } from '../components/shared/Icons';
import { useSession } from '../store/session';
import { useUi } from '../store/ui';
import { hermes } from '../ws/client';
import { createSession, fetchHistory, resumeSession } from '../api/gateway';
import { fetchSessionTitle } from '../api/sessions';

export function ChatScreen() {
  const [params, setParams] = useSearchParams();
  const [modelSheet, setModelSheet] = useState(false);
  const [contextSheet, setContextSheet] = useState(false);
  const [booting, setBooting] = useState(false);

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

  const doResume = async (storedId: string) => {
    if (bootingRef.current) return;
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
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not resume', 'error');
      // Fall back to a fresh session rather than leaving a dead screen.
      bootingRef.current = false;
      await startNew();
      return;
    } finally {
      bootingRef.current = false;
      setBooting(false);
    }
  };

  // Boot / re-boot when the URL intent changes, once the socket is up.
  useEffect(() => {
    if (connection !== 'open') return;

    if (resumeId) {
      void doResume(resumeId).then(() => {
        // Clear the intent so a reconnect doesn't resume all over again.
        setParams({}, { replace: true });
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

      {booting && !sessionId ? (
        <div className="empty">
          <div className="spin" style={{ fontSize: 26 }}>
            ◌
          </div>
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
      />

      <ApprovalSheet />
      <ModelSheet open={modelSheet} onClose={() => setModelSheet(false)} />
      <ContextSheet open={contextSheet} onClose={() => setContextSheet(false)} />
    </div>
  );
}
