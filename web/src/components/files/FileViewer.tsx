/**
 * Preview and edit one file.
 *
 * The server classifies the file for us — `read-text` returns `binary`,
 * `mimeType` and `language` — so nothing here guesses from the extension.
 * Three outcomes: text gets a reader that toggles into an editor, images get
 * inlined from a data URL, and anything else binary gets a download link.
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../shared/Sheet';
import { Markdown } from '../chat/Markdown';
import { Loader } from '../shared/misc';
import {
  basename,
  downloadFile,
  formatBytes,
  useFileDataUrl,
  useFileText,
  useWriteFile,
} from '../../api/files';
import { useUi } from '../../store/ui';
import { buzz } from '../../lib/haptics';

interface Props {
  path: string | null;
  onClose: () => void;
}

export function FileViewer({ path, onClose }: Props) {
  const toast = useUi((s) => s.toast);
  const file = useFileText(path);
  const write = useWriteFile();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);

  const info = file.data;
  const isImage = Boolean(info?.binary && info.mimeType.startsWith('image/'));
  // Only fetch the base64 payload once we know it's an image worth showing.
  const image = useFileDataUrl(isImage ? path : null);

  // Reset editor state whenever a different file is opened.
  useEffect(() => {
    setEditing(false);
    setDraft('');
    setConfirmDiscard(false);
  }, [path]);

  const dirty = editing && info != null && draft !== info.text;

  const close = () => {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const save = async () => {
    if (!path) return;
    try {
      await write.mutateAsync({ path, content: draft });
      buzz('done');
      toast(`Saved ${basename(path)}`, 'success');
      setEditing(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error');
    }
  };

  if (!path) return null;

  return (
    <>
      <Sheet
        open={!confirmDiscard}
        title={basename(path)}
        onClose={close}
        actions={
          editing ? (
            <>
              <button className="btn" onClick={() => (dirty ? setConfirmDiscard(true) : setEditing(false))}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                disabled={!dirty || write.isPending}
                onClick={() => void save()}
              >
                {write.isPending ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : info && !info.binary && !info.truncated ? (
            <button
              className="btn"
              onClick={() => {
                buzz('tap');
                setDraft(info.text);
                setEditing(true);
              }}
            >
              Edit
            </button>
          ) : undefined
        }
      >
        {file.isLoading && <Loader />}

        {file.error && (
          <p style={{ color: 'var(--error)', fontSize: 13.5 }}>
            {file.error instanceof Error ? file.error.message : 'Could not read this file'}
          </p>
        )}

        {info && (
          <>
            <div className="files__meta">
              {formatBytes(info.byteSize)}
              {info.language && info.language !== 'text' && <> · {info.language}</>}
              {info.binary && <> · {info.mimeType}</>}
            </div>

            {/* Editing is withheld rather than risked: the server sends only the
                first 512KB, so saving would truncate the file on disk. */}
            {info.truncated && (
              <div className="files__warn">
                Showing the first {formatBytes(info.text.length)} of this file. It's too
                large to edit here — saving would discard the rest.
              </div>
            )}

            {editing ? (
              <textarea
                className="field files__editor"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            ) : isImage ? (
              image.isLoading ? (
                <Loader />
              ) : image.data ? (
                <img className="files__image" src={image.data.dataUrl} alt={basename(path)} />
              ) : (
                <p style={{ color: 'var(--text-faint)', fontSize: 13 }}>Could not load the image.</p>
              )
            ) : info.binary ? (
              <p style={{ fontSize: 13.5, color: 'var(--text-dim)' }}>
                This is a binary file, so there's nothing readable to show.
              </p>
            ) : (
              // Markdown renders as a document; anything else goes through the
              // same renderer as a fenced block, which gets it highlighted and
              // horizontally scrollable for free.
              <div className="files__preview">
                <Markdown>
                  {info.language === 'markdown' || info.language === 'md'
                    ? info.text
                    : `\`\`\`${info.language || ''}\n${info.text}\n\`\`\``}
                </Markdown>
              </div>
            )}

            {info.binary && (
              <button
                className="btn"
                disabled={saving}
                onClick={() => {
                  setSaving(true);
                  buzz('tap');
                  downloadFile(path)
                    .catch((e: unknown) =>
                      toast(e instanceof Error ? e.message : 'Download failed', 'error'),
                    )
                    .finally(() => setSaving(false));
                }}
              >
                {saving ? 'Downloading…' : 'Download'}
              </button>
            )}
          </>
        )}
      </Sheet>

      <Sheet
        open={confirmDiscard}
        title="Discard changes?"
        onClose={() => setConfirmDiscard(false)}
        actions={
          <>
            <button className="btn" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </button>
            <button
              className="btn btn--danger"
              onClick={() => {
                setConfirmDiscard(false);
                setEditing(false);
                onClose();
              }}
            >
              Discard
            </button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, color: 'var(--text-dim)', margin: 0 }}>
          {basename(path)} has unsaved edits.
        </p>
      </Sheet>
    </>
  );
}
