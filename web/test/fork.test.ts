/**
 * Forking a conversation (`lib/forkPoint`, `lib/forkFlow`).
 *
 * The cut is the part that is wrong invisibly: `session.branch {count}` keeps
 * the first N user/assistant rows of the *stored* display history, so a count
 * read off the screen silently forks a compacted session at the wrong turn,
 * and `count: 0` copies everything rather than nothing. The flow is pinned
 * against the real store with the network injected: what is sent, what the
 * screen switches to, and that a fork answered after the user moved on does
 * not drag them back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryMessage } from '../src/ws/types';
import type { StoredMessage } from '../src/api/sessions';

vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn(), setHapticsEnabled: vi.fn() }));
const call = vi.fn(async () => ({}) as unknown);
vi.mock('../src/ws/client', () => ({
  hermes: { call: (...a: unknown[]) => call(...(a as [])), onEvent: () => () => {}, onState: () => () => {} },
  CONTROL_TIMEOUT_MS: 15_000,
  ConnectionLost: class extends Error {},
}));
vi.mock('../src/api/gateway', () => ({ undoTurns: async () => '', fetchHistory: async () => [] }));

const { useSession } = await import('../src/store/session');
const { forkAt } = await import('../src/lib/forkFlow');
const { forkCountFromLocal, forkCountFromStored, forkLanded, forkTarget } = await import('../src/lib/forkPoint');
const store = () => useSession.getState();

const row = (id: number, role: string, content: string | null): StoredMessage => ({
  id,
  role,
  content,
  tool_name: null,
  reasoning: null,
  timestamp: 0,
});

/** u1 a1 (tool) u2 a2, loaded from history so ids are known. */
function loadFour(withRowIds = false) {
  const h = [
    { role: 'user', text: 'first', ...(withRowIds ? { row_id: 11 } : {}) },
    { role: 'assistant', text: 'one', ...(withRowIds ? { row_id: 12 } : {}) },
    { role: 'tool', name: 'terminal' },
    { role: 'user', text: 'second', ...(withRowIds ? { row_id: 14 } : {}) },
    { role: 'assistant', text: 'two', ...(withRowIds ? { row_id: 15 } : {}) },
  ] as HistoryMessage[];
  store().loadHistory(h);
  return store().messages;
}

describe('forkPoint', () => {
  beforeEach(() => {
    store().reset();
    store().adoptSession({ sessionId: 's1', storedSessionId: 'stored-1' });
  });

  it('counts user/assistant rows only, through a reply or before a prompt', () => {
    const m = loadFour();
    const a2 = m.find((x) => x.kind === 'assistant' && x.text === 'two')!;
    const u2 = m.find((x) => x.kind === 'user' && x.text === 'second')!;
    expect(forkCountFromLocal(m, a2.id, 'through')).toBe(4);
    expect(forkCountFromLocal(m, u2.id, 'before')).toBe(2);
  });

  it('refuses a fork before the first message, which count 0 cannot express', () => {
    const m = loadFour();
    expect(forkCountFromLocal(m, m[0]!.id, 'before')).toBeNull();
  });

  it('finds the message in a compacted stored transcript by text and ordinal', () => {
    const m = loadFour();
    const a1 = m.find((x) => x.kind === 'assistant' && x.text === 'one')!;
    // Two compacted turns ahead of what the screen holds, plus a repeat of
    // the same reply text earlier on.
    const stored = [
      row(1, 'user', 'old'),
      row(2, 'assistant', 'one'),
      row(3, 'tool', 'output'),
      row(4, 'user', 'first'),
      row(5, 'assistant', 'one'),
    ];
    const target = forkTarget(m, a1.id)!;
    expect(target.fromEnd).toBe(1);
    // Counted from the end: the screen is a suffix of the stored copy, so the
    // compacted "one" in front must not be the one picked.
    expect(forkCountFromStored(stored, target, 'through')).toBe(4);
    expect(forkCountFromStored(stored, { ...target, rowId: 2 }, 'through')).toBe(2);
  });

  it('prefers the durable row id that history carries', () => {
    const m = loadFour(true);
    const u2 = m.find((x) => x.kind === 'user' && x.text === 'second')!;
    const target = forkTarget(m, u2.id)!;
    expect(target.rowId).toBe(14);
    const stored = [row(9, 'user', 'compacted'), row(10, 'assistant', 'x'), row(11, 'user', 'first'), row(12, 'assistant', 'one'), row(14, 'user', 'second')];
    expect(forkCountFromStored(stored, target, 'before')).toBe(4);
  });

  it('ignores image-ref lines and whitespace when matching', () => {
    const m = loadFour();
    const u1 = m[0]!;
    const stored = [row(1, 'user', 'first\n@image:/tmp/a.png'), row(2, 'assistant', 'one')];
    expect(forkCountFromStored(stored, forkTarget(m, u1.id)!, 'through')).toBe(1);
  });

  it('checks where the copy actually ended', () => {
    const m = loadFour();
    const a1 = m.find((x) => x.kind === 'assistant' && x.text === 'one')!;
    const u2 = m.find((x) => x.kind === 'user' && x.text === 'second')!;
    const copied = [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'one' }];
    expect(forkLanded(copied, m, a1.id, 'through')).toBe(true);
    expect(forkLanded(copied, m, u2.id, 'before')).toBe(true);
    expect(forkLanded(copied.slice(0, 1), m, a1.id, 'through')).toBe(false);
  });
});

