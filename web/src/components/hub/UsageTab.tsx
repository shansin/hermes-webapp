/**
 * Usage — where the tokens went, over a window you pick.
 *
 * Two things shape this screen, and both come from what Hermes actually
 * reports rather than from what an analytics page usually looks like.
 *
 * **It leads with tokens, not money.** Cost is real only for a hosted
 * provider; served a model locally, Hermes writes `estimated_cost_usd = 0` and
 * `cost_status = 'unknown'` on every session, and a dollar-led page becomes a
 * column of `$0.00`. The cost tile and cost column mount when there is a price
 * to show and stay out of the way when there is not — see `hasCostSignal`.
 *
 * **The 24h window is drawn differently from the rest.** The analytics
 * endpoint cannot group finer than a calendar date, so the hourly chart is
 * built here from session rows, while the totals above it still come from the
 * endpoint. Same rolling span for both, and the gap between them — sub-agent
 * and compaction work that never appears in a conversation list — is reported
 * rather than hidden.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
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
import { useUsageAnalytics, useModelAnalytics, type UsageDays } from '../../api/hub';
import { useSessionsSince } from '../../api/sessions';
import { buzz } from '../../lib/haptics';
import {
  PERIODS,
  fillDailyGaps,
  foldModelRows,
  formatDuration,
  groupSessions,
  hasCostSignal,
  hourSlots,
  hourlyBuckets,
  plural,
  toolLabel,
  unattributedShare,
  type Period,
} from '../../lib/usage';

/** Two series on one linear axis would pin output flat to zero — a reply is
 *  two orders of magnitude smaller than the context that produced it — so each
 *  gets its own axis and the legend says which side it belongs to. */
const SERIES = [
  { key: 'input', label: 'Input', color: 'var(--series-1)', axis: 'left' },
  { key: 'output', label: 'Output', color: 'var(--series-2)', axis: 'right' },
] as const;

const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

function DailyTooltip({ active, payload, label }: TooltipProps<number, string>) {
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

function HourTooltip({ active, payload }: TooltipProps<number, string>) {
  const row = payload?.[0]?.payload as
    | { label: string; input: number; output: number; sessions: number; api_calls: number }
    | undefined;
  if (!active || !row) return null;
  return (
    <div className="viz-tooltip">
      <div className="viz-tooltip__day">{row.label}</div>
      <div className="viz-tooltip__row">
        <span className="viz-swatch" style={{ background: 'var(--series-1)' }} />
        <span style={{ flex: 1 }}>Input</span>
        <strong>{row.input.toLocaleString()}</strong>
      </div>
      <div className="viz-tooltip__row">
        <span className="viz-swatch" style={{ background: 'var(--series-2)' }} />
        <span style={{ flex: 1 }}>Output</span>
        <strong>{row.output.toLocaleString()}</strong>
      </div>
      {/* The count is what separates "a busy hour" from "one long session that
          happened to start here" — the whole caveat of start-hour bucketing. */}
      <div className="viz-tooltip__row" style={{ color: 'var(--text-faint)' }}>
        <span style={{ flex: 1 }}>
          {plural(row.sessions, 'conversation')}
        </span>
        <strong>{plural(row.api_calls, 'call')}</strong>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="usage-tile">
      <div className="usage-tile__label">{label}</div>
      <div className="usage-tile__value">{value}</div>
      {sub && <div className="usage-tile__sub">{sub}</div>}
    </div>
  );
}

/** A ranked row with a proportion bar — the shape every breakdown here uses. */
function RankRow({
  name,
  meta,
  value,
  share,
  color = 'var(--series-1)',
  mono = false,
}: {
  name: string;
  meta?: string;
  value: string;
  share: number;
  color?: string;
  mono?: boolean;
}) {
  return (
    <tr>
      <td style={{ maxWidth: 168 }}>
        <div
          style={{
            fontFamily: mono ? 'var(--mono)' : undefined,
            fontSize: mono ? 12.5 : 13.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </div>
        <div
          className="viz-bar"
          style={{ width: `${Math.max(2, share * 100)}%`, marginTop: 4, background: color }}
        />
        {meta && (
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3 }}>{meta}</div>
        )}
      </td>
      <td>{value}</td>
    </tr>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 600, fontSize: 14.5 }}>{title}</div>
      {hint && (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2, lineHeight: 1.45 }}>
          {hint}
        </div>
      )}
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  );
}

const NOTHING = <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>Nothing recorded.</div>;

