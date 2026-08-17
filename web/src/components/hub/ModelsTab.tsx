/**
 * Models & usage analytics.
 *
 * Two questions, two forms: "how has usage moved over time" (a line chart of
 * daily tokens) and "which models did the work" (ranked rows with proportion
 * bars). The ranked list is also the value table, which is what discharges the
 * light-mode contrast relief requirement for the aqua slot.
 */
import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { ErrorNote, SkeletonList, formatTokens, relTime } from '../shared/misc';
import { useModelAnalytics, useUsageAnalytics } from '../../api/hub';
import { useSession } from '../../store/session';

const SERIES = [
  { key: 'input', label: 'Input', color: 'var(--series-1)' },
  { key: 'output', label: 'Output', color: 'var(--series-2)' },
] as const;

function UsageTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  return (
    <div className="viz-tooltip">
      <div className="viz-tooltip__day">{label}</div>
      {payload.map((p) => (
        <div className="viz-tooltip__row" key={p.dataKey as string}>
          <span className="viz-swatch" style={{ background: p.color }} />
          <span style={{ flex: 1 }}>{p.name}</span>
          <strong>{Number(p.value ?? 0).toLocaleString()}</strong>
        </div>
      ))}
    </div>
  );
}

export function ModelsTab() {
  const usage = useUsageAnalytics();
  const models = useModelAnalytics();
  const info = useSession((s) => s.info);

  // Last 14 days is what fits legibly on a phone.
  const daily = useMemo(() => {
    const rows = usage.data?.daily ?? [];
    return rows.slice(-14).map((d) => ({
      day: d.day.slice(5), // MM-DD
      input: d.input_tokens,
      output: d.output_tokens,
      sessions: d.sessions,
    }));
  }, [usage.data]);

  const ranked = useMemo(() => {
    const rows = [...(models.data?.models ?? [])];
    rows.sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
    return rows.slice(0, 12);
  }, [models.data]);

  const maxTotal = ranked[0] ? ranked[0].input_tokens + ranked[0].output_tokens : 1;

  return (
    <div className="viz" style={{ padding: 12 }}>
      {info?.model && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', fontWeight: 650, marginBottom: 5 }}>
            ACTIVE MODEL
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--mono)' }}>{info.model}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3 }}>
            {info.provider}
            {info.reasoning_effort && ` · reasoning ${info.reasoning_effort}`}
          </div>
        </div>
      )}

      {/* --- daily tokens --- */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 14.5, marginBottom: 2 }}>Tokens per day</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 10 }}>Last 14 days</div>

        {usage.isLoading ? (
          <SkeletonList n={1} h={180} />
        ) : usage.error ? (
          <ErrorNote error={usage.error} />
        ) : daily.length === 0 ? (
          <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>No usage recorded yet.</div>
        ) : (
          <>
            {/* Legend is always present for >=2 series — identity is never color-alone. */}
            <div className="viz-legend">
              {SERIES.map((s) => (
                <span className="viz-legend__item" key={s.key}>
                  <span className="viz-swatch" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>

            <ResponsiveContainer width="100%" height={185}>
              <LineChart data={daily} margin={{ top: 4, right: 6, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 10.5, fill: 'var(--viz-axis)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--viz-grid)' }}
                  interval="preserveStartEnd"
                  minTickGap={18}
                />
                <YAxis
                  tick={{ fontSize: 10.5, fill: 'var(--viz-axis)' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => formatTokens(v)}
                  // Wide enough for a five-character tick ("12.0M") — a
                  // narrower axis silently clips the leading digit.
                  width={56}
                />
                <Tooltip content={<UsageTooltip />} cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }} />
                {SERIES.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--bg-elev)' }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </div>

      {/* --- per-model breakdown, doubling as the value table --- */}
      <div className="card">
        <div style={{ fontWeight: 600, fontSize: 14.5, marginBottom: 10 }}>Usage by model</div>

        {models.isLoading ? (
          <SkeletonList n={4} h={38} />
        ) : models.error ? (
          <ErrorNote error={models.error} />
        ) : ranked.length === 0 ? (
          <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>No model usage yet.</div>
        ) : (
          <table className="viz-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Tokens</th>
                <th>Runs</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((m) => {
                const total = m.input_tokens + m.output_tokens;
                return (
                  <tr key={`${m.provider}/${m.model}`}>
                    <td style={{ maxWidth: 168 }}>
                      <div
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: 12.5,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {m.model}
                      </div>
                      <div
                        className="viz-bar"
                        style={{ width: `${Math.max(2, (total / maxTotal) * 100)}%`, marginTop: 4 }}
                      />
                      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3 }}>
                        {m.provider}
                        {m.last_used_at ? ` · ${relTime(m.last_used_at)}` : ''}
                      </div>
                    </td>
                    <td>{formatTokens(total)}</td>
                    <td>{m.api_calls}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
