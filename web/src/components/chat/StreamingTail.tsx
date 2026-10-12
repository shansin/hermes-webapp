/**
 * The live turn at the bottom of the transcript, and the block-wise markdown
 * renderer it streams through.
 *
 * Its own file because it is its own render loop: the only component in the
 * chat that re-renders per token, deliberately subscribed apart from
 * `MessageList` so a delta does not walk the whole transcript. Nothing else
 * in the list shares its state or its throttle.
 */
import { memo, useLayoutEffect, useMemo } from 'react';
import { splitStableMarkdown } from '../../lib/streamingMarkdown';
import { Markdown } from './MarkdownAsync';
import { ThinkingBlock } from './ThinkingBlock';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { useThrottled } from '../../lib/useThrottled';

/**
 * How often the streaming bubble is allowed to re-render, in ms. ~10 fps: fast
 * enough to read as continuous, slow enough that markdown parsing stops
 * dominating the frame budget on a phone.
 */
const STREAM_RENDER_MS = 100;

/**
 * The streaming reply, parsed once per block instead of once per tick.
 *
 * `Markdown` re-parses everything it is given, and the tail hands it the whole
 * accumulated message ten times a second — so the cost of watching a reply
 * arrive grows with the reply, and by the last paragraph of a long answer most
 * of the work is re-parsing text that finished minutes ago and cannot change.
 *
 * `splitStableMarkdown` finds the boundary between the finished blocks and the
 * one still being written (its own file, with the reasoning and the tests for
 * where that boundary may legally fall). The finished half is handed to a
 * separate, memoized `Markdown` whose `children` string is identical between
 * ticks, so React skips it entirely; only the open block is re-parsed. What is
 * re-parsed per tick becomes a function of the current paragraph rather than
 * of the whole message.
 *
 * The alternative was rendering the tail as plain text until `message.complete`
 * and parsing once at the end. It is cheaper still and was rejected: the reply
 * would arrive as unformatted markdown source — visible asterisks, unrendered
 * fences — and snap into shape at the end, which is worse to watch than a
 * little parsing.
 */
function StreamingMarkdown({ text }: { text: string }) {
  const { stable, open } = useMemo(() => splitStableMarkdown(text), [text]);

  if (!stable) return <Markdown>{open}</Markdown>;

  return (
    <>
      {/* The class restores the bottom margin `.md > *:last-child` removes —
          the finished half is no longer the end of the message. */}
      <div className="md-stable">
        <Markdown>{stable}</Markdown>
      </div>
      <Markdown>{open}</Markdown>
    </>
  );
}

/**
 * The live turn — the only thing in the chat that re-renders per token.
 *
 * This is deliberately a separate component from the transcript. Both read the
 * same store, but `MessageList` subscribes only to `messages`, so a delta
 * arriving 40×/second no longer walks and re-renders every historical bubble,
 * tool card and thinking block. The per-token cost goes from O(transcript) to
 * O(1).
 *
 * The text is throttled on top of that, because rendering it means re-parsing
 * the whole partial markdown document — remark-gfm and highlight.js included —
 * from scratch each time.
 */
export const StreamingTail = memo(function StreamingTail({ onGrow }: { onGrow: () => void }) {
  const streamingText = useSession((s) => s.streamingText);
  const streamingReasoning = useSession((s) => s.streamingReasoning);
  const statusLine = useSession((s) => s.statusLine);
  const thinkingHint = useSession((s) => s.thinkingHint);
  const running = useSession((s) => s.running);

  const text = useThrottled(streamingText, STREAM_RENDER_MS);
  const showReasoning = useUi((s) => s.showReasoning);
  const reasoning = useThrottled(showReasoning ? streamingReasoning : '', STREAM_RENDER_MS);
  /**
   * Throttled like the other two, and for exactly the same reason.
   *
   * `thinking.delta` arrives at the same 30–60/s as the text deltas and the
   * store writes the hint on every one of them. Read raw, it re-rendered this
   * component at the full event rate through the entire pre-answer phase —
   * the phase where the two values that *were* throttled are both empty, so
   * the throttling bought nothing and this was the only thing driving the
   * renders. Same 10fps ceiling: a decorative "pondering…" line has no claim
   * to a higher frame rate than the answer.
   */
  const hint = useThrottled(thinkingHint, STREAM_RENDER_MS);

  // Same frame as the new content, so the tail never visibly lags the tokens.
  useLayoutEffect(() => {
    onGrow();
  }, [text, reasoning, statusLine, onGrow]);

  if (!reasoning && !text && !running) return null;

  return (
    <div className="msg msg--assistant">
      {reasoning && <ThinkingBlock text={reasoning} streaming />}
      {text ? (
        <div className="msg__body">
          <StreamingMarkdown text={text} />
        </div>
      ) : (
        // Shown for the whole pre-answer phase now, reasoning or not. It used
        // to be suppressed while reasoning was streaming, because the expanded
        // thinking block was the thing to watch — but that block is collapsed
        // by default now, so without this the wait before the first token had
        // nothing moving in it at all.
        <div className="status-line">
          {statusLine || hint || 'Working…'}
          <span className="caret" />
        </div>
      )}
      {text && statusLine && <div className="status-line">{statusLine}</div>}
    </div>
  );
});
