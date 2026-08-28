/**
 * The session sweep.
 *
 * This module exists because the six session-scoped cases in `events.ts`
 * `toMessage` have never fired: the gateway writes an event carrying a
 * `session_id` to the transport that owns that session and nowhere else, and
 * when a phone disconnects that transport becomes a drop sentinel. Reading
 * state on a timer is the only way those notifications can exist at all.
 *
 * Everything below is a way that state could be reported wrongly, and every
 * one of them is silent from the app:
 *
 * - **Reporting states instead of transitions.** A session waiting on an
 *   answer is still waiting a minute later. A pass that reported what it saw
 *   would fire the same banner every sweep until someone answered it.
 * - **Announcing the past.** The first sight of a session is not news, or
 *   restarting the proxy would push a banner for every conversation the
 *   gateway happens to be holding.
 * - **Pruning against a pass that reached nothing.** A socket that is down
 *   answers `null`, not "no sessions". Treating the two the same forgets every
 *   watermark and re-announces the lot on recovery.
 * - **Announcing a turn that has not finished.** The message count moves when
 *   the *prompt* is appended, so a session still `working` has a higher count
 *   and nothing to say. A completion never implies a turn started, and reading
 *   from state rather than events does not change that.
 * - **Quoting the wrong message.** A turn that only ran tools has no assistant
 *   prose, and the live row's `preview` falls back to the last message with
 *   any text in it — the user's own. Pushing that hands someone their own
 *   words back as though the agent had said them.
 * - **Swallowing a reply the transcript read failed on.** The watermark has
 *   already moved by then, so a skipped push is never retried. An unreadable
 *   transcript has to fall through to a vague banner, not to silence.
 * - **Addressing the gateway handle instead of the stored id.** `id` is the
 *   8-hex live handle; REST and `/chat?session=` both take `session_key`.
 * - **Announcing work another sweep owns.** The gateway's live registry is not
 *   a list of conversations: a scheduled run and a kanban worker are sessions
 *   too, and on the machine this was written against they were most of the
 *   rows. `cron.ts` and `kanban.ts` already announce both, from records that
 *   say more than a transcript tail does.
 * - **Writing to the feed.** Deliberately nothing does: a row per reply would
 *   make the feed a second copy of every transcript, and an approval already
 *   has a sheet mounted on every screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'hermes-sessions-'));

const clearToken = vi.fn();
vi.mock('../src/config.js', () => ({
  stateDir: dir,
  getToken: () => 'tok',
  resolveToken: async () => 'tok',
  clearToken,
  upstreamHttp: 'http://127.0.0.1:9119',
  upstreamHost: '127.0.0.1:9119',
}));
vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendPush = vi.fn(async () => 1);
vi.mock('../src/push/send.js', () => ({ sendPush: (m: unknown) => sendPush(m as never) }));

let devices = 1;
vi.mock('../src/push/store.js', () => ({
  listSubscriptions: () => (devices ? [{ subscription: { endpoint: 'e' } }] : []),
}));

/** The gateway socket, which in this module is only ever asked one question. */
let live: unknown;
vi.mock('../src/push/rpc.js', () => ({
  callGateway: async () => live,
}));

type Sessions = typeof import('../src/push/sessions.js');
type Feed = typeof import('../src/push/feed.js');
let sessions: Sessions;
let feed: Feed;

/** REST responses keyed by `pathname + search`, so `?profile=` is addressable. */
let routes: Record<string, unknown>;
let requested: string[];

beforeEach(async () => {
  // Feed writes are debounced, so the previous module instance may be holding
  // a timer pointed at its own state — see the same note in `feed.test.ts`.
  feed?.flushFeed();
  rmSync(join(dir, '.hermes-cron-feed.json'), { force: true });
  routes = {};
  requested = [];
  devices = 1;
  live = { sessions: [] };
  sendPush.mockClear();
  vi.resetModules();

  vi.stubGlobal('fetch', async (url: string) => {
    const parsed = new URL(url);
    const key = parsed.pathname + parsed.search;
    requested.push(key);
    if (!(key in routes)) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      headers: { 'content-type': 'application/json' },
    });
  });

  sessions = await import('../src/push/sessions.js');
  feed = await import('../src/push/feed.js');
});

