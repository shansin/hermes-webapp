/**
 * Which profile a skills call addresses, and what install actually sends.
 *
 * Skills are per-profile: the files live in that profile's `skills/` directory
 * and the enabled set is `skills.disabled` in that profile's config. Omitting
 * `?profile=` means "whichever is active", so before the picker existed the
 * screen could only ever be right by accident — and wrong invisibly, since a
 * switch flipped in front of you while looking at `research` reported success
 * and edited `default`.
 *
 * The install body is a separate trap with a louder failure: the endpoint's
 * required field is `identifier` (`skills-sh/anthropics/skills/pdf`), not the
 * display `name` — one search for `pdf` returns that same name from three
 * different repos, so the name addresses nothing.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useInstallSkill, useToggleSkill, withProfile } from '../src/api/hub';

describe('withProfile', () => {
  it('leaves the path alone for the active profile', () => {
    expect(withProfile('/api/skills')).toBe('/api/skills');
    expect(withProfile('/api/skills', null)).toBe('/api/skills');
    expect(withProfile('/api/skills', '')).toBe('/api/skills');
  });

  it('appends the profile, joining an existing query with &', () => {
    expect(withProfile('/api/skills', 'research')).toBe('/api/skills?profile=research');
    expect(withProfile('/api/skills/hub/search?q=pdf', 'research')).toBe(
      '/api/skills/hub/search?q=pdf&profile=research',
    );
  });

  it('encodes a name that would otherwise change the query', () => {
    expect(withProfile('/api/skills', 'a&profile=b')).toBe('/api/skills?profile=a%26profile%3Db');
  });
});

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) };
};

describe('useInstallSkill', () => {
  it('posts the identifier, not the name', async () => {
    const { result } = renderHook(() => useInstallSkill(), { wrapper });
    await result.current.mutateAsync({ identifier: 'skills-sh/anthropics/skills/pdf' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const { url, body } = lastCall();
    expect(url).toBe('/api/skills/hub/install');
    expect(body).toEqual({ identifier: 'skills-sh/anthropics/skills/pdf' });
    expect(body).not.toHaveProperty('name');
  });

  it('installs into the profile being looked at', async () => {
    const { result } = renderHook(() => useInstallSkill(), { wrapper });
    await result.current.mutateAsync({ identifier: 'skills-sh/openai/skills/pdf', profile: 'research' });
    expect(lastCall().url).toBe('/api/skills/hub/install?profile=research');
  });
});

describe('useToggleSkill', () => {
  it('names the profile in the body, where this endpoint takes it', async () => {
    const { result } = renderHook(() => useToggleSkill(), { wrapper });
    await result.current.mutateAsync({ name: 'computer-use', enabled: false, profile: 'research' });
    expect(lastCall().body).toEqual({ name: 'computer-use', enabled: false, profile: 'research' });
  });

  it('omits the profile entirely for the active one, rather than sending null', async () => {
    // A literal `profile: null` is a different request from an absent key on
    // some Hermes builds; the active profile has always been the bare call.
    const { result } = renderHook(() => useToggleSkill(), { wrapper });
    await result.current.mutateAsync({ name: 'computer-use', enabled: true, profile: null });
    expect(lastCall().body).toEqual({ name: 'computer-use', enabled: true });
  });
});
