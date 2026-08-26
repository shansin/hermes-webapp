/**
 * Gateway event → lock-screen banner.
 *
 * `toMessage` is where the firehose is filtered down to the handful of things
 * worth waking a phone for. The tests below are mostly about what it must
 * *not* send: a banner claiming a reply that never happened is worse than
 * silence, and a collapse key that buries a pending approval is worse still.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  getToken: () => 'tok',
  resolveToken: async () => 'tok',
  upstreamWs: 'ws://127.0.0.1:9119',
  upstreamHost: '127.0.0.1:9119',
  stateDir: '/tmp',
  config: { PUSH_ENABLED: false },
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/push/send.js', () => ({
  sendPush: vi.fn(async () => 0),
  pushEnabled: () => false,
}));
vi.mock('../src/push/cron.js', () => ({ scheduleCronReconcile: vi.fn() }));
vi.mock('../src/push/store.js', () => ({ listSubscriptions: () => [] }));

const { toMessage } = await import('../src/push/events.js');

describe('events that produce nothing', () => {
  it.each([
    'message.delta',
    'reasoning.delta',
    'thinking.delta',
    'tool.start',
    'tool.complete',
    'status.update',
    'session.usage',
    'gateway.ready',
    'sessions.changed',
  ])('%s stays off the lock screen', (type) => {
    expect(toMessage(type, { text: 'noise' }, 's1')).toBeNull();
  });

  /**
   * The event carries nothing at all on the wire — no job, no status, no
   * session — so anything built from it could only say "something happened".
   * `push/cron.ts` fetches the run and sends its own.
   */
  it('cron.changed is left to the reconcile pass', () => {
    expect(toMessage('cron.changed', {}, '')).toBeNull();
  });
});

describe('message.complete', () => {
  it('sends the reply as the body', () => {
    const m = toMessage('message.complete', { text: 'All three tests pass.' }, 's1');
    expect(m).toMatchObject({ title: 'Hem', body: 'All three tests pass.' });
  });

  it('deep-links to the conversation', () => {
    expect(toMessage('message.complete', { text: 'hi' }, 'abc123')!.url).toBe(
      '/chat?session=abc123',
    );
  });

  it('escapes a session id into the query string', () => {
    expect(toMessage('message.complete', { text: 'hi' }, 'a b&c')!.url).toBe(
      '/chat?session=a%20b%26c',
    );
  });

  it('falls back to /chat with no session', () => {
    expect(toMessage('message.complete', { text: 'hi' }, null)!.url).toBe('/chat');
  });

  /**
   * A stopped or errored turn is not a reply. Announcing it as one puts an
   * answer on the lock screen that does not exist.
   */
  it.each(['interrupted', 'cancelled', 'canceled', 'error', 'failed'])(
    'stays silent on status %s',
    (status) => {
      expect(toMessage('message.complete', { text: 'partial', status }, 's1')).toBeNull();
    },
  );

  it('still sends on an unrecognised status', () => {
    expect(toMessage('message.complete', { text: 'done', status: 'ok' }, 's1')).not.toBeNull();
  });

  it('says nothing for a turn that only ran tools', () => {
    expect(toMessage('message.complete', { text: '   ' }, 's1')).toBeNull();
    expect(toMessage('message.complete', {}, 's1')).toBeNull();
  });
});

