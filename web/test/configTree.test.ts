/**
 * The config inspector's flattening and redaction.
 *
 * Both halves fail quietly and in opposite directions. Redact too little and a
 * credential is rendered onto a phone screen; redact too much and the inspector
 * hides ordinary numbers, at which point nobody believes what it shows them
 * either. The second failure is the one that actually happened: an earlier rule
 * matched any leaf containing `key`, which redacted `voice.record_key` — a
 * push-to-talk keybinding — and `max_tokens` along with it.
 *
 * The names below are taken from a real Hermes 0.20.4 config.
 */
import { describe, expect, it } from 'vitest';
import {
  displayValue,
  flattenSection,
  isSecretLeaf,
  searchConfig,
} from '../src/lib/configTree';

describe('deciding what is a secret', () => {
  it('redacts credentials, by whole name and by suffix', () => {
    expect(isSecretLeaf('api_key', 'sk-live-abc')).toBe(true);
    expect(isSecretLeaf('password', 'hunter2')).toBe(true);
    expect(isSecretLeaf('openai_api_key', 'sk-abc')).toBe(true);
    expect(isSecretLeaf('github_token', 'ghp_abc')).toBe(true);
    expect(isSecretLeaf('client_secret', 'abc')).toBe(true);
  });

  /**
   * Every one of these is a real leaf name from a stock config, and every one
   * of them contains a word the naive rule matches on.
   */
  it('leaves settings that merely sound like secrets alone', () => {
    for (const name of [
      'record_key', // a push-to-talk keybinding
      'max_tokens',
      'listing_max_tokens',
      'threshold_tokens',
      'keyword',
      'show_token_analytics',
      'spinner_token_flow',
      'min_secret_chars',
      'redact_secrets',
      'keyless_fallback',
    ]) {
      expect(isSecretLeaf(name, 'something')).toBe(false);
    }
  });

  /**
   * `*_env` names an environment variable. Redacting it hides which variable
   * to go and set, which is the one thing the row is there to tell you.
   */
  it('does not redact the name of an environment variable', () => {
    expect(isSecretLeaf('api_key_env', 'OPENAI_API_KEY')).toBe(false);
    expect(isSecretLeaf('access_token_env', 'GITHUB_TOKEN')).toBe(false);
  });

  it('has nothing to hide in a non-string or an empty value', () => {
    expect(isSecretLeaf('api_key', '')).toBe(false);
    expect(isSecretLeaf('api_key', null)).toBe(false);
    expect(isSecretLeaf('token', 42)).toBe(false);
    expect(isSecretLeaf('password', true)).toBe(false);
  });
});

describe('flattening a section', () => {
  it('walks nested objects into dotted paths', () => {
    const rows = flattenSection({ retry: { max: 3, backoff: { ms: 500 } }, on: true });
    expect(rows.map((r) => r.path).sort()).toEqual(['on', 'retry.backoff.ms', 'retry.max']);
  });

  /**
   * "Set to nothing" is an answer. Dropping empties would make the inspector
   * claim the key does not exist.
   */
  it('keeps empty objects and arrays as leaves', () => {
    const rows = flattenSection({ providers: {}, fallbacks: [] });
    expect(rows).toHaveLength(2);
    expect(displayValue(rows.find((r) => r.path === 'providers')!)).toBe('{}');
    expect(displayValue(rows.find((r) => r.path === 'fallbacks')!)).toBe('[]');
  });

  it('reads the redaction rule from the leaf, not the whole path', () => {
    const rows = flattenSection({ openai: { api_key: 'sk-live', max_tokens: 4096 } });
    expect(rows.find((r) => r.path === 'openai.api_key')!.secret).toBe(true);
    expect(rows.find((r) => r.path === 'openai.max_tokens')!.secret).toBe(false);
  });
});

describe('what reaches the screen', () => {
  it('never renders a redacted value', () => {
    const [row] = flattenSection({ api_key: 'sk-live-do-not-print' });
    expect(displayValue(row!)).toBe('••••••••');
    expect(displayValue(row!)).not.toContain('sk-live');
  });

  it('renders null as an em dash rather than the word', () => {
    const [row] = flattenSection({ ceiling: null });
    expect(displayValue(row!)).toBe('—');
  });
});

describe('searching', () => {
  const config = {
    cron: { enabled: true, timeout_s: 30 },
    display: { theme: 'dark', density: 'cosy' },
  };

  it('returns every section when the query is empty', () => {
    expect(searchConfig(config, '').map((s) => s.name)).toEqual(['cron', 'display']);
  });

  /**
   * A section name matching keeps all of its rows. Filtering them by the same
   * needle would show `cron` with only the rows that say `cron` twice.
   */
  it('keeps a whole section when its name matches', () => {
    const out = searchConfig(config, 'cron');
    expect(out).toHaveLength(1);
    expect(out[0]!.rows).toHaveLength(2);
  });

  it('otherwise keeps only the rows whose path matches', () => {
    const out = searchConfig(config, 'theme');
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('display');
    expect(out[0]!.rows.map((r) => r.path)).toEqual(['theme']);
  });

  it('drops sections with nothing left', () => {
    expect(searchConfig(config, 'nothing-like-this')).toEqual([]);
  });
});
