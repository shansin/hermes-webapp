/**
 * An image that lives on the agent's disk.
 *
 * The bytes come back as a data URL from `/api/fs/read-data-url`, which is the
 * same authenticated read the file viewer uses. That matters more than it
 * looks: the transcript is served from the proxy, the picture is not, and the
 * two obvious alternatives both fail — `file://` is blocked outright, and a
 * second origin for raw files would need a credential the phone deliberately
 * never holds.
 *
 * A read that fails is shown, not swallowed. A screenshot the agent took
 * lives in a cache directory that gets cleaned, so "this image is gone" is an
 * ordinary outcome, and a blank space where a picture was reads as the app
 * being broken. The fallback names the file and opens it in the file browser,
 * which is where the answer is.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFileDataUrl } from '../../api/files';
import { imageName } from '../../lib/localImages';
import { ZoomOverlay } from './ZoomOverlay';

export function LocalImage({ path, alt }: { path: string; alt?: string }) {
  const [zoomed, setZoomed] = useState(false);
  const { data, isLoading, isError } = useFileDataUrl(path);
  const name = imageName(path);
  const label = alt?.trim() || name;

  // A `<span>`, not a `<div>`: markdown puts a lone image inside a paragraph,
  // and a block element there is invalid nesting React complains about and the
  // browser silently repairs by splitting the paragraph. The button and link
  // below are phrasing content already, so only this state needed it.
  if (isLoading) {
    return (
      <span className="chat-image chat-image--pending" aria-label={`Loading ${name}`}>
        {name}
      </span>
    );
  }

  if (isError || !data?.dataUrl) {
    return (
      <Link
        className="chat-image chat-image--missing"
        to={`/files?path=${encodeURIComponent(path)}`}
      >
        Couldn&apos;t load {name}
      </Link>
    );
  }

  return (
    <>
      {/* A button around the image rather than a click handler on it, so
          enlarging is reachable by keyboard and announced — same reasoning as
          the diagram block next door. */}
      <button
        type="button"
        className="chat-image__open"
        aria-label={`${label}. Enlarge`}
        onClick={() => setZoomed(true)}
      >
        <img className="chat-image" src={data.dataUrl} alt={label} />
      </button>
      {zoomed && (
        <ZoomOverlay label={label} onClose={() => setZoomed(false)}>
          <img className="zoom__image" src={data.dataUrl} alt={label} />
        </ZoomOverlay>
      )}
    </>
  );
}
