/**
 * Files on a card.
 *
 * The point is not storage. Hermes' `build_worker_context` puts each
 * attachment's absolute path into the worker's prompt, so a file attached here
 * is a file the next run can open — which makes this the only route by which a
 * phone can hand an agent a document, a screenshot or a CSV outside a chat
 * message. Workers add them from their side too (`kanban_attach`,
 * `kanban_attach_url`), so the list is two-way and `uploaded_by` is worth
 * showing.
 *
 * Two mechanics worth knowing:
 *
 * **Download is a link, not a fetch.** The endpoint answers with a
 * `FileResponse`; the proxy adds the Bearer token and Cloudflare Access is
 * satisfied by the cookie the browser already holds, so a plain same-origin
 * `<a>` lets the browser's own downloader do it. Reading a 25 MB file into a
 * phone's memory to hand it back as a blob URL would be strictly worse, and on
 * iOS often fatal.
 *
 * **The size cap is enforced twice.** Hermes rejects anything over 25 MB with a
 * 413, which reaches the app as a bare error some way into a slow upload. The
 * local check is not belt-and-braces so much as the difference between "too
 * big" said immediately and said after ninety seconds of a phone's uplink.
 */
import { useRef } from 'react';
import {
  ATTACHMENT_MAX_BYTES,
  attachmentUrl,
  useDeleteAttachment,
  useTaskAttachments,
  useUploadAttachment,
  type TaskAttachment,
} from '../../api/kanban';
import { Loader, relTime } from '../shared/misc';
import { IconPaperclip, IconTrash } from '../shared/Icons';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

export function TaskAttachments({ taskId, board }: { taskId: string; board: string | null }) {
  const { data, isLoading, error } = useTaskAttachments(taskId, board);
  const upload = useUploadAttachment(board);
  const remove = useDeleteAttachment(board);
  const toast = useUi((s) => s.toast);
  const input = useRef<HTMLInputElement>(null);

  const files = data?.attachments ?? [];

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (file.size > ATTACHMENT_MAX_BYTES) {
      toast(`${file.name} is ${mb(file.size)} — the limit is ${mb(ATTACHMENT_MAX_BYTES)}`, 'error');
      return;
    }
    buzz('tap');
    void upload
      .mutateAsync({ id: taskId, file })
      .then(() => {
        buzz('done');
        toast('Attached', 'success');
      })
      .catch((e: unknown) =>
        toast(e instanceof Error ? e.message : 'Could not attach the file', 'error'),
      );
  };

  const drop = (a: TaskAttachment) => {
    /* No undo here, unlike a deleted card. The bytes go from disk immediately
       and Hermes keeps no copy, so a confirm is the only thing standing
       between a mis-tap and a file that has to be found again. */
    if (!confirm(`Remove ${a.filename}? The file is deleted from disk.`)) return;
    buzz('warn');
    void remove
      .mutateAsync({ attachmentId: a.id, taskId })
      .then(() => toast('Removed', 'success'))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not remove it', 'error'));
  };

  /* A 404 is the ordinary answer on a Hermes whose kanban plugin predates
     attachments. Rendering nothing is the right amount of noise for that. */
  if (error && (error as { status?: number }).status === 404) return null;

  return (
    <>
      <div className="group-head">FILES{files.length ? ` · ${files.length}` : ''}</div>
      <div style={{ marginBottom: 14 }}>
        {isLoading ? (
          <Loader size="sm" muted />
        ) : (
          files.map((a) => (
            <div
              key={a.id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                padding: '7px 0',
                borderBottom: '1px solid var(--border-soft)',
              }}
            >
              <a
                className="btn btn--sm"
                href={attachmentUrl(a.id, board)}
                // A hint, not a guarantee: a cross-origin or opaque response
                // ignores it, and the header Hermes sets is what actually
                // decides. Naming the file is still better than not.
                download={a.filename}
                target="_blank"
                rel="noreferrer"
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: 'left',
                  display: 'block',
                  height: 'auto',
                  padding: '6px 9px',
                }}
              >
                <div
                  style={{
                    fontWeight: 550,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {a.filename}
                </div>
                <div
                  style={{
                    fontSize: 'var(--type-label-sm)',
                    color: 'var(--text-faint)',
                    fontWeight: 400,
                  }}
                >
                  {mb(a.size)}
                  {a.uploaded_by && ` · ${a.uploaded_by}`} · {relTime(a.created_at)}
                </div>
              </a>
              <button
                className="icon-btn icon-btn--danger"
                aria-label={`Remove ${a.filename}`}
                onClick={() => drop(a)}
                disabled={remove.isPending}
              >
                <IconTrash size={15} />
              </button>
            </div>
          ))
        )}

        <input
          ref={input}
          type="file"
          hidden
          onChange={(e) => {
            pick(e.target.files?.[0]);
            // Cleared so re-picking the same file fires `change` again.
            e.target.value = '';
          }}
        />
        <button
          className="btn btn--sm"
          style={{ width: '100%', marginTop: files.length ? 8 : 0 }}
          disabled={upload.isPending}
          onClick={() => {
            buzz('tap');
            input.current?.click();
          }}
        >
          <IconPaperclip size={15} />
          {upload.isPending ? ' Uploading…' : ' Attach a file'}
        </button>
        <div
          style={{
            fontSize: 'var(--type-label-sm)',
            color: 'var(--text-faint)',
            marginTop: 6,
            lineHeight: 1.45,
          }}
        >
          The agent is given the path to each of these when the card next runs. Up to{' '}
          {mb(ATTACHMENT_MAX_BYTES)} each.
        </div>
      </div>
    </>
  );
}

function mb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
