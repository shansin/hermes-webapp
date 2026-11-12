/**
 * "Search whole session": find-in-chat's fallback, over the stored transcript.
 *
 * A read-only viewer rather than a jump inside the live transcript, on
 * purpose. The store's message list is one contiguous run that every
 * reconnect rebuilds from `session.history` and that `unreadSince`, the
 * history divider and the turn jumps all assume is contiguous; splicing a
 * window from the middle of a compacted conversation into it would break
 * each of those quietly. So a hit opens here: the turn it belongs to, loaded
 * with `/messages/around` from the prompt that opens it, scrolled to the hit.
 *
 * The search itself is `lib/storedSearch.ts` (why not the FTS endpoint is
 * there). Lazy: `MessageList` mounts it only when asked.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { Loader } from '../shared/misc';
import { Markdown } from './MarkdownAsync';
import { fetchMessagesAround, fetchWholeTranscript, type StoredMessage } from '../../api/sessions';
import { searchStored, windowFromRows, type StoredHit } from '../../lib/storedSearch';
import { buzz } from '../../lib/haptics';

const faint = { fontSize: 'var(--type-body-sm)', color: 'var(--text-faint)' } as const;

interface Props {
  query: string;
  storedId: string;
  profile: string | null;
  onClose: () => void;
}

function stamp(ms: number | null): string {
  return ms == null
    ? ''
    : new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function SessionSearchSheet({ query, storedId, profile, onClose }: Props) {
  const [rows, setRows] = useState<StoredMessage[] | null>(null);
  const [complete, setComplete] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<StoredHit[]>([]);
  const [hit, setHit] = useState<StoredHit | null>(null);

  useEffect(() => {
    let alive = true;
    fetchWholeTranscript(storedId, profile)
      .then((res) => {
        if (!alive) return;
        setRows(res.messages);
        setComplete(res.complete);
        setHits(searchStored(res.messages, query));
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : 'Could not read the saved conversation'));
    return () => {
      alive = false;
    };
  }, [storedId, profile, query]);

  return (
    <Sheet open title={hit ? 'In context' : `“${query.trim()}” in this session`} onClose={onClose}>
      {error ? (
        <p style={{ ...faint, color: 'var(--error)' }}>{error}</p>
      ) : !rows ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
          <Loader />
        </div>
      ) : hit ? (
        <HitWindow hit={hit} rows={rows} storedId={storedId} profile={profile} query={query} onBack={() => setHit(null)} />
      ) : hits.length === 0 ? (
        <p style={faint}>
          Not in the saved conversation either{complete ? '' : ' (searched its first 4,000 messages)'}.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {hits.map((h) => (
              <button
                key={h.rowId}
                className="card"
                style={{ textAlign: 'left', font: 'inherit', color: 'inherit' }}
                onClick={() => {
                  buzz('tap');
                  setHit(h);
                }}
              >
                <div style={faint}>
                  {h.role === 'user' ? 'You' : 'Hem'}
                  {h.at != null ? ` · ${stamp(h.at)}` : ''}
                </div>
                <div style={{ fontSize: 'var(--type-body-sm)', marginTop: 4, overflowWrap: 'anywhere' }}>{h.snippet}</div>
              </button>
            ))}
          </div>
          {!complete && <p style={{ ...faint, marginTop: 10 }}>Searched the first 4,000 messages.</p>}
        </>
      )}
    </Sheet>
  );
}

function HitWindow({
  hit,
  rows,
  storedId,
  profile,
  query,
  onBack,
}: {
  hit: StoredHit;
  rows: StoredMessage[];
  storedId: string;
  profile: string | null;
  query: string;
  onBack: () => void;
}) {
  const [page, setPage] = useState<StoredMessage[] | null>(null);
  const target = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setPage(null);
    const fallback = () => windowFromRows(rows, hit);
    if (hit.anchorRowId == null) {
      setPage(fallback());
      return;
    }
    fetchMessagesAround(storedId, hit.anchorRowId, profile)
      .then((res) => alive && setPage(res.messages.length ? res.messages : fallback()))
      // 404 "Prompt not found" for a synthetic prompt or an earlier segment.
      .catch(() => alive && setPage(fallback()));
    return () => {
      alive = false;
    };
  }, [hit, rows, storedId, profile]);

  // The hit by row id, else the first row that contains the query — the
  // around page and the scanned rows can carry different copies of a
  // compacted row.
  const q = query.trim().toLowerCase();
  const targetId =
    page?.find((r) => r.id === hit.rowId)?.id ??
    page?.find((r) => (r.content ?? '').toLowerCase().includes(q))?.id;

  useLayoutEffect(() => {
    target.current?.scrollIntoView({ block: 'center' });
  }, [page]);

  return (
    <>
      <button className="btn btn--sm" onClick={onBack} style={{ marginBottom: 10 }}>
        ← Results
      </button>
      {!page ? (
        <Loader size="sm" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {page.map((r) => {
            const isTarget = r.id === targetId;
            const content = r.content ?? '';
            return (
              <div
                key={r.id}
                ref={isTarget ? target : undefined}
                className={isTarget ? 'card' : undefined}
                style={{
                  borderColor: isTarget ? 'var(--accent)' : undefined,
                  padding: isTarget ? 10 : '0 2px',
                }}
              >
                <div style={faint}>
                  {r.role === 'user' ? 'You' : r.role === 'assistant' ? 'Hem' : `⚒ ${r.tool_name ?? r.role}`}
                  {r.timestamp ? ` · ${stamp(r.timestamp * 1000)}` : ''}
                </div>
                {r.role === 'assistant' ? (
                  <Markdown>{content}</Markdown>
                ) : r.role === 'user' ? (
                  <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