describe('forkAt', () => {
  const branchResult = {
    session_id: 'c1',
    stored_session_id: 'child-1',
    title: 'Plan (branch)',
    parent: 'stored-1',
    messages: [
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'one' },
    ],
  };

  function deps(over: Partial<Parameters<typeof forkAt>[2]> = {}) {
    return {
      branch: vi.fn(async () => branchResult),
      transcript: vi.fn(async () => ({
        messages: [row(1, 'user', 'first'), row(2, 'assistant', 'one'), row(3, 'user', 'second'), row(4, 'assistant', 'two')],
      })),
      history: vi.fn(async () => [] as HistoryMessage[]),
      newKey: () => 'key-1',
      ...over,
    };
  }

  beforeEach(() => {
    call.mockReset();
    call.mockResolvedValue({});
    store().reset();
    store().adoptSession({ sessionId: 's1', storedSessionId: 'stored-1', profile: 'research' });
    store().setTitle('Plan');
  });

  it('branches through a reply and switches the screen to the child', async () => {
    const m = loadFour();
    const a1 = m.find((x) => x.kind === 'assistant' && x.text === 'one')!;
    const d = deps();
    const out = await forkAt(a1.id, {}, d);

    expect(d.transcript).toHaveBeenCalledWith('stored-1', 'research');
    expect(d.branch).toHaveBeenCalledWith('s1', 2, 'key-1');
    expect(out).toEqual({ ok: true, title: 'Plan (branch)', landed: true });
    const s = store();
    expect(s.sessionId).toBe('c1');
    expect(s.storedSessionId).toBe('child-1');
    // The child lives in the parent's profile store.
    expect(s.profile).toBe('research');
    expect(s.forkedFrom).toBe('Plan');
    expect(s.forking).toBe(false);
    expect(s.messages.map((x) => ('text' in x ? x.text : x.kind))).toEqual(['first', 'one']);
  });

  it('edits in a fork: branches before the prompt and sends the edit there', async () => {
    const m = loadFour();
    const u2 = m.find((x) => x.kind === 'user' && x.text === 'second')!;
    const d = deps();
    await forkAt(u2.id, { replacement: 'second, edited' }, d);

    expect(d.branch).toHaveBeenCalledWith('s1', 2, 'key-1');
    expect(call).toHaveBeenCalledWith('prompt.submit', { session_id: 'c1', text: 'second, edited' });
    expect(store().messages.at(-1)).toMatchObject({ kind: 'user', text: 'second, edited' });
  });

  it('falls back to the on-screen count when the stored transcript cannot be read', async () => {
    const m = loadFour();
    const a2 = m.find((x) => x.kind === 'assistant' && x.text === 'two')!;
    const d = deps({ transcript: vi.fn(async () => Promise.reject(new Error('offline'))) });
    await forkAt(a2.id, {}, d);
    expect(d.branch).toHaveBeenCalledWith('s1', 4, 'key-1');
  });

  /**
   * Paging stopped at its ceiling, so the copy lacks the newest rows. Matched
   * by text from its end, "two" landed on an older repeat of it in the
   * truncated copy — a fork cut at the wrong turn.
   */
  it('prefers the on-screen count when the stored transcript stopped short', async () => {
    const m = loadFour();
    const a2 = m.find((x) => x.kind === 'assistant' && x.text === 'two')!;
    const d = deps({
      transcript: vi.fn(async () => ({
        messages: [row(1, 'user', 'zero'), row(2, 'assistant', 'two')],
        complete: false,
      })),
    });
    await forkAt(a2.id, {}, d);
    expect(d.branch).toHaveBeenCalledWith('s1', 4, 'key-1');
  });

  it('refuses mid-turn, since the stored copy lags a running turn', async () => {
    const m = loadFour();
    useSession.setState({ running: true });
    const d = deps();
    const out = await forkAt(m[1]!.id, {}, d);
    expect(out.ok).toBe(false);
    expect(d.branch).not.toHaveBeenCalled();
    expect(store().error).toMatch(/Stop the current turn/);
  });

  it('does not drag the user back when they switched sessions mid-fork', async () => {
    const m = loadFour();
    let release!: () => void;
    const d = deps({
      branch: vi.fn(
        () => new Promise<typeof branchResult>((r) => (release = () => r(branchResult))),
      ),
    });
    const pending = forkAt(m[1]!.id, {}, d);
    await vi.waitFor(() => expect(d.branch).toHaveBeenCalled());
    store().reset();
    store().adoptSession({ sessionId: 'other' });
    release();
    expect((await pending).ok).toBe(false);
    expect(store().sessionId).toBe('other');
  });

  it('reports a copy that did not end at the tapped message', async () => {
    const m = loadFour();
    const a2 = m.find((x) => x.kind === 'assistant' && x.text === 'two')!;
    const out = await forkAt(a2.id, {}, deps());
    expect(out).toMatchObject({ ok: true, landed: false });
  });
});
