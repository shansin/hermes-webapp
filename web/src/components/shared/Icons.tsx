/**
 * Inline SVG icons — no icon-font dependency, and they inherit `currentColor`
 * so they follow the theme automatically.
 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 22, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconMenu = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" />
  </Svg>
);

export const IconChat = (p: P) => (
  <Svg {...p}>
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-5A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
  </Svg>
);

export const IconSessions = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18M3 12h18M3 18h13" />
  </Svg>
);

export const IconKanban = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="6" height="13" rx="1.4" />
    <rect x="14" y="3" width="6" height="9" rx="1.4" />
  </Svg>
);

export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </Svg>
);

export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconMic = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
  </Svg>
);

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);

export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

export const IconDown = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </Svg>
);

export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </Svg>
);

export const IconCopy = (p: P) => (
  <Svg {...p} size={p.size ?? 14}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Svg>
);

export const IconSpeaker = (p: P) => (
  <Svg {...p} size={p.size ?? 15}>
    <path d="M11 5 6 9H2v6h4l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
  </Svg>
);

export const IconPaperclip = (p: P) => (
  <Svg {...p}>
    <path d="M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8" />
  </Svg>
);

export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="m7 4 12 8-12 8V4Z" />
  </Svg>
);

export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M8 4v16M16 4v16" />
  </Svg>
);

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </Svg>
);

export const IconWarn = (p: P) => (
  <Svg {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);

// --- Hub sections, promoted to top-level drawer destinations -----------------
//
// Drawn for 21px: at that size an outline with interior detail (a toothed gear,
// an anatomical brain) collapses into a smudge, so each of these is a single
// closed silhouette plus at most two interior strokes.

/** Memory files. An open book: a closed one is a rectangle with a line in it,
 *  which reads as a sidebar layout rather than something you read. */
export const IconMemory = (p: P) => (
  <Svg {...p}>
    <path d="M12 7.2C10.2 5.8 7.9 5.2 5.4 5.4a.9.9 0 0 0-.9.9v10.2c0 .5.4.9.9.9 2.5-.2 4.8.4 6.6 1.8 1.8-1.4 4.1-2 6.6-1.8.5 0 .9-.4.9-.9V6.3a.9.9 0 0 0-.9-.9c-2.5-.2-4.8.4-6.6 1.8Z" />
    <path d="M12 7.2v12" />
  </Svg>
);

/** Skills — what the agent can do. A bolt: the puzzle piece every extension UI
 *  reaches for needs its knobs read individually, and at 21px they merge into a
 *  blob. One diagonal silhouette survives the size. */
export const IconSkills = (p: P) => (
  <Svg {...p}>
    <path d="M13.4 3.5 5.8 13.1a.6.6 0 0 0 .5 1h4.3l-1 6.4 7.6-9.6a.6.6 0 0 0-.5-1h-4.3Z" />
  </Svg>
);

/** Scheduled jobs. */
export const IconCron = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12.4" r="7.6" />
    <path d="M12 8.2v4.4l3 1.8" />
  </Svg>
);

/** Models. A cube: one object, three visible faces, reads at any size. */
export const IconModels = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.6 19.5 8v8L12 20.4 4.5 16V8Z" />
    <path d="m4.5 8 7.5 4.4L19.5 8" />
    <path d="M12 12.4v8" />
  </Svg>
);

/** Config profiles — an ID card rather than a person: these name setups, not people. */
export const IconProfiles = (p: P) => (
  <Svg {...p}>
    <rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.2" />
    <circle cx="8.9" cy="10.9" r="1.9" />
    <path d="M5.8 15.9a3.3 3.3 0 0 1 6.2 0M14.6 10.2h3.5M14.6 13.4h3.5" />
  </Svg>
);

/** Settings. Sliders, not a gear: gear teeth turn to mush at 21px, and the sun
 *  shape a simple gear degrades into collides with the theme picker it sits next to. */
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 8h15M4.5 16h15" />
    <circle cx="9.5" cy="8" r="2.3" />
    <circle cx="15" cy="16" r="2.3" />
  </Svg>
);
