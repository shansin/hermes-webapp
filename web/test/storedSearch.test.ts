/**
 * "Search whole session" (`lib/storedSearch`, `fetchWholeTranscript`).
 *
 * The stored transcript is read oldest-first in pages of 500 with compacted
 * turns included — the endpoint's default is the *latest* 500 without them,
 * which would miss exactly what find-in-chat could not see. Each hit carries
 * the prompt that opens its turn, because `/messages/around` accepts only a
 * prompt row as its anchor.
 */
import { describe, expect, it, vi } from 'vitest';
import { fetchWholeTranscript, type StoredMessage } from '../src/api/sessions';
import { searchStored, snippetAt, windowFromRows } from '../src/lib/storedSearch';

const row = (id: number, role: string, content: string | null, extra: object = {}): StoredMessage => ({
  id,
  role,
  content,
  tool_name: null,
  reasoning: null,
  timestamp: 1_700_000_000,
  ...extra,
});

const rows = [
  row(1, 'user', 'set up the Kafka cluster'),
  row(2, 'assistant', 'Done. Brokers are up.'),
  row(3, 'tool', 'kafka output that should not match'),
  row(4, 'user', 'now the consumers'),
  row(5, 'assistant', 'Consumers attached to KAFKA topic orders.'),
];

describe('searchStored', () => {
  it('matches user and assistant text, case-insensitively, anchored on the turn prompt', () => {
    const hits = searchStored(rows, 'kafka');
    expect(hits.map((h) => [h.rowId, h.anchorRowId])).toEqual([
      [1, 1],
      [5, 4],
    ]);
    expect(hits[0]!.at).toBe(1_700_000_000_000);
  });

  it('has no anchor before the first prompt, and stops at the cap', () => {
    expect(searchStored([row(9, 'assistant', 'kafka')], 'kafka')[0]!.anchorRowId).toBeNull();
    expect(searchStored(rows, 'o', 2)).toHaveLength(2);
    expect(searchStored(rows, '   ')).toEqual([]);
  });

  it('cuts a snippet around the match', () => {
    const text = `${'a '.repeat(100)}needle${' b'.repeat(100)}`;
    const s = snippetAt(text, text.indexOf('needle'), 6, 10);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('needle');
  });
});

describe('windowFromRows', () => {
  it('starts at the anchor and keeps the hit in view in a long turn', () => {
    const [first] = searchStored(rows, 'consumers attached');
    expect(windowFromRows(rows, first!).map((r) => r.id)).toEqual([4, 5]);

    const long = [row(1, 'user', 'go'), ...Array.from({ length: 300 }, (_, i) => row(i + 2, 'tool', 'x')), row(400, 'assistant', 'needle')];
    const hit = searchStored(long, 'needle')[0]!;
    const win = windowFromRows(long, hit, 120);
    expect(win).toHaveLength(120);
    expect(win.some((r) => r.id === 400)).toBe(true);
  });
});

describe('fetchWholeTranscript', () => {
  it('pages oldest-first with compacted rows until a short page, dropping hidden rows', async () => {
    const get = vi.fn(async (path: string) => {
      const offset = Number(/offset=(\d+)/.exec(path)![1]);
      if (offset === 0) return { messages: Array.from({ length: 500 }, (_, i) => row(i + 1, 'user', 'x')) };
      return { messages: [row(501, 'assistant', 'y'), row(502, 'user', '[System: summary]', { display_kind: 'hidden' })] };
    });
    const res = await fetchWholeTranscript('s 1', 'research', { get });
    expect(get).toHaveBeenCalledTimes(2);
    const first = get.mock.calls[0]![0];
    expect(first).toContain('/api/sessions/s%201/messages?order=oldest&include_compacted=true');
    expect(first).toContain('&profile=research');
    expect(res.complete).toBe(true);
    expect(res.messages).toHaveLength(501);
  });

  it('says when the page ceiling stopped it', async () => {
    const get = vi.fn(async () => ({ messages: Array.from({ length: 500 }, (_, i) => row(i, 'user', 'x')) }));
    const res = await fetchWholeTranscript('s1', null, { get, maxPages: 2 });
    expect(res.complete).toBe(false);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
