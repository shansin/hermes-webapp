/**
 * Copy / share buttons for one message.
 *
 * Shared by both bubble kinds so the transcript offers the same verbs
 * everywhere — previously only code blocks could be copied, and getting a
 * reply off the phone meant exporting the entire session.
 *
 * Neither button is hidden on plain HTTP. `copyText` and `shareText` both
 * carry fallbacks that work on an insecure origin (see `lib/share.ts`), so
 * hiding them would remove a feature that does in fact work there.
 */
import { useState } from 'react';
import { IconCheck, IconCopy, IconShare } from '../shared/Icons';
import { copyText, outcomeToast, shareText } from '../../lib/share';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

export function MessageActions({ getText, title }: { getText: () => string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useUi((s) => s.toast);

  return (
    <>
      <button
        className="code__copy msg__action"
        aria-label="Copy message"
        onClick={async () => {
          const ok = await copyText(getText());
          if (!ok) {
            toast('Nothing could copy here', 'error');
            return;
          }
          buzz('tap');
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>

      <button
        className="code__copy msg__action"
        aria-label="Share message"
        onClick={async () => {
          buzz('tap');
          const { text, tone } = outcomeToast(await shareText(getText(), title));
          toast(text, tone);
        }}
      >
        <IconShare size={13} /> Share
      </button>
    </>
  );
}
