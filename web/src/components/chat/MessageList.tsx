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
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from './ThinkingBlock';
import { IconDown, IconSpeaker } from '../shared/Icons';
import { Empty, formatTokens } from '../shared/misc';
import { useSession } from '../../store/session';
import { speak } from '../../lib/audio';
import { useUi } from '../../store/ui';

const NEAR_BOTTOM_PX = 120;

export function MessageList() {
  const messages = useSession((s) => s.messages);
  const streamingText = useSession((s) => s.streamingText);
  const streamingReasoning = useSession((s) => s.streamingReasoning);
  const thinkingHint = useSession((s) => s.thinkingHint);
  const statusLine = useSession((s) => s.statusLine);
  const running = useSession((s) => s.running);
  const toast = useUi((s) => s.toast);

  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);

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
          />
        )}

        {messages.map((m) => {
          if (m.kind === 'user') {
            return (
              <div className="msg msg--user" key={m.id}>
                <div className="msg__bubble">{m.text}</div>
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

          return (
            <div className="msg msg--assistant" key={m.id}>
              {m.reasoning && <ThinkingBlock text={m.reasoning} />}
              <div className="msg__body">
                <Markdown>{m.text}</Markdown>
              </div>
              <div className="msg__meta">
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
    </>
  );
}
