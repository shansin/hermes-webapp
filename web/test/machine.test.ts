/**
 * The Machine screen's readings.
 *
 * A screen whose job is to say what is wrong fails worst by saying nothing is:
 * an unknown platform state read as connected, a stale heartbeat read as a
 * running gateway, a payload missing a key that blanks the screen. Fixtures
 * are the shapes `/api/status` (`gateway_platforms`, written by
 * `gateway/status.py`), `/api/pairing` and `/api/actions/<name>/status`
 * actually return.
 */
import { describe, expect, it } from 'vitest';
import {
  actionOutcome,
  formatBytes,
  formatUptime,
  gatewaySummary,
  loadTone,
  pairingFrom,
  pairingMinutesLeft,
  platformRows,
  platformTone,
} from '../src/lib/machine';

describe('platform health', () => {
  const status = {
    gateway_running: true,
    gateway_state: 'running',
    gateway_platforms: {
      telegram: { state: 'connected', updated_at: '2026-11-12T00:00:00Z' },
      discord: { state: 'retrying', error_code: 'gateway_timeout', retrying_since: '2026-11-12T00:01:00Z' },
      slack: { state: 'fatal', error_message: 'invalid_auth', needs_attention: true },
      'research:telegram': { state: 'connected' },
      webhook: { state: 'disabled' },
    },
  };

  it('puts the broken ones first and says why', () => {
    const rows = platformRows(status);
    expect(rows.map((r) => [r.key, r.tone])).toEqual([
      ['slack', 'error'],
      ['discord', 'warn'],
      ['research:telegram', 'ok'],
      ['telegram', 'ok'],
      ['webhook', 'off'],
    ]);
    expect(rows[0]).toMatchObject({ label: 'Slack', detail: 'invalid_auth' });
    expect(rows[1]).toMatchObject({ detail: 'Error: gateway_timeout' });
  });

  it('splits a folded-in profile off the platform', () => {
    expect(platformRows(status).find((r) => r.key === 'research:telegram')).toMatchObject({
      profile: 'research',
      platform: 'telegram',
      label: 'Telegram',
    });
  });

  it('never reads an unknown or missing state as healthy', () => {
    expect(platformTone('', false)).toBe('error');
    expect(platformTone('something-new', false)).toBe('error');
    expect(platformTone('connected', true)).toBe('error');
    expect(platformTone('Connected', false)).toBe('ok');
  });

  it('survives a payload without the map', () => {
    expect(platformRows(null)).toEqual([]);
    expect(platformRows({ gateway_platforms: [] })).toEqual([]);
    expect(platformRows({ gateway_platforms: { x: null, y: 'nope' } })).toEqual([]);
  });
});

describe('the gateway itself', () => {
  it('is healthy only running and in a running state', () => {
    expect(gatewaySummary({ gateway_running: true, gateway_state: 'running' }).tone).toBe('ok');
    expect(gatewaySummary({ gateway_running: false, gateway_exit_reason: 'crashed' })).toMatchObject({
      tone: 'error',
      state: 'stopped',
      detail: 'crashed',
    });
  });

  /* Hermes reports a live PID with a stale heartbeat separately precisely so
     a wedged loop is not mistaken for a working gateway. */
  it('flags a live process whose heartbeat stopped', () => {
    const g = gatewaySummary({ gateway_running: true, gateway_state: 'running', gateway_heartbeat_stale_s: 312.4 });
    expect(g.tone).toBe('warn');
    expect(g.detail).toMatch(/312s/);
  });
});

describe('pairing', () => {
  it('tags every row with its store, and keeps a legacy entry’s empty id', () => {
    const { pending, approved } = pairingFrom(
      {
        pending: [
          { platform: 'telegram', request_id: '0123456789abcdef', user_id: '42', user_name: 'Alice', age_minutes: 12 },
          { platform: 'discord', request_id: '', user_id: '7', user_name: '', age_minutes: 58 },
          { request_id: 'x' },
        ],
        approved: [{ platform: 'telegram', user_id: '9', user_name: 'Bob', approved_at: 1_700_000_000 }],
      },
      'research',
    );
    expect(pending).toEqual([
      { profile: 'research', platform: 'telegram', requestId: '0123456789abcdef', userId: '42', userName: 'Alice', ageMinutes: 12 },
      { profile: 'research', platform: 'discord', requestId: '', userId: '7', userName: '', ageMinutes: 58 },
    ]);
    expect(approved).toEqual([
      { profile: 'research', platform: 'telegram', userId: '9', userName: 'Bob', approvedAt: 1_700_000_000 },
    ]);
  });

  it('survives an empty or odd body', () => {
    expect(pairingFrom(undefined, null)).toEqual({ pending: [], approved: [] });
    expect(pairingFrom({ pending: 'nope' }, null).pending).toEqual([]);
  });

  it('counts down the hour a request lives', () => {
    expect(pairingMinutesLeft(0)).toBe(60);
    expect(pairingMinutesLeft(55)).toBe(5);
    expect(pairingMinutesLeft(75)).toBe(0);
  });
});

describe('background actions', () => {
  it('reads running, success, failure and the in-between', () => {
    expect(actionOutcome(undefined).state).toBe('running');
    expect(actionOutcome({ running: true }).state).toBe('running');
    expect(actionOutcome({ running: false, exit_code: 0 })).toEqual({ state: 'ok', label: 'Finished' });
    expect(actionOutcome({ running: false, exit_code: 1 })).toEqual({ state: 'failed', label: 'Failed (exit 1)' });
    expect(actionOutcome({ running: false, exit_code: null }).state).toBe('unknown');
  });
});

describe('numbers', () => {
  it('formats bytes and uptime', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(64 * 1024 ** 3)).toBe('64 GB');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatUptime(90)).toBe('1m');
    expect(formatUptime(3 * 3600 + 120)).toBe('3h 2m');
    expect(formatUptime(2 * 86400 + 5 * 3600)).toBe('2d 5h');
  });

  it('colours load by how worried to be', () => {
    expect(loadTone(40)).toBe('ok');
    expect(loadTone(80)).toBe('warn');
    expect(loadTone(95)).toBe('error');
    expect(loadTone(undefined)).toBe('off');
  });
});

describe('backup download', () => {
  /* The archive is a path under the profile's own backups folder, and the
     route checks it against *that* profile's folder — so both travel. */
  it('carries the archive path encoded and the profile it belongs to', async () => {
    const { backupDownloadUrl } = await import('../src/api/machine');
    expect(backupDownloadUrl('/home/u/.hermes/profiles/research/backups/hermes-backup 1.zip', 'research')).toBe(
      '/api/ops/backup/download?archive=%2Fhome%2Fu%2F.hermes%2Fprofiles%2Fresearch%2Fbackups%2Fhermes-backup%201.zip&profile=research',
    );
  });
});
