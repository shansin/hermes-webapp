/**
 * Context-fill ring: how much of the model's window the conversation occupies.
 * Turns amber past 75% and red past 90%, which is when compaction is near.
 */
import { useSession } from '../../store/session';

export function CostRing({ onClick }: { onClick?: () => void }) {
  const usage = useSession((s) => s.usage);
  if (!usage?.context_max) return null;

  const pct = Math.min(
    100,
    usage.context_percent ?? ((usage.context_used ?? 0) / usage.context_max) * 100,
  );

  const r = 13;
  const circumference = 2 * Math.PI * r;
  const dash = (pct / 100) * circumference;

  const color = pct > 90 ? 'var(--error)' : pct > 75 ? 'var(--warn)' : 'var(--accent)';

  return (
    <button
      className="cost-ring"
      onClick={onClick}
      aria-label={`Context ${Math.round(pct)}% full`}
      title={`${(usage.context_used ?? 0).toLocaleString()} / ${usage.context_max.toLocaleString()} tokens`}
    >
      <svg width="34" height="34" viewBox="0 0 34 34">
        <circle cx="17" cy="17" r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
        <circle
          cx="17"
          cy="17"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 17 17)"
          style={{ transition: 'stroke-dasharray 0.4s ease' }}
        />
      </svg>
      <span className="cost-ring__pct">{Math.round(pct)}</span>
    </button>
  );
}
