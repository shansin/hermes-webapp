/**
 * Workspace file browser.
 *
 * A tree doesn't work under a thumb — nested disclosure triangles are small
 * targets and the indentation eats a phone's width. This is a drill-down
 * instead: one directory at a time, tap to descend, a back row to ascend, and
 * the current path shown as a scrollable crumb trail.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FileViewer } from '../components/files/FileViewer';
import { PullToRefresh } from '../components/shared/PullToRefresh';
import { Sheet } from '../components/shared/Sheet';
import { Empty, ErrorNote, SkeletonList } from '../components/shared/misc';
import { IconBack, IconPlus, IconTrash } from '../components/shared/Icons';
import {
  basename,
  fileKeys,
  parentOf,
  useDefaultCwd,
  useDeletePath,
  useDirectory,
  useGitStatus,
  useMakeDirectory,
  type FsEntry,
} from '../api/files';
import { MenuButton } from '../components/shared/MenuButton';
import { useUi } from '../store/ui';
import { buzz } from '../lib/haptics';

export function FilesScreen() {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);

  // A `workspace://` link from the transcript arrives as `/files?path=…`.
  const [params, setParams] = useSearchParams();
  const requested = params.get('path');

  const [dir, setDir] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FsEntry | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);

  const defaultCwd = useDefaultCwd();
  const listing = useDirectory(dir);
  const git = useGitStatus(dir);
  const mkdir = useMakeDirectory();
  const del = useDeletePath();

  // Open on the agent's working directory until told otherwise.
  useEffect(() => {
    if (dir === null && defaultCwd.data?.cwd) setDir(defaultCwd.data.cwd);
  }, [dir, defaultCwd.data]);

  /**
   * A requested path may be a file or a directory, and the caller doesn't know
   * which. Point the listing at its parent and try to open it as a file — a
   * directory simply fails that read and the listing is already correct.
   */
  useEffect(() => {
    if (!requested) return;
    setDir(parentOf(requested) ?? requested);
    setViewing(requested);
    setParams({}, { replace: true });
  }, [requested, setParams]);

  const { dirs, files } = useMemo(() => {
    const entries = listing.data?.entries ?? [];
    const byName = (a: FsEntry, b: FsEntry) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return {
      dirs: entries.filter((e) => e.isDirectory).sort(byName),
      files: entries.filter((e) => !e.isDirectory).sort(byName),
    };
  }, [listing.data]);

  const parent = dir ? parentOf(dir) : null;

  const remove = async (entry: FsEntry) => {
    setConfirmDelete(null);
    try {
      await del.mutateAsync({ path: entry.path, recursive: entry.isDirectory });
      buzz('done');
      toast(`Deleted ${entry.name}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error');
    }
  };

  const createFolder = async (name: string) => {
    const clean = name.trim();
    setNewFolder(null);
    if (!clean || !dir) return;
    try {
      await mkdir.mutateAsync({ path: `${dir.replace(/\/+$/, '')}/${clean}` });
      buzz('done');
      toast(`Created ${clean}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create folder', 'error');
    }
  };

  return (
    <div className="screen">
      <div className="header">
        <MenuButton />
        <button
          className="icon-btn"
          disabled={!parent}
          onClick={() => {
            buzz('tap');
            if (parent) setDir(parent);
          }}
          aria-label="Up one directory"
        >
          <IconBack size={19} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="header__title" style={{ fontSize: 'var(--type-title-sm)' }}>
            {dir ? basename(dir) : 'Files'}
          </div>
          <div className="files__crumbs" title={dir ?? ''}>
            {dir}
          </div>
        </div>
        {git.data?.branch && (
          <span className="chip" style={{ flexShrink: 0 }}>
            {git.data.branch}
            {git.data.changed > 0 && (
              <span style={{ color: 'var(--warn)', marginLeft: 5 }}>±{git.data.changed}</span>
            )}
          </span>
        )}
      </div>

      {listing.isLoading && !listing.data ? (
        <SkeletonList n={9} h={44} />
      ) : listing.error ? (
        <ErrorNote error={listing.error} />
      ) : (
        <PullToRefresh
          onRefresh={async () => {
            await qc.invalidateQueries({ queryKey: fileKeys.all });
          }}
        >
          <div className="has-fab" style={{ padding: '6px 12px 16px' }}>
            {dirs.length === 0 && files.length === 0 && (
              <Empty icon="📂" title="Empty folder" hint="Nothing here yet." />
            )}

            {[...dirs, ...files].map((entry) => (
              <div className="files__row" key={entry.path}>
                <button
                  className="files__open"
                  onClick={() => {
                    buzz('tap');
                    if (entry.isDirectory) setDir(entry.path);
                    else setViewing(entry.path);
                  }}
                >
                  <span className="files__icon">{entry.isDirectory ? '📁' : '📄'}</span>
                  <span className="files__name">{entry.name}</span>
                  {entry.isDirectory && <span className="files__chevron">›</span>}
                </button>
                <button
                  className="icon-btn icon-btn--danger"
                  aria-label={`Delete ${entry.name}`}
                  onClick={() => {
                    buzz('warn');
                    setConfirmDelete(entry);
                  }}
                >
                  <IconTrash size={16} />
                </button>
              </div>
            ))}
          </div>
        </PullToRefresh>
      )}

      {dir && (
        <button
          className="fab"
          onClick={() => {
            buzz('tap');
            setNewFolder('');
          }}
          aria-label="New folder"
        >
          <IconPlus size={22} />
        </button>
      )}

      <FileViewer path={viewing} onClose={() => setViewing(null)} />

      <Sheet
        open={newFolder !== null}
        title="New folder"
        onClose={() => setNewFolder(null)}
        actions={
          <>
            <button className="btn" onClick={() => setNewFolder(null)}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={!newFolder?.trim()}
              onClick={() => void createFolder(newFolder ?? '')}
            >
              Create
            </button>
          </>
        }
      >
        <input
          autoFocus
          className="field"
          placeholder="folder-name"
          value={newFolder ?? ''}
          onChange={(e) => setNewFolder(e.target.value)}
          style={{ width: '100%' }}
        />
      </Sheet>

      <Sheet
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.name ?? ''}?`}
        onClose={() => setConfirmDelete(null)}
        actions={
          <>
            <button className="btn" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              onClick={() => confirmDelete && void remove(confirmDelete)}
            >
              Delete
            </button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, color: 'var(--text-dim)', margin: 0 }}>
          {confirmDelete?.isDirectory
            ? 'This folder and everything inside it will be deleted from disk. This cannot be undone.'
            : 'This file will be deleted from disk. This cannot be undone.'}
        </p>
      </Sheet>
    </div>
  );
}
