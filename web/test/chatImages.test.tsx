/**
 * A picture in a reply reaches the DOM or it doesn't, and when it doesn't
 * there is nothing to see — which is the whole bug this guards.
 *
 * react-markdown sanitizes every URL it renders, and its default transform
 * allows http, https, mailto, irc and xmpp. `file://` — the scheme Hermes
 * writes after a screen capture — is blanked, so the `img` component was
 * handed an empty `src` with no trace of what it had been. Nothing throws,
 * nothing logs; the screenshot is simply absent. So the assertion here is that
 * the transform still lets a local image through and that it turns into an
 * authenticated file read rather than a request the browser cannot make.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Markdown } from '../src/components/chat/Markdown';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ dataUrl: 'data:image/png;base64,AAAA' }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function Wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const urls = () => fetchMock.mock.calls.map(([url]) => String(url));

describe('images in a reply', () => {
  it('reads a file:// screenshot through the file API', async () => {
    render(
      <Wrap>
        <Markdown>{'![Desktop](file:///home/u/.hermes/cache/images/shot.png)'}</Markdown>
      </Wrap>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(urls()[0]).toContain(
      `/api/fs/read-data-url?path=${encodeURIComponent('/home/u/.hermes/cache/images/shot.png')}`,
    );

    const img = await screen.findByAltText('Desktop');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  it('leaves a web image to the browser', async () => {
    render(
      <Wrap>
        <Markdown>{'![Logo](https://example.com/logo.png)'}</Markdown>
      </Wrap>,
    );

    const img = await screen.findByAltText('Logo');
    expect(img).toHaveAttribute('src', 'https://example.com/logo.png');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so when the file is gone rather than showing a gap', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));

    render(
      <Wrap>
        <Markdown>{'![Desktop](file:///tmp/gone.png)'}</Markdown>
      </Wrap>,
    );

    expect(await screen.findByText(/Couldn't load gone.png/)).toBeInTheDocument();
  });
});