export function UsageTab() {
  const [days, setDays] = useState<Period>(1);

  const usage = useUsageAnalytics(days as UsageDays);
  const models = useModelAnalytics(days as UsageDays);

  /**
   * Hour-aligned so the query key is stable: derived straight from `Date.now()`
   * it would change on every render and refetch the whole window each time.
   */
  const since = useMemo(() => hourSlots(Date.now() / 1000)[0]!, []);
  const window = useSessionsSince(since, days === 1);

  const totals = usage.data?.totals;
  const showCost = hasCostSignal(totals);

  const hourly = useMemo(() => {
    if (days !== 1 || !window.data) return [];
    return hourlyBuckets(window.data.rows, Date.now() / 1000).map((b) => ({
      ...b,
      label: `${String(b.hour).padStart(2, '0')}:00`,
    }));
  }, [days, window.data]);

  const daily = useMemo(() => fillDailyGaps(usage.data?.daily ?? [], days === 7 ? 7 : 14), [
    usage.data,
    days,
  ]);

  // What the bars could not place, against the totals, which have no such gap.
  const unplaced = useMemo(() => {
    if (days !== 1 || !totals || hourly.length === 0) return 0;
    const bars = hourly.reduce((n, b) => n + b.total, 0);
    return unattributedShare(bars, (totals.total_input ?? 0) + (totals.total_output ?? 0));
  }, [days, totals, hourly]);

  const tasks = usage.data?.by_task ?? [];
  const taskMax = Math.max(1, ...tasks.map((t) => t.input_tokens + t.output_tokens));

  const rankedModels = useMemo(
    () => foldModelRows(models.data?.models ?? []).slice(0, 10),
    [models.data],
  );
  const modelMax = rankedModels[0]
    ? rankedModels[0].input_tokens + rankedModels[0].output_tokens
    : 1;

  const tools = (usage.data?.tools ?? []).slice(0, 8);
  const skills = (usage.data?.skills?.top_skills ?? []).slice(0, 6);

  const surfaces = useMemo(
    () => (window.data ? groupSessions(window.data.rows, 'source') : []),
    [window.data],
  );
  const surfaceMax = Math.max(1, ...surfaces.map((s) => s.tokens));

  const heaviest = useMemo(() => {
    const rows = [...(window.data?.rows ?? [])];
    rows.sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
    return rows.slice(0, 5);
  }, [window.data]);

  const totalTokens = (totals?.total_input ?? 0) + (totals?.total_output ?? 0);
  const perCall = totals?.total_api_calls ? totalTokens / totals.total_api_calls : 0;

  return (
    <div className="viz">
      {/* --- window --- */}
      <div className="btn-group" role="tablist" aria-label="Usage window">
        {PERIODS.map((p) => (
          <button
            key={p.days}
            role="tab"
            aria-selected={days === p.days}
            className={`btn-group__item${days === p.days ? ' btn-group__item--active' : ''}`}
            onClick={() => {
              buzz('tap');
              setDays(p.days);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div style={{ padding: '0 12px 12px' }}>
        {/* --- headline --- */}
        {usage.isLoading ? (
          <SkeletonList n={1} h={92} />
        ) : usage.error ? (
          <ErrorNote error={usage.error} />
        ) : (
          <>
            <div className="usage-tiles">
              <Tile
                label="Tokens"
                value={formatTokens(totalTokens)}
                sub={`${formatTokens(totals?.total_input)} in · ${formatTokens(totals?.total_output)} out`}
              />
              <Tile
                label="Conversations"
                value={String(totals?.total_sessions ?? 0)}
                sub={days === 1 ? 'incl. sub-agents' : `over ${days} days`}
              />
              <Tile
                label="API calls"
                value={String(totals?.total_api_calls ?? 0)}
                sub={perCall ? `${formatTokens(perCall)} per call` : undefined}
              />
              {showCost ? (
                <Tile
                  label="Cost"
                  value={money(totals?.total_estimated_cost ?? 0)}
                  sub={
                    (totals?.total_actual_cost ?? 0) > 0
                      ? `${money(totals!.total_actual_cost)} billed`
                      : 'estimated'
                  }
                />
              ) : (
                <Tile
                  label="Cache reads"
                  value={formatTokens(totals?.total_cache_read)}
                  sub={totals?.total_cache_read ? 'billed cheaper' : 'not reported'}
                />
              )}
            </div>

            {/* Said once, here, rather than by every $0.00 on the screen. */}
            {!showCost && totalTokens > 0 && (
              <div className="usage-note">
                No prices: everything this window ran through a provider Hermes has no rate card
                for — a local or custom endpoint — so it records the tokens and leaves cost unset.
              </div>
            )}
          </>
        )}

        {/* --- the chart --- */}
        <div className="card" style={{ margin: '12px 0' }}>
          <div style={{ fontWeight: 600, fontSize: 14.5 }}>
            {days === 1 ? 'Tokens by hour' : 'Tokens per day'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2, lineHeight: 1.45 }}>
            {days === 1
              ? 'Last 24 hours, local time. A conversation counts in the hour it started, so a tall bar can be one long session.'
              : `Last ${Math.min(days, 14)} days, UTC — the backend groups by UTC date, so a late-night session may land on the next bar.`}
          </div>

          <div style={{ marginTop: 10 }}>
            {days === 1 ? (
              window.isLoading ? (
                <SkeletonList n={1} h={170} />
              ) : window.error ? (
                <ErrorNote error={window.error} />
              ) : hourly.every((b) => b.total === 0) ? (
                <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>
                  Nothing in the last 24 hours.
                </div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={185}>
                    <BarChart data={hourly} margin={{ top: 4, right: 6, left: -14, bottom: 0 }}>
                      <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                      <XAxis
                        dataKey="hour"
                        tick={{ fontSize: 10.5, fill: 'var(--viz-axis)' }}
                        tickLine={false}
                        axisLine={{ stroke: 'var(--viz-grid)' }}
                        interval={2}
                        tickFormatter={(h: number) => String(h).padStart(2, '0')}
                      />
                      <YAxis
                        tick={{ fontSize: 10.5, fill: 'var(--viz-axis)' }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => formatTokens(v)}
                        width={56}
                      />
                      <Tooltip
                        content={<HourTooltip />}
                        cursor={{ fill: 'var(--viz-grid)', opacity: 0.5 }}
                      />
                      {/* One series: input outweighs output ~100:1, so a stack
                          would render output as an invisible sliver. Both
                          numbers are in the tooltip. */}
                      <Bar dataKey="total" fill="var(--series-1)" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>

                  {unplaced > 0.02 && (
                    <div className="usage-note">
                      {Math.round(unplaced * 100)}% of this window's tokens aren't in the bars.
                      The session list hides sub-agent runs and folds compaction continuations into
                      their parent; the totals above count them.
                    </div>
                  )}
                  {window.data?.truncated && (
                    <div className="usage-note">
                      More conversations than this screen pages through — the bars cover the most
                      recent 500.
                    </div>
                  )}
                </>
              )
            ) : usage.isLoading ? (
              <SkeletonList n={1} h={170} />
            ) : daily.length === 0 ? (
              <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>No usage recorded yet.</div>
            ) : (
              <>
                {/* Identity is never colour-alone: two series, so a legend. */}
                <div className="viz-legend">
                  {SERIES.map((s) => (
                    <span className="viz-legend__item" key={s.key}>
                      <span className="viz-swatch" style={{ background: s.color }} />
                      {s.label}
                      <span style={{ color: 'var(--text-faint)', fontSize: 10.5 }}>
                        {s.axis === 'left' ? '(left)' : '(right)'}
                      </span>
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
                      yAxisId="left"
                      tick={{ fontSize: 10.5, fill: 'var(--series-1)' }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => formatTokens(v)}
                      // Wide enough for "12.0M"; narrower clips the lead digit.
                      width={56}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 10.5, fill: 'var(--series-2)' }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => formatTokens(v)}
                      width={48}
                    />
                    <Tooltip
                      content={<DailyTooltip />}
                      cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }}
                    />
                    {SERIES.map((s) => (
                      <Line
                        key={s.key}
                        yAxisId={s.axis}
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
        </div>

        {/* --- overhead: the tokens nobody asked for --- */}
        <Card
          title="Machinery"
          hint="Calls Hermes makes on its own behalf — naming a session, judging an approval, compacting a transcript. Charged to a model, attributable to no conversation."
        >
          {usage.isLoading ? (
            <SkeletonList n={3} h={30} />
          ) : tasks.length === 0 ? (
            NOTHING
          ) : (
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const total = t.input_tokens + t.output_tokens;
                  return (
                    <RankRow
                      key={t.task}
                      name={t.task.replace(/_/g, ' ')}
                      meta={`${plural(t.api_calls, 'call')} · ${plural(t.models.length, 'model')}`}
                      value={formatTokens(total)}
                      share={total / taskMax}
                      color="var(--series-3)"
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* --- by model --- */}
        <Card
          title="By model"
          hint="Everything the model was asked to do, machinery included. Provider is part of the identity: the same model served two ways is two rows."
        >
          {models.isLoading ? (
            <SkeletonList n={4} h={38} />
          ) : models.error ? (
            <ErrorNote error={models.error} />
          ) : rankedModels.length === 0 ? (
            NOTHING
          ) : (
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {rankedModels.map((m) => {
                  const total = m.input_tokens + m.output_tokens;
                  const ctx = m.capabilities?.context_window;
                  const fill = ctx ? m.avg_tokens_per_session / ctx : 0;
                  return (
                    <RankRow
                      key={`${m.provider}/${m.model}`}
                      mono
                      name={m.model}
                      meta={[
                        // An auxiliary row the second fold pass could not place
                        // — the model was served more than one way this window.
                        m.provider || 'provider unrecorded',
                        plural(m.api_calls, 'call'),
                        // A model averaging near its own window is a model
                        // that compacts constantly — worth seeing.
                        fill > 0 ? `${Math.round(fill * 100)}% of window/session` : '',
                        m.last_used_at ? relTime(m.last_used_at) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      value={formatTokens(total)}
                      share={total / modelMax}
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* --- tools --- */}
        <Card title="Tools" hint="Every tool call in the window, however it was invoked.">
          {usage.isLoading ? (
            <SkeletonList n={4} h={30} />
          ) : tools.length === 0 ? (
            NOTHING
          ) : (
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Calls</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((t) => {
                  const { label, server } = toolLabel(t.tool);
                  return (
                    <RankRow
                      key={t.tool}
                      mono
                      name={label}
                      meta={server ? `mcp · ${server}` : undefined}
                      value={String(t.count)}
                      share={t.percentage / (tools[0]?.percentage || 100)}
                      color="var(--series-2)"
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* --- skills --- */}
        <Card
          title="Skills"
          hint={
            usage.data
              ? `${usage.data.skills.summary.distinct_skills_used} used · ${usage.data.skills.summary.total_skill_loads} loads · ${usage.data.skills.summary.total_skill_edits} edits`
              : undefined
          }
        >
          {usage.isLoading ? (
            <SkeletonList n={3} h={30} />
          ) : skills.length === 0 ? (
            NOTHING
          ) : (
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Uses</th>
                </tr>
              </thead>
              <tbody>
                {skills.map((s) => (
                  <RankRow
                    key={s.skill}
                    name={s.skill}
                    meta={[
                      s.view_count ? plural(s.view_count, 'load') : '',
                      s.manage_count ? plural(s.manage_count, 'edit') : '',
                      s.last_used_at ? relTime(s.last_used_at) : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    value={String(s.total_count)}
                    share={s.percentage / (skills[0]?.percentage || 100)}
                    color="var(--series-3)"
                  />
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* --- the two session-derived cards, 24h only ---------------------
            Both need per-session rows, and the endpoint that serves them caps
            at 100 per page. Over a day that is one request and an exact
            answer; over 90 days it would be a confident-looking sample of
            whatever the last few hundred sessions happened to be. */}
        {days === 1 && (
          <>
            <Card title="By surface" hint="Where the last 24 hours of conversations came from.">
              {window.isLoading ? (
                <SkeletonList n={3} h={30} />
              ) : surfaces.length === 0 ? (
                NOTHING
              ) : (
                <table className="viz-table">
                  <thead>
                    <tr>
                      <th>Surface</th>
                      <th>Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {surfaces.map((s) => (
                      <RankRow
                        key={s.name}
                        name={s.name}
                        meta={plural(s.sessions, 'conversation')}
                        value={formatTokens(s.tokens)}
                        share={s.tokens / surfaceMax}
                        color="var(--series-2)"
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Heaviest conversations" hint="Tap to reopen.">
              {window.isLoading ? (
                <SkeletonList n={3} h={44} />
              ) : heaviest.length === 0 ? (
                NOTHING
              ) : (
                <div className="usage-sessions">
                  {heaviest.map((s) => {
                    const total = s.input_tokens + s.output_tokens;
                    const dur = s.ended_at ? s.ended_at - s.started_at : null;
                    return (
                      <Link
                        key={s.id}
                        to={`/chat?session=${encodeURIComponent(s.id)}`}
                        className="usage-session"
                        onClick={() => buzz('tap')}
                      >
                        <span className="usage-session__main">
                          <span className="usage-session__title">{s.title ?? 'Untitled'}</span>
                          <span className="usage-session__meta">
                            {[
                              s.source ?? 'unknown',
                              s.model ?? '',
                              dur != null ? formatDuration(dur) : 'running',
                              plural(s.tool_call_count, 'tool'),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                        <span className="usage-session__tokens">{formatTokens(total)}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