/** One live session as `session.active_list` reports it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1b2c3d4',
  session_key: 's_1',
  title: 'Weekend reading list',
  status: 'idle',
  message_count: 4,
  ...over,
});

function listing(...rows: Record<string, unknown>[]) {
  live = { sessions: rows };
}

/** A session that lives in the active profile, with a transcript. */
function transcript(...messages: { role: string; content: string }[]) {
  routes['/api/sessions/s_1'] = { id: 's_1', profile: null };
  routes['/api/sessions/s_1/messages'] = { messages };
}

const pushes = () => sendPush.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);

/** Adopt the current state, so the next pass sees only changes. */
async function seed(): Promise<void> {
  await sessions.reconcileSessions();
  feed.flushFeed();
}

describe('seeding', () => {
  it('says nothing about a session it is seeing for the first time', async () => {
    listing(row({ status: 'waiting' }), row({ session_key: 's_2', status: 'idle' }));

    await sessions.reconcileSessions();

    expect(sendPush).not.toHaveBeenCalled();
  });

  /* The whole point of the watermark being on disk. A restart that forgot
     would push a banner for every conversation the gateway is holding. */
  it('stays quiet across a restart, because the watermark is persisted', async () => {
    listing(row({ status: 'waiting' }));
    await seed();

    vi.resetModules();
    const reloaded = await import('../src/push/sessions.js');
    await reloaded.reconcileSessions();

    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe('waiting on a human', () => {
  it('pushes when a session starts waiting, and links to the conversation', async () => {
    listing(row({ status: 'working' }));
    await seed();

    routes['/api/sessions/s_1'] = { id: 's_1', profile: null };
    listing(row({ status: 'waiting' }));
    await sessions.reconcileSessions();

    expect(pushes()).toEqual([
      {
        title: 'Hem is waiting for you',
        body: 'Weekend reading list — the agent is waiting for an answer.',
        // The chat, not the feed: the sheet that releases the turn is mounted
        // on every screen, so the answer is one tap from here.
        url: '/chat?session=s_1',
        // Off the per-session tag, or a later reply would bury the thing
        // still holding the turn.
        tag: 'attention:s_1',
        kind: 'session.waiting',
      },
    ]);
  });

  /* A session is waiting for as long as nobody answers it. Repeating the
     banner every sweep is how a person learns to ignore it. */
  it('does not repeat while the session sits there', async () => {
    listing(row({ status: 'working' }));
    await seed();

    listing(row({ status: 'waiting' }));
    await sessions.reconcileSessions();
    await sessions.reconcileSessions();
    await sessions.reconcileSessions();

    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  /* The case a seen-set gets wrong: answered, ran, and blocked again. The
     second question is news, not a repeat of the first. */
  it('pushes again after the session was answered and asked something else', async () => {
    listing(row({ status: 'working' }));
    await seed();

    listing(row({ status: 'waiting' }));
    await sessions.reconcileSessions();

    // Answered: the turn resumes, and the second question is a fresh one.
    listing(row({ status: 'working', message_count: 6 }));
    await sessions.reconcileSessions();
    listing(row({ status: 'waiting', message_count: 6 }));
    await sessions.reconcileSessions();

    expect(pushes().map((p) => p.kind)).toEqual(['session.waiting', 'session.waiting']);
  });
});

describe('a turn that finished', () => {
  it('pushes the agent’s last message', async () => {
    listing(row({ status: 'working', message_count: 5 }));
    await seed();

    transcript(
      { role: 'user', content: 'anything good this week?' },
      { role: 'assistant', content: 'Three came in — the Le Guin is the one to start with.' },
    );
    listing(row({ status: 'idle', message_count: 6 }));
    await sessions.reconcileSessions();

    expect(pushes()).toEqual([
      {
        title: 'Weekend reading list',
        body: 'Three came in — the Le Guin is the one to start with.',
        url: '/chat?session=s_1',
        // The same collapse key the socket path would use, so the two replace
        // each other rather than stacking if Hermes ever delivers both.
        tag: 'session:s_1',
        kind: 'message.complete',
      },
    ]);
  });

  /* The count moves when the *prompt* is appended. A session still working is
     a turn that started, which is not news and is not an answer. */
  it('says nothing while the turn is still running', async () => {
    listing(row({ status: 'idle', message_count: 4 }));
    await seed();

    listing(row({ status: 'working', message_count: 5 }));
    await sessions.reconcileSessions();

    expect(sendPush).not.toHaveBeenCalled();
  });

  /* A turn that only ran tools has nothing to say, and the live row's own
     `preview` would have quoted the user's message back at them. */
  it('says nothing about a turn that produced no prose', async () => {
    listing(row({ status: 'working', message_count: 5 }));
    await seed();

    transcript({ role: 'user', content: 'tidy the downloads folder' });
    listing(row({ status: 'idle', message_count: 7 }));
    await sessions.reconcileSessions();

    expect(sendPush).not.toHaveBeenCalled();
  });

  /* The watermark has already moved, so a skipped push is never retried —
     an unreadable transcript must not be mistaken for an empty one. */
  it('still pushes when the transcript could not be read', async () => {
    listing(row({ status: 'working', message_count: 5 }));
    await seed();

    // The detail route resolves, the messages route does not.
    routes['/api/sessions/s_1'] = { id: 's_1', profile: null };
    listing(row({ status: 'idle', message_count: 6 }));
    await sessions.reconcileSessions();

    expect(pushes()).toEqual([
      expect.objectContaining({ body: 'The agent replied.', kind: 'message.complete' }),
    ]);
  });

  /* A turn short enough to start and finish inside one sweep interval is
     never seen as `working` by anybody here. The count is its only trace. */
  it('catches a turn that began and ended between two passes', async () => {
    listing(row({ status: 'idle', message_count: 4 }));
    await seed();

    transcript({ role: 'assistant', content: 'Done.' });
    listing(row({ status: 'idle', message_count: 6 }));
    await sessions.reconcileSessions();

    expect(pushes()).toEqual([expect.objectContaining({ body: 'Done.' })]);
  });
});

describe('addressing', () => {
  /* `id` is the gateway's 8-hex live handle and means nothing to REST or to
     `/chat?session=`. Everything has to be keyed on the stored id. */
  it('uses the stored session key, never the gateway handle', async () => {
    listing(row({ status: 'working', message_count: 5 }));
    await seed();

    transcript({ role: 'assistant', content: 'Done.' });
    listing(row({ status: 'idle', message_count: 6 }));
    await sessions.reconcileSessions();

    expect(requested.some((r) => r.includes('a1b2c3d4'))).toBe(false);
    expect(requested).toContain('/api/sessions/s_1/messages');
  });

  /* Sessions are per-profile stores and the detail route 404s across them,
     which reads as "deleted". The profile has to be found and then carried
     into the link, or the tap opens an empty chat. */
  it('finds the session’s profile and carries it into the link', async () => {
    listing(row({ status: 'working', message_count: 5 }));
    await seed();

    routes['/api/profiles'] = { profiles: [{ name: 'default' }, { name: 'research' }] };
    routes['/api/sessions/s_1?profile=research'] = { id: 's_1', profile: 'research' };
    routes['/api/sessions/s_1/messages?profile=research'] = {
      messages: [{ role: 'assistant', content: 'Found four papers.' }],
    };
    listing(row({ status: 'idle', message_count: 6 }));
    await sessions.reconcileSessions();

    expect(pushes()).toEqual([
      expect.objectContaining({
        body: 'Found four papers.',
        url: '/chat?session=s_1&profile=research',
      }),
    ]);
  });
});

describe('a pass that reached nothing', () => {
  /* `null` is the socket being down; an empty list is a real answer. Treating
     them the same forgets every watermark and re-announces the lot. */
  it('keeps its watermarks when the socket is down', async () => {
    listing(row({ status: 'waiting' }));
    await seed();

    live = null;
    await sessions.reconcileSessions();

    listing(row({ status: 'waiting' }));
    await sessions.reconcileSessions();

    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe('work another sweep already owns', () => {
  /* A cron run is a session like any other in the live registry, and
     `push/cron.ts` announces it from the run record — job name, outcome and
     the agent's reply. A second banner from here is strictly worse. */
  it('leaves a scheduled run to the cron sweep', async () => {
    const cron = { session_key: 'cron_03cfb772_20260828_063052', title: 'Suggested training' };
    listing(row({ ...cron, status: 'working', message_count: 5 }));
    await seed();

    routes['/api/sessions/cron_03cfb772_20260828_063052'] = { source: 'cron', profile: null };
    routes['/api/sessions/cron_03cfb772_20260828_063052/messages'] = {
      messages: [{ role: 'assistant', content: 'The workout is live in Garmin Connect.' }],
    };
    listing(row({ ...cron, status: 'idle', message_count: 6 }));
    await sessions.reconcileSessions();

    expect(sendPush).not.toHaveBeenCalled();
  });

  /* Only the reply is suppressed. A scheduled run that stops to ask for an
     approval is announced by nobody else, and it is holding a turn open. */
  it('still reports a scheduled run that stops to ask something', async () => {
    const cron = { session_key: 'cron_03cfb772_20260828_063052', title: 'Suggested training' };
    listing(row({ ...cron, status: 'working' }));
    await seed();

    listing(row({ ...cron, status: 'waiting' }));
    await sessions.reconcileSessions();

    expect(pushes()).toEqual([expect.objectContaining({ kind: 'session.waiting' })]);
  });

  /* A kanban worker has no name prefix, so this one is caught by `source` on
     the row the profile lookup already fetches — no extra request. */
  it('leaves a kanban worker to the board sweep', async () => {
    listing(row({ status: 'working', message_count: 5 }));
    await seed();

    routes['/api/sessions/s_1'] = { source: 'kanban', profile: null };
    routes['/api/sessions/s_1/messages'] = {
      messages: [{ role: 'assistant', content: 'Placed both holds.' }],
    };
    listing(row({ status: 'idle', message_count: 6 }));
    await sessions.reconcileSessions();

    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe('the feed', () => {
  /* Deliberately empty. A row per reply would make the feed a second copy of
     every transcript; an approval already has an always-mounted sheet. */
  it('records nothing, whatever happens', async () => {
    listing(row({ status: 'working', message_count: 5 }));
    await seed();

    transcript({ role: 'assistant', content: 'Done.' });
    listing(row({ status: 'idle', message_count: 6 }));
    await sessions.reconcileSessions();

    listing(row({ status: 'waiting', message_count: 6 }));
    await sessions.reconcileSessions();

    feed.flushFeed();
    expect(sendPush).toHaveBeenCalledTimes(2);
    expect(feed.listEntries()).toHaveLength(0);
  });

  /* The sweep still has to run with no phone registered, or the first device
     to subscribe is told about a backlog it never missed. */
  it('keeps watermarks current with no device subscribed', async () => {
    devices = 0;
    listing(row({ status: 'working', message_count: 5 }));
    await seed();

    transcript({ role: 'assistant', content: 'Done.' });
    listing(row({ status: 'idle', message_count: 6 }));
    await sessions.reconcileSessions();

    devices = 1;
    await sessions.reconcileSessions();

    expect(sendPush).not.toHaveBeenCalled();
  });
});
