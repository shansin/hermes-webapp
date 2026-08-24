/**
 * MCP servers — the tools Hermes gets from somewhere else.
 *
 * Two modes, the same shape Skills uses for installed-versus-hub: what is
 * configured here, and the catalog of what could be.
 *
 * **Most of the catalog cannot be finished from a phone, and the screen says
 * so rather than pretending.** Eighteen of the twenty stock entries are
 * `auth_type: "oauth"`, which means installing them is the easy half — the
 * other half is a browser login against the vendor, which lands back on the
 * *backend*, not on this app, and would have to come through the tunnel and
 * Cloudflare Access to do anything else. So install is offered, and the
 * entry's own `post_install` text is shown afterwards, which is where Hermes
 * explains the login it still wants. A button that silently did nothing would
 * be worse than the sentence.
 */
import { useMemo, useState } from 'react';
import { Switch, SkeletonList, ErrorNote, Empty } from '../shared/misc';
import { IconSearch, IconTrash } from '../shared/Icons';
import {
  useDeleteMcpServer,
  useInstallMcpCatalogEntry,
  useMcpCatalog,
  useMcpServers,
  useTestMcpServer,
  useToggleMcpServer,
  type McpServer,
} from '../../api/tools';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

/** How a server is reached, as one readable line. */
function target(s: McpServer): string {
  if (s.url) return s.url;
  if (s.command) return [s.command, ...s.args].join(' ');
  return s.transport;
}

export function McpSection() {
  const [mode, setMode] = useState<'installed' | 'catalog'>('installed');
  const [q, setQ] = useState('');

  const servers = useMcpServers();
  const catalog = useMcpCatalog(mode === 'catalog');
  const toggle = useToggleMcpServer();
  const remove = useDeleteMcpServer();
  const test = useTestMcpServer();
  const install = useInstallMcpCatalogEntry();
  const toast = useUi((s) => s.toast);

  const [testing, setTesting] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = catalog.data ?? [];
    if (!needle) return all;
    return all.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) || e.description.toLowerCase().includes(needle),
    );
  }, [catalog.data, q]);

  const flip = async (s: McpServer, enabled: boolean) => {
    buzz('tap');
    try {
      await toggle.mutateAsync({ name: s.name, enabled });
      toast(`${s.name} ${enabled ? 'on' : 'off'}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change that server', 'error');
    }
  };

  const runTest = async (name: string) => {
    buzz('tap');
    setTesting(name);
    try {
      const res = await test.mutateAsync(name);
      // The endpoint reports a failed connection in the body rather than as a
      // non-2xx, so a thrown error and `ok: false` both mean "did not work".
      if (res?.ok === false) {
        toast(res.error ? `${name}: ${res.error}` : `${name} did not answer`, 'error');
      } else {
        const n = res?.tools?.length;
        toast(n != null ? `${name} answered — ${n} tools` : `${name} answered`, 'success');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : `${name} did not answer`, 'error');
    } finally {
      setTesting(null);
    }
  };

  const doInstall = async (name: string, postInstall: string | null) => {
    buzz('tap');
    setInstalling(name);
    try {
      await install.mutateAsync(name);
      // The vendor login, in Hermes' own words, since it is the half this app
      // cannot do. Given the whole toast window because it is instructions.
      toast(postInstall?.trim() || `${name} installed`, postInstall ? 'warn' : 'success', {
        durationMs: postInstall ? 12_000 : undefined,
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Install failed', 'error');
    } finally {
      setInstalling(null);
    }
  };

  const drop = async (name: string) => {
    buzz('tap');
    try {
      await remove.mutateAsync(name);
      toast(`${name} removed`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove that server', 'error');
    }
  };

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 7, marginBottom: 12 }}>
        <button
          className={`chip${mode === 'installed' ? ' chip--active' : ''}`}
          onClick={() => setMode('installed')}
        >
          Configured {servers.data && `· ${servers.data.length}`}
        </button>
        <button
          className={`chip${mode === 'catalog' ? ' chip--active' : ''}`}
          onClick={() => setMode('catalog')}
        >
          Catalog
        </button>
      </div>

      {mode === 'catalog' ? (
        <>
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <IconSearch
              size={16}
              style={{
                position: 'absolute',
                left: 11,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-faint)',
              }}
            />
            <input
              className="field"
              style={{ paddingLeft: 34 }}
              placeholder="Search the catalog…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          {catalog.isLoading ? (
            <SkeletonList n={5} h={72} />
          ) : catalog.error ? (
            <ErrorNote error={catalog.error} />
          ) : results.length === 0 ? (
            <Empty icon="🔌" title="Nothing matches" />
          ) : (
            results.map((e) => (
              <div className="card" key={e.name} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{e.name}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.45 }}>
                      {e.description}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 5 }}>
                      {e.transport}
                      {e.auth_type && e.auth_type !== 'none' && ` · ${e.auth_type.replace('_', ' ')}`}
                      {e.required_env.length > 0 && ` · needs ${e.required_env.join(', ')}`}
                    </div>
                  </div>
                  {e.installed ? (
                    <span className="tool-pill" style={{ flexShrink: 0 }}>Installed</span>
                  ) : (
                    <button
                      className="btn"
                      style={{ flexShrink: 0 }}
                      disabled={installing != null}
                      onClick={() => void doInstall(e.name, e.post_install)}
                    >
                      {installing === e.name ? 'Installing…' : 'Install'}
                    </button>
                  )}
                </div>
                {!e.installed && e.auth_type === 'oauth' && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.45 }}>
                    Signs in through a browser on the machine running Hermes — installing
                    here does not finish it.
                  </div>
                )}
              </div>
            ))
          )}
        </>
      ) : servers.isLoading ? (
        <SkeletonList n={3} h={72} />
      ) : servers.error ? (
        <ErrorNote error={servers.error} />
      ) : !servers.data?.length ? (
        <Empty
          icon="🔌"
          title="No MCP servers"
          hint="The catalog has twenty ready to add."
        />
      ) : (
        servers.data.map((s) => (
          <div className="card" key={s.name} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--text-faint)',
                    marginTop: 3,
                    fontFamily: 'var(--mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {target(s)}
                </div>
                {s.tools?.length ? (
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
                    {s.tools.length} tools
                  </div>
                ) : null}
              </div>
              <Switch
                checked={s.enabled}
                onChange={(v) => void flip(s, v)}
                label={`${s.name} enabled`}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                className="btn"
                disabled={testing != null}
                onClick={() => void runTest(s.name)}
              >
                {testing === s.name ? 'Testing…' : 'Test'}
              </button>
              <button
                className="icon-btn"
                aria-label={`Remove ${s.name}`}
                onClick={() => void drop(s.name)}
              >
                <IconTrash size={17} />
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