describe('reply previews', () => {
  const body = (text: string) => toMessage('message.complete', { text }, 's1')?.body;

  it('strips markdown headings and bullets', () => {
    expect(body('## Summary\n- one\n- two')).toBe('Summary one two');
  });

  it('strips blockquote markers', () => {
    expect(body('> quoted line')).toBe('quoted line');
  });

  it('collapses newlines into spaces', () => {
    expect(body('line one\n\nline two')).toBe('line one line two');
  });

  it('replaces a fenced code block with a marker', () => {
    expect(body('Here:\n```js\nconst x = 1;\n```\ndone')).toBe('Here: [code] done');
  });

  it('truncates to something a lock screen will actually show', () => {
    const preview = body('x'.repeat(500))!;
    expect(preview.length).toBeLessThanOrEqual(140);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('leaves a short reply exactly as written', () => {
    expect(body('Done.')).toBe('Done.');
  });

  it('says nothing when a reply is only markdown scaffolding', () => {
    expect(body('###')).toBeUndefined();
  });
});

describe('approvals', () => {
  it('names the tool and the command', () => {
    const m = toMessage('approval.request', { tool: 'Bash', command: 'rm -rf build' }, 's1')!;
    expect(m.title).toBe('Approval needed');
    expect(m.body).toBe('Bash — rm -rf build');
  });

  it('falls back to the tool alone', () => {
    expect(toMessage('approval.request', { tool: 'Write' }, 's1')!.body).toBe(
      'Write is waiting for approval',
    );
  });

  it('falls back again when even the tool is missing', () => {
    expect(toMessage('approval.request', {}, 's1')!.body).toBe('A tool is waiting for approval');
  });

  it('bounds the body so a long command cannot run away', () => {
    const m = toMessage('approval.request', { tool: 'Bash', command: 'x'.repeat(400) }, 's1')!;
    expect(m.body.length).toBeLessThanOrEqual(160);
  });

  /**
   * A clarify blocks the turn exactly as hard as an approval, and the gateway
   * gives up after an hour — so one nobody saw is a conversation that quietly
   * decided for itself.
   */
  it('wakes a phone for a question the agent is parked on', () => {
    const m = toMessage('clarify.request', { request_id: 'r1', question: 'Which source?' }, 's1')!;
    expect(m.title).toBe('Question from Hem');
    expect(m.body).toBe('Which source?');
  });

  it('leads a batch with its first question and counts the rest', () => {
    const m = toMessage(
      'clarify.request',
      {
        request_id: 'r2',
        questions: [
          { qid: 'q1', question: 'Which source?' },
          { qid: 'q2', question: 'How often?' },
        ],
      },
      's1',
    )!;
    expect(m.body).toBe('Which source? (+1 more)');
  });

  it('still says something when the question text is missing', () => {
    expect(toMessage('clarify.request', { request_id: 'r3' }, 's1')!.body).toBe(
      'The agent needs an answer',
    );
  });

  it('does not let a later banner bury a question still holding the turn', () => {
    const clarify = toMessage('clarify.request', { request_id: 'r4', question: 'Which?' }, 's1')!;
    const complete = toMessage('message.complete', { text: 'done' }, 's1')!;
    const approval = toMessage('approval.request', { tool: 'Bash' }, 's1')!;
    expect(clarify.tag).not.toBe(complete.tag);
    expect(clarify.tag).not.toBe(approval.tag);
  });

  /**
   * The one thing that must never be collapsed away: an approval blocks the
   * agent until it is answered, so a later "task finished" banner replacing it
   * would hide the only notification that still needs the user.
   */
  it('does not share a collapse key with ordinary events', () => {
    const approval = toMessage('approval.request', { tool: 'Bash' }, 's1')!;
    const complete = toMessage('message.complete', { text: 'done' }, 's1')!;
    expect(approval.tag).not.toBe(complete.tag);
  });
});

describe('collapse keys', () => {
  /**
   * One row per conversation. Three things finishing in the same session
   * should leave one banner showing the latest, not three stacked rows.
   */
  it('collapses every non-approval event in a session onto one row', () => {
    const tags = [
      toMessage('message.complete', { text: 'reply' }, 's1')!.tag,
      toMessage('background.complete', { title: 'Build' }, 's1')!.tag,
      toMessage('subagent.complete', { name: 'Explore' }, 's1')!.tag,
      toMessage('notification.show', { text: 'note' }, 's1')!.tag,
    ];
    expect(new Set(tags).size).toBe(1);
  });

  it('keeps separate conversations on separate rows', () => {
    const a = toMessage('message.complete', { text: 'reply' }, 's1')!.tag;
    const b = toMessage('message.complete', { text: 'reply' }, 's2')!.tag;
    expect(a).not.toBe(b);
  });
});

describe('background and subagent completion', () => {
  it('names the background task', () => {
    expect(toMessage('background.complete', { title: 'Nightly build' }, 's1')!.body).toBe(
      'Nightly build finished',
    );
  });

  it('falls back when the task is unnamed', () => {
    expect(toMessage('background.complete', {}, 's1')!.body).toBe('Background task finished');
  });

  it('names the subagent', () => {
    expect(toMessage('subagent.complete', { name: 'Explore' }, 's1')!.body).toBe(
      'Explore finished',
    );
  });
});

describe('notification.show', () => {
  it('prefers text over message', () => {
    expect(toMessage('notification.show', { text: 'a', message: 'b' }, 's1')!.body).toBe('a');
  });

  it('accepts message when text is absent', () => {
    expect(toMessage('notification.show', { message: 'b' }, 's1')!.body).toBe('b');
  });

  it('stays silent with neither', () => {
    expect(toMessage('notification.show', {}, 's1')).toBeNull();
  });
});

describe('payload robustness', () => {
  /**
   * The gateway has no published schema, so every field is treated as
   * possibly-absent and possibly the wrong type. None of these may throw.
   */
  it.each([
    ['message.complete', { text: 42 }],
    ['message.complete', { text: null }],
    ['approval.request', { tool: [], command: {} }],
    ['background.complete', { title: false }],
    ['subagent.complete', { name: 0 }],
    ['notification.show', { text: {} }],
  ])('survives a wrongly-typed payload on %s', (type, payload) => {
    expect(() => toMessage(type, payload as Record<string, unknown>, 's1')).not.toThrow();
  });
});
