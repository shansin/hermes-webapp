/**
 * The header's back affordance, in the one place every screen takes it from.
 *
 * Sits immediately after `MenuButton` so the two chrome controls are always in
 * the same order and the same place — a back arrow that moves between screens
 * is worse than none. See `useAppBack` for what it does and why.
 *
 * Chat does not carry one: it is the fallback, and a back button on the home
 * screen has nowhere honest to point.
 */
import { IconBack } from './Icons';
import { buzz } from '../../lib/haptics';
import { useAppBack } from '../../lib/useAppBack';

export function BackButton({
  fallback = '/chat',
  label = 'Back',
  onBack,
}: {
  fallback?: string;
  label?: string;
  /** Overrides the navigation entirely — Files uses it to go up a directory. */
  onBack?: () => void;
}) {
  const back = useAppBack(fallback);
  return (
    <button
      className="icon-btn"
      onClick={() => {
        buzz('tap');
        (onBack ?? back)();
      }}
      aria-label={label}
    >
      <IconBack size={19} />
    </button>
  );
}
