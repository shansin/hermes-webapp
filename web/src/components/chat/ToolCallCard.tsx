/**
 * A tool invocation in the transcript.
 *
 * Collapsed by default — a turn can fire a dozen tools and the reply is what
 * the user came for. Tapping expands the arguments and the tool's output.
 */
import { memo, useState } from 'react';
import { IconChevron } from '../shared/Icons';
import type { ChatMessage } from '../../store/session';
import { buzz } from '../../lib/haptics';

/** A small visual cue per tool family; falls back to a generic glyph. */
function iconFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('terminal') || n.includes('process') || n.includes('shell')) return '›_';
  if (n.includes('read') || n.includes('file') || n.includes('patch') || n.includes('write')) return '📄';
  if (n.includes('search') || n.includes('grep')) return '🔍';
  if (n.includes('web') || n.includes('browser')) return '🌐';
  if (n.includes('memory')) return '🧠';
  if (n.includes('todo') || n.includes('task')) return '✓';
  if (n.includes('delegate') || n.includes('agent')) return '🤝';
  if (n.includes('image') || n.includes('vision')) return '🖼';
  if (n.includes('speech') || n.includes('tts') || n.includes('voice')) return '🔊';
  if (n.includes('skill')) return '⚡';
  if (n.includes('cron')) return '⏰';
  return '🔧';
}

/**
 * Tool results are shaped per-tool. Render the common cases readably and fall
 * back to pretty-printed JSON rather than guessing.
 */
function renderResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.output === 'string') {
      const exit = typeof r.exit_code === 'number' && r.exit_code !== 0 ? `\n[exit ${r.exit_code}]` : '';
      const err = typeof r.error === 'string' && r.error ? `\n${r.error}` : '';
      return r.output + err + exit;
    }
    if (typeof r.content === 'string') return r.content;
    if (typeof r.text === 'string') return r.text;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

const MAX_CHARS = 4000;

export const ToolCallCard = memo(function ToolCallCard({
  msg,
}: {
  msg: Extract<ChatMessage, { kind: 'tool' }>;
}) {
  const [open, setOpen] = useState(false);
  const running = msg.status === 'running';

  const output = renderResult(msg.result);
  const truncated = output.length > MAX_CHARS;
  const shown = truncated ? output.slice(0, MAX_CHARS) : output;

  const hasDetail = Boolean(output) || Boolean(msg.args && Object.keys(msg.args).length);

  return (
    <div className={`tool${running ? ' tool--running' : ''}`}>
      <button
        className="tool__head"
        onClick={() => {
          if (!hasDetail) return;
          buzz('tap');
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        <span className="tool__icon">{iconFor(msg.name)}</span>
        <span className="tool__main">
          <span className="tool__name">{msg.name}</span>
          {msg.context && <div className="tool__ctx">{msg.context}</div>}
        </span>
        {running ? (
          <span className="tool__pulse" />
        ) : (
          <>
            {msg.durationS != null && (
              <span className="tool__dur">{msg.durationS.toFixed(1)}s</span>
            )}
            {hasDetail && (
              <span className={`think__caret${open ? ' think__caret--open' : ''}`}>
                <IconChevron size={15} />
              </span>
            )}
          </>
        )}
      </button>

      {open && hasDetail && (
        <div className="tool__out">
          {msg.args && Object.keys(msg.args).length > 0 && (
            <div style={{ marginBottom: output ? 10 : 0, color: 'var(--text-faint)' }}>
              {JSON.stringify(msg.args, null, 2)}
            </div>
          )}
          {shown}
          {truncated && (
            <div style={{ color: 'var(--text-faint)', marginTop: 8 }}>
              … {(output.length - MAX_CHARS).toLocaleString()} more characters
            </div>
          )}
        </div>
      )}
    </div>
  );
});
