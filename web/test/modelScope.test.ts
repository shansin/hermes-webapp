/**
 * Which profile's models a Models-screen call reads and writes.
 *
 * Model config is per-profile — `model.provider` / `model.default` live in
 * that profile's own `config.yaml`, and `custom_providers` does too, so even
 * the list of models that *exist* differs between profiles. Every endpoint
 * here takes `?profile=` and an omitted one means the **active** profile,
 * which is not the same thing as the profile on screen.
 *
 * That gap is invisible in the worst way. The screen showed a heading, a
 * model, and a success toast; the write landed in another agent's config. The
 * agent you were looking at kept its old model and the one you were not
 * looking at silently changed.
 *
 * The catalogue has a second trap on top of that. The gateway's
 * `model.options` RPC takes no profile at all — it answers for whatever
 * profile the socket runs as — so asking it for another profile's models
 * returns this profile's list with no error anywhere. Only the REST route is
 * profile-aware, which is why naming a profile switches transport.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hermesCall = vi.fn();
const apiGet = vi.fn();

vi.mock('../src/ws/client', () => ({
  hermes: { call: (...a: unknown[]) => hermesCall(...a) },
  CONTROL_TIMEOUT_MS: 15_000,
}));
vi.mock('../src/api/client', () => ({
  api: { get: (...a: unknown[]) => apiGet(...a) },
}));
vi.mock('../src/api/commands', () => ({ dispatchCommand: vi.fn() }));

const OPTIONS = { providers: [{ slug: 'moa', name: 'Mixture of Agents', models: ['default'] }] };

beforeEach(() => {
  hermesCall.mockReset().mockResolvedValue(OPTIONS);
  apiGet.mockReset().mockResolvedValue(OPTIONS);
});

describe('fetchModelOptions', () => {
  it('uses the open socket when no profile is named', async () => {
    const { fetchModelOptions } = await import('../src/api/gateway');
    await fetchModelOptions();
    expect(hermesCall).toHaveBeenCalledTimes(1);
    expect(apiGet).not.toHaveBeenCalled();
  });

  /* The RPC has no profile parameter, so sending one over the socket would be
     ignored and the caller handed the wrong profile's catalogue — a picker
     that looks right and offers models that profile cannot reach. */
  it('switches to the profile-aware REST route when a profile is named', async () => {
    const { fetchModelOptions } = await import('../src/api/gateway');
    await fetchModelOptions({ profile: 'fitness' });
    expect(hermesCall).not.toHaveBeenCalled();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet.mock.calls[0]![0]).toBe('/api/model/options?profile=fitness');
  });

  it('carries refresh over either transport', async () => {
    const { fetchModelOptions } = await import('../src/api/gateway');
    await fetchModelOptions({ refresh: true });
    expect(hermesCall.mock.calls[0]![1]).toEqual({ refresh: true });

    await fetchModelOptions({ refresh: true, profile: 'research' });
    expect(apiGet.mock.calls[0]![0]).toBe('/api/model/options?profile=research&refresh=true');
  });

  it('encodes a profile name that needs it', async () => {
    const { fetchModelOptions } = await import('../src/api/gateway');
    await fetchModelOptions({ profile: 'my profile&x=1' });
    expect(apiGet.mock.calls[0]![0]).toBe('/api/model/options?profile=my+profile%26x%3D1');
  });
});

describe('withProfile on the model routes', () => {
  /* The same helper the cron and session routes use; asserted here against the
     exact paths the Models screen calls, because those were the ones passing
     nothing at all. */
  it('scopes the read and both writes', async () => {
    const { withProfile } = await import('../src/api/hub');
    expect(withProfile('/api/model/auxiliary', 'fitness')).toBe(
      '/api/model/auxiliary?profile=fitness',
    );
    expect(withProfile('/api/model/set', 'fitness')).toBe('/api/model/set?profile=fitness');
  });

  it('still means the active profile when nothing is chosen', async () => {
    const { withProfile } = await import('../src/api/hub');
    expect(withProfile('/api/model/set', null)).toBe('/api/model/set');
  });
});
