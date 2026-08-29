/**
 * The MoA section against the payloads it will actually meet.
 *
 * `GET /api/model/moa` is a route a Hermes can predate, and its body reaches
 * three levels deep — `presets[name].reference_models[i].provider` — which is
 * three chances to reach through a key that is not there. The throw would not
 * be contained to this card: it unmounts the route, and `ErrorBoundary` turns
 * that into a blank Models screen. The section is at the bottom of a screen
 * whose top half is what people came for, so it must never be the reason the
 * default-model picker is unreachable.
 *
 * The other half is the warning itself. It exists to predict a specific
 * runtime failure — an aggregator whose provider has no credentials, which
 * ends every turn on the profile — and it has to be silent in the two states
 * where it would be a lie: before the provider catalogue has loaded, and on a
 * profile that is not routed through MoA at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

/** What each hook "answered" for this test. */
let moa: unknown;
let main: unknown;
let providers: { slug: string }[] | undefined;

vi.mock('../src/api/hub', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useDefaultModel: () => ({ data: { main, tasks: [] }, isLoading: false }),
}));

vi.mock('../src/api/gateway', () => ({
  fetchModelOptions: () => Promise.resolve({ providers: providers ?? [] }),
}));

vi.mock('../src/api/client', () => ({
  api: { get: () => Promise.resolve(moa), put: vi.fn() },
}));

vi.mock('../src/store/ui', () => ({
  useUi: (pick: (s: unknown) => unknown) => pick({ toast: vi.fn() }),
}));
vi.mock('../src/lib/haptics', () => ({ buzz: vi.fn() }));

import { MoaSection } from '../src/components/hub/MoaSection';

afterEach(cleanup);

const show = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(MoaSection, { profile: 'fitness' }) as ReactNode,
    ),
  );
};

/** The factory preset, which is what an unconfigured profile answers with. */
const FACTORY = {
  default_preset: 'default',
  active_preset: '',
  presets: {
    default: {
      reference_models: [
        { provider: 'openai-codex', model: 'gpt-5.5', enabled: true },
        { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', enabled: true },
      ],
      aggregator: { provider: 'openrouter', model: 'anthropic/claude-opus-4.8' },
      max_tokens: 4096,
      enabled: true,
    },
  },
};

describe('MoA section against an unexpected payload', () => {
  it('renders when the route answers with an empty object', async () => {
    moa = {};
    main = { provider: 'custom', model: 'ornith-1.5:35b' };
    providers = [{ slug: 'custom' }];
    expect(() => show()).not.toThrow();
    expect(await screen.findByText('Not in use')).toBeTruthy();
  });

  /* A preset present but carrying none of its keys — the shape that blanks. */
  it('renders a preset with no slots on it', async () => {
    moa = { default_preset: 'default', presets: { default: {} } };
    main = { provider: 'moa', model: 'default' };
    providers = [{ slug: 'anthropic' }];
    expect(() => show()).not.toThrow();
    expect(await screen.findByText(/In use/)).toBeTruthy();
    // An aggregator with no provider is not a credential gap — it is unset,
    // and claiming a missing key for an empty slot would be a false alarm.
    expect(screen.queryByText(/No credentials found/)).toBeNull();
  });

  it('survives a null body', async () => {
    moa = null;
    main = { provider: 'custom', model: 'x' };
    providers = [];
    expect(() => show()).not.toThrow();
  });
});

describe('the credential warning', () => {
  /* The exact state that failed a cron job on 2026-08-29. */
  it('calls out an aggregator with no credentials when the profile is on MoA', async () => {
    moa = FACTORY;
    main = { provider: 'moa', model: 'default' };
    providers = [{ slug: 'custom:bigrig' }, { slug: 'anthropic' }];
    show();
    expect(await screen.findByText(/aggregator is the model that answers/)).toBeTruthy();
  });

  /* Advisors failing degrades a turn; the wording must not claim more. */
  it('reports advisors separately when only they are missing keys', async () => {
    moa = {
      presets: {
        default: {
          reference_models: [{ provider: 'openrouter', model: 'a', enabled: true }],
          aggregator: { provider: 'anthropic', model: 'claude-opus-4.8' },
        },
      },
      default_preset: 'default',
    };
    main = { provider: 'moa', model: 'default' };
    providers = [{ slug: 'anthropic' }];
    show();
    expect(await screen.findByText(/Turns\s+still run/)).toBeTruthy();
  });

  /*
   * A preset nothing runs is not a problem to warn about, and this section is
   * on every install's Models screen.
   */
  it('stays quiet on a profile that is not routed through MoA', async () => {
    moa = FACTORY;
    main = { provider: 'custom', model: 'ornith-1.5:35b' };
    providers = [{ slug: 'custom' }];
    show();
    expect(await screen.findByText('Not in use')).toBeTruthy();
    expect(screen.queryByText(/No credentials found/)).toBeNull();
  });

  /*
   * Before the catalogue resolves there is no evidence, and a warning that
   * flashes on every load teaches people to ignore it.
   */
  it('stays quiet while the provider list is empty', async () => {
    moa = FACTORY;
    main = { provider: 'moa', model: 'default' };
    providers = [];
    show();
    expect(await screen.findByText(/In use/)).toBeTruthy();
    expect(screen.queryByText(/No credentials found/)).toBeNull();
  });
});

describe('which preset is shown', () => {
  /*
   * `model.default` under `provider: moa` names the preset, so a profile
   * pointed at one preset must not be shown another's models — the config it
   * displays would be one nothing runs.
   */
  it('follows the preset the profile is pinned to, not the default one', async () => {
    moa = {
      default_preset: 'default',
      presets: {
        default: {
          reference_models: [{ provider: 'anthropic', model: 'sonnet' }],
          aggregator: { provider: 'anthropic', model: 'claude-opus-4.8' },
        },
        cheap: {
          reference_models: [{ provider: 'copilot', model: 'gpt-5.5' }],
          aggregator: { provider: 'copilot', model: 'gpt-5-mini' },
        },
      },
    };
    main = { provider: 'moa', model: 'cheap' };
    providers = [{ slug: 'copilot' }, { slug: 'anthropic' }];
    show();
    expect(await screen.findByText(/In use — preset "cheap"/)).toBeTruthy();
    expect(screen.getByText(/gpt-5-mini/)).toBeTruthy();
  });

  /* A pin naming a preset that no longer exists must fall back, not blank. */
  it('falls back to the default preset when the pinned one is gone', async () => {
    moa = FACTORY;
    main = { provider: 'moa', model: 'deleted-preset' };
    providers = [{ slug: 'anthropic' }];
    expect(() => show()).not.toThrow();
    expect(await screen.findByText(/preset "default"/)).toBeTruthy();
  });
});
