/**
 * The transcript.
 *
 * Auto-scroll rule: follow the tail only while the user is already near the
 * bottom. Scrolling up to read must never be yanked back by an incoming token
 * — instead a jump-to-bottom button appears.
 *
 * This renders messages directly rather than virtualizing: entries have wildly
 * variable height (code blocks, tool output), and measuring them costs more
 * than it saves at realistic transcript lengths. The tool/reasoning bodies are
 * individually capped and scrollable, which is what actually bounds the DOM.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from './ThinkingBlock';
import { SubagentCard } from './SubagentCard';
import { EditTurnSheet } from './EditTurnSheet';
import { IconChevron, IconDown, IconRefresh, IconSpeaker } from '../shared/Icons';
import { useSessions } from '../../api/sessions';
import { Empty, formatTokens, relTime } from '../shared/misc';
import { useSession, type MessageTime } from '../../store/session';
import { speak } from '../../lib/audio';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

const NEAR_BOTTOM_PX = 120;

/**
 * Clock time for a message, or null when it isn't known.
 *
 * Restored history has no timestamps, so those messages simply don't get one —
 * see `MessageTime`. The full date lives in the title attribute.
 */
function Stamp({ at }: { at: MessageTime }) {
  if (at == null) return null;
  const d = new Date(at);
  return (
    <span title={d.toLocaleString()}>
      {d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

export function MessageList() {
  const messages = useSession((s) => s.messages);
  const streamingText = useSession((s) => s.streamingText);
  const streamingReasoning = useSession((s) => s.streamingReasoning);
  const thinkingHint = useSession((s) => s.thinkingHint);
  const statusLine = useSession((s) => s.statusLine);
  const running = useSession((s) => s.running);
  const rewinding = useSession((s) => s.rewinding);
  const retryLast = useSession((s) => s.retryLast);
  const toast = useUi((s) => s.toast);

  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  /** The user message whose bubble is showing its actions, if any. */
  const [openActions, setOpenActions] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  /**
   * Retry only makes sense on the newest reply — rerunning an older one would
   * silently discard everything after it, which is what edit is for.
   */
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.kind === 'assistant') return m.id;
      if (m?.kind === 'user') return null;
    }
    return null;
  }, [messages]);

  const isNearBottom = () => {
    const el = ref.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  // useLayoutEffect so the scroll lands in the same frame as the new content,
  // which avoids a visible jump while tokens stream.
  useLayoutEffect(() => {
    if (stuck && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [messages, streamingText, streamingReasoning, statusLine, stuck]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setStuck(isNearBottom());
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const jump = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setStuck(true);
  };

  const empty = messages.length === 0 && !running && !streamingText;

  return (
    <>
      <div className="chat__list" ref={ref}>
        {empty && (
          <Empty
            icon="✦"
            title="Ready when you are"
            hint="Ask a question, or use a quick action below."
            action={<RecentSessions />}
          />
        )}

        {messages.map((m) => {
          if (m.kind === 'user') {
            const open = openActions === m.id;
            return (
              <div className="msg msg--user" key={m.id}>
                {/* A skill command shows its invocation, not the expanded
                    prompt the model was actually handed. */}
                <button
                  className="msg__bubble msg__bubble--tappable"
                  onClick={() => {
                    buzz('tap');
                    setOpenActions(open ? null : m.id);
                  }}
                  // No aria-label: the message text itself must stay the
                  // button's accessible name, or the transcript goes silent to
                  // a screen reader. `aria-expanded` carries the affordance.
                  aria-expanded={open}
                >
                  {m.displayText ?? m.text}
                </button>
                {open && (
                  <div className="msg__meta">
                    <Stamp at={m.at} />
                    <button
                      className="code__copy"
                      disabled={running || rewinding}
                      onClick={() => {
                        setOpenActions(null);
                        // Edit the real prompt, not the short display form.
                        setEditing({ id: m.id, text: m.text });
                      }}
                    >
                      Edit &amp; resend
                    </button>
                  </div>
                )}
              </div>
            );
          }

          if (m.kind === 'notice') {
            return (
              <div className="msg" key={m.id}>
                <div className={`notice${m.tone === 'error' ? ' notice--error' : ''}`}>
                  {m.label && <div className="notice__label">{m.label}</div>}
                  <pre className="notice__body">{m.text}</pre>
                </div>
              </div>
            );
          }

          if (m.kind === 'tool') {
            return (
              <div className="msg" key={m.id}>
                <ToolCallCard msg={m} />
              </div>
            );
          }

          if (m.kind === 'subagent') {
            return (
              <div className="msg" key={m.id}>
                <SubagentCard msg={m} />
              </div>
            );
          }

          return (
            <div className="msg msg--assistant" key={m.id}>
              {m.reasoning && <ThinkingBlock text={m.reasoning} />}
              <div className="msg__body">
                <Markdown>{m.text}</Markdown>
              </div>
              <div className="msg__meta">
                <Stamp at={m.at} />
                {m.interrupted && <span className="msg__interrupted">Interrupted</span>}
                {m.usage?.total != null && <span>{formatTokens(m.usage.total)} tok</span>}
                {m.text && (
                  <button
                    className="code__copy"
                    onClick={() =>
                      speak(m.text).catch((e) =>
                        toast(e instanceof Error ? e.message : 'Speech unavailable', 'warn'),
                      )
                    }
                    aria-label="Read aloud"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <IconSpeaker size={13} /> Play
                  </button>
                )}
                {m.id === lastAssistantId && (
                  <button
                    className="code__copy"
                    disabled={running || rewinding}
                    onClick={() => {
                      buzz('tap');
                      void retryLast();
                    }}
                    aria-label="Retry this reply"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <IconRefresh size={13} /> {rewinding ? 'Retrying…' : 'Retry'}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Live turn */}
        {(streamingReasoning || streamingText || running) && (
          <div className="msg msg--assistant">
            {streamingReasoning && <ThinkingBlock text={streamingReasoning} streaming />}
            {streamingText ? (
              <div className="msg__body">
                <Markdown>{streamingText}</Markdown>
              </div>
            ) : (
              !streamingReasoning && (
                <div className="status-line">
                  {statusLine || thinkingHint || 'Working…'}
                  <span className="caret" />
                </div>
              )
            )}
            {streamingText && statusLine && <div className="status-line">{statusLine}</div>}
          </div>
        )}
      </div>

      {!stuck && (
        <button className="jump-fab" onClick={jump} aria-label="Jump to latest">
          <IconDown size={19} />
        </button>
      )}

      <EditTurnSheet
        turn={editing}
        onClose={() => setEditing(null)}
        onSubmit={(text) => {
          const id = editing?.id;
          setEditing(null);
          if (id) void useSession.getState().editTurn(id, text);
        }}
      />
    </>
  );
}

/**
 * The three most recent conversations, offered on the empty chat.
 *
 * This is the screen the app opens on, and picking up yesterday's thread is
 * the most common thing to want next — it was previously three taps away
 * through the drawer and the session list, on a screen that was otherwise
 * two-thirds empty.
 */
function RecentSessions() {
  const navigate = useNavigate();
  const { data } = useSessions(3);
  const rows = data?.sessions?.slice(0, 3) ?? [];
  if (rows.length === 0) return null;

  return (
    <div style={{ width: '100%', maxWidth: 340, marginTop: 18 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: 'var(--text-faint)',
          marginBottom: 8,
          textAlign: 'left',
        }}
      >
        PICK UP WHERE YOU LEFT OFF
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <button
            key={r.id}
            className="card"
            onClick={() => {
              buzz('tap');
              navigate(`/chat?resume=${encodeURIComponent(r.id)}`);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              textAlign: 'left',
              padding: '10px 12px',
              width: '100%',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  fontSize: 13.5,
                  color: 'var(--text)',
                  fontWeight: 550,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.title || 'Untitled'}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                {r.message_count} msg · {relTime(r.ended_at ?? r.started_at)}
              </span>
            </span>
            <IconChevron size={15} />
          </button>
        ))}
      </div>
    </div>
  );
}
