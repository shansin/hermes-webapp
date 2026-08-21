/**
 * Models — which model new sessions start on.
 *
 * This screen used to also carry the daily-token chart and the per-model usage
 * table. Both moved to Usage, which is now the one place the numbers live.
 * Keeping them here meant reading spend on a screen named for model selection,
 * and any breakdown Usage grew would have had a stale twin sitting next to the
 * picker.
 *
 * What is left is a setting: the stored default, and the auxiliary slots
 * beside it. No active-model card — the model a conversation runs on belongs to
 * that conversation, and the chat header both names it and changes it.
 */
import { Link } from 'react-router-dom';
import { DefaultModelSection } from './DefaultModelSection';
import { IconUsage } from '../shared/Icons';
import { buzz } from '../../lib/haptics';

export function ModelsTab() {
  return (
    <div style={{ padding: 12 }}>
      <DefaultModelSection />

      <Link to="/usage" className="card usage-crosslink" onClick={() => buzz('tap')}>
        <span className="usage-crosslink__icon">
          <IconUsage size={20} />
        </span>
        <span>
          <span className="usage-crosslink__title">Usage</span>
          <span className="usage-crosslink__hint">
            What these models have cost in tokens, calls and time
          </span>
        </span>
      </Link>
    </div>
  );
}
