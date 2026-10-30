// World registry: maps a session's cwd to a *place* on the map (a city, a
// dungeon, a lair, or a wild spot) and the *repo* inside it. Static entries
// below are the user's known projects; anything unknown auto-pops as a wild
// place and is remembered in localStorage so it stays on the map.
//
// Matching is by path segment (case-insensitive), most specific first.

export type PlaceKind = 'tavern' | 'city' | 'dungeon' | 'lair' | 'wild';

/** Visual hint for wild places; unset → chosen deterministically from the id hash. */
export type WildLandmark = 'tower' | 'cottage' | 'ruins' | 'stones' | 'grove' | 'camp' | 'windmill' | 'shrine';

export interface RepoDef {
  id: string;
  name: string;
  /** Path segments (any order, case-insensitive) that must all appear in the cwd. */
  match: string[];
  /** Absolute cwd to start a fresh Claude Code session in. */
  cwd: string;
  /** Fallback: words in the session title that pick this repo (used only when the cwd didn't resolve). */
  titleMatch?: string[];
}

export interface PlaceDef {
  id: string;
  name: string;
  kind: PlaceKind;
  /** Short flavour line shown on hover / in the party card. */
  tagline: string;
  /** Path segments that put a cwd inside this place when no repo matched. */
  match: string[];
  /** Fallback: words in the session title that place it here (Lovable projects have no local cwd). */
  titleMatch?: string[];
  /** Wild places only: which landmark to draw on the map. */
  landmark?: WildLandmark;
  repos: RepoDef[];
}

export interface ResolvedPlace {
  place: PlaceDef;
  /** Null when the cwd is inside the place but not a known repo. */
  repo: RepoDef | null;
}

const CODING_ROOT = 'G:\\daniels things\\coding';
const SIF_ROOT = `${CODING_ROOT}\\work\\SIF FW`;

export const PLACES: PlaceDef[] = [
  {
    id: 'sif',
    name: 'SIF',
    kind: 'city',
    tagline: 'The walled city of Sports In Focus',
    match: ['SIF FW'],
    repos: [
      { id: 'flashworks', name: 'FlashWorks', match: ['flashworks-framework-v2'], cwd: `${SIF_ROOT}\\flashworks-framework-v2` },
      { id: 'sif-external', name: 'External API', match: ['sif-external-api'], cwd: `${SIF_ROOT}\\sif-external-api` },
      { id: 'sif-uploader', name: 'Photographer Tool', match: ['photographer-uploader-v2'], cwd: `${SIF_ROOT}\\photographer-uploader-v2` },
      { id: 'sif-old', name: 'Old Portal', match: ['sportsinfocus.com.au_v2'], cwd: `${SIF_ROOT}\\sportsinfocus.com.au_v2` },
      { id: 'sif-events', name: 'Event Management', match: ['event-management-app-v2'], cwd: `${SIF_ROOT}\\event-management-app-v2` },
      { id: 'sif-checkin', name: 'Check-in App', match: ['sif-checkin-app'], cwd: `${SIF_ROOT}\\sif-checkin-app` },
      { id: 'sif-photos', name: 'Individual Photos', match: ['individual-photo-system'], cwd: `${SIF_ROOT}\\individual-photo-system` },
    ],
  },
  {
    id: 'habits',
    name: 'HABITS',
    kind: 'city',
    tagline: 'City of the Lovable portals',
    match: ['HABITS'],
    titleMatch: ['habits', 'lovable', 'collegiate', 'pixel perfect', 'hr hub', 'bm360', 'affinity', 'internal portal', 'h365'],
    repos: [
      { id: 'habits-internal', name: 'Internal Portal', match: ['HABITS', 'internal'], cwd: `${CODING_ROOT}\\work\\HABITS`, titleMatch: ['internal', 'h365'] },
      { id: 'habits-collegiate', name: 'Collegiate', match: ['HABITS', 'collegiate'], cwd: `${CODING_ROOT}\\work\\HABITS`, titleMatch: ['collegiate', 'bm360', 'affinity', 'licens'] },
      { id: 'habits-pixel', name: 'Pixel Perfect', match: ['HABITS', 'pixel'], cwd: `${CODING_ROOT}\\work\\HABITS`, titleMatch: ['pixel'] },
      { id: 'habits-hr', name: 'HR Hub', match: ['HABITS', 'hr'], cwd: `${CODING_ROOT}\\work\\HABITS`, titleMatch: ['hr hub', 'hr portal', 'hrms'] },
    ],
  },
  {
    id: 'momma',
    name: 'Momma Mia',
    kind: 'dungeon',
    tagline: 'The catering dungeon — beware the egress',
    match: ['momma-mia-catering-website'],
    repos: [
      { id: 'momma-web', name: 'Web', match: ['momma-mia-catering-website', 'web'], cwd: `${CODING_ROOT}\\momma-mia-catering-website\\apps\\web` },
      { id: 'momma-mobile', name: 'Mobile', match: ['momma-mia-catering-website', 'mobile'], cwd: `${CODING_ROOT}\\momma-mia-catering-website\\apps\\mobile` },
      { id: 'momma-supabase', name: 'Supabase', match: ['momma-mia-catering-website', 'supabase'], cwd: `${CODING_ROOT}\\momma-mia-catering-website\\supabase` },
      { id: 'momma-root', name: 'Monorepo', match: ['momma-mia-catering-website'], cwd: `${CODING_ROOT}\\momma-mia-catering-website` },
    ],
  },
  {
    id: 'simone',
    name: 'Simone',
    kind: 'lair',
    tagline: "The dragon's lair — brand outreach & media kit",
    match: ['simone'],
    repos: [
      { id: 'brand-outreach-studio', name: 'Outreach Studio', match: ['brand-outreach-studio'], cwd: `${CODING_ROOT}\\simone\\brand-outreach-studio` },
      { id: 'newsance', name: 'Newsance', match: ['newsance'], cwd: `${CODING_ROOT}\\simone\\newsance` },
    ],
  },
  {
    id: 'portfolio',
    name: 'Portfolio',
    kind: 'wild',
    tagline: 'A lone tower on the hill',
    match: ['My Portfolio'],
    landmark: 'tower',
    repos: [{ id: 'my-portfolio', name: 'my-portfolio', match: ['my-portfolio'], cwd: `${CODING_ROOT}\\My Portfolio\\my-portfolio` }],
  },
  {
    id: 'rts-agents',
    name: 'The Village',
    kind: 'wild',
    tagline: 'This very dashboard',
    match: ['rts-agents'],
    landmark: 'cottage',
    repos: [{ id: 'rts-agents', name: 'rts-agents', match: ['rts-agents'], cwd: `${CODING_ROOT}\\rts-agents` }],
  },
];

/** Hero home when the cwd is the coding root or unknown. */
export const TAVERN_PLACE: PlaceDef = {
  id: 'tavern',
  name: 'The Tavern',
  kind: 'tavern',
  tagline: 'Where every quest begins',
  match: [],
  repos: [],
};

const WILD_STORAGE_KEY = 'rts-agents.wild-places.v1';

/** Auto-discovered places (unknown cwds), persisted so they stay on the map. */
export interface WildPlace {
  id: string;
  name: string;
  cwd: string;
  firstSeenAt: number;
}

/** Temp / scratch / config folders are where tools run, not projects — never a place on the map. */
export function isScratchCwd(cwd: string): boolean {
  const segs = segments(cwd).map((s) => s.toLowerCase());
  // macOS per-user temp: /var/folders/<xx>/<id>/T/… (claude reports it as /private/var/folders/…).
  const macTemp = segs.some((s, i) => s === 'var' && segs[i + 1] === 'folders');
  return macTemp || segs.includes('temp') || segs.includes('tmp') || segs.includes('.claude') || segs.includes('scratchpad');
}

export function loadWildPlaces(): WildPlace[] {
  try {
    const raw = localStorage.getItem(WILD_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (p): p is WildPlace =>
            typeof p === 'object' &&
            p !== null &&
            typeof (p as WildPlace).cwd === 'string' &&
            !isScratchCwd((p as WildPlace).cwd) // drops the old "Temp" landmark
        )
      : [];
  } catch {
    return [];
  }
}

function saveWildPlaces(places: WildPlace[]): void {
  try {
    localStorage.setItem(WILD_STORAGE_KEY, JSON.stringify(places));
  } catch {
    // storage unavailable — the place still lives for this page load
  }
}

function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

function segmentsInclude(segs: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return segs.some((s) => s.toLowerCase() === n);
}

function matchesAll(segs: string[], needles: string[]): boolean {
  return needles.length > 0 && needles.every((n) => segmentsInclude(segs, n));
}

export function wildPlaceToDef(w: WildPlace): PlaceDef {
  return {
    id: w.id,
    name: w.name,
    kind: 'wild',
    tagline: 'Uncharted lands',
    match: [],
    repos: [{ id: w.id, name: w.name, match: [], cwd: w.cwd }],
  };
}

/** Is this cwd the bare coding root (or above it)? Those sessions live at the tavern. */
export function isRootCwd(cwd: string): boolean {
  const segs = segments(cwd);
  const rootSegs = segments(CODING_ROOT);
  return segs.length <= rootSegs.length;
}

/**
 * Resolve a cwd to a place + repo. Static places first (most specific repo
 * wins), then remembered wild places, then null (caller decides whether to
 * auto-pop via `rememberWildPlace`).
 */
export function resolvePlace(cwd: string | null, wild: WildPlace[] = loadWildPlaces()): ResolvedPlace | null {
  if (!cwd) return null;
  const segs = segments(cwd);
  for (const place of PLACES) {
    // Longest match list first so "momma + web" beats "momma" alone.
    const repos = [...place.repos].sort((a, b) => b.match.length - a.match.length);
    for (const repo of repos) {
      if (matchesAll(segs, repo.match)) return { place, repo };
    }
    if (matchesAll(segs, place.match)) return { place, repo: null };
  }
  for (const w of wild) {
    if (cwd.toLowerCase().startsWith(w.cwd.toLowerCase())) {
      const def = wildPlaceToDef(w);
      return { place: def, repo: def.repos[0] ?? null };
    }
  }
  return null;
}

/**
 * Resolve where an agent lives: latest cwd, then launch cwd, then title
 * keywords (for sessions that never leave the coding root, e.g. Lovable work).
 * Null means "lives at the tavern".
 */
export function resolveAgentPlace(
  a: {
    cwd: string | null;
    rootCwd: string | null;
    title: string | null;
    customTitle: string | null;
    workPath?: string | null;
    recentPaths?: string[];
  },
  wild: WildPlace[] = loadWildPlaces()
): ResolvedPlace | null {
  // The path the latest tool touched wins, but only when it lands in a known project —
  // stray paths (scratchpads, ~/.claude) must not drag a hero off the map.
  for (const p of a.recentPaths ?? (a.workPath ? [a.workPath] : [])) {
    const byWork = resolvePlace(p, []);
    if (byWork) return byWork;
  }
  const byCwd = resolvePlace(a.cwd, wild) ?? resolvePlace(a.rootCwd, wild);
  if (byCwd) return byCwd;
  const text = `${a.customTitle ?? ''} ${a.title ?? ''}`.toLowerCase();
  if (!text.trim()) return null;
  for (const place of PLACES) {
    if (!place.titleMatch?.some((w) => text.includes(w.toLowerCase()))) continue;
    const repo = place.repos.find((r) => r.titleMatch?.some((w) => text.includes(w.toLowerCase()))) ?? null;
    return { place, repo };
  }
  return null;
}

/**
 * Register an unknown cwd as a new wild place (idempotent). Returns the
 * updated list. The place is named after the cwd's last segment.
 */
export function rememberWildPlace(cwd: string, wild: WildPlace[] = loadWildPlaces()): WildPlace[] {
  if (isRootCwd(cwd) || isScratchCwd(cwd) || resolvePlace(cwd, wild)) return wild;
  const name = segments(cwd).at(-1) ?? cwd;
  const next = [...wild, { id: `wild-${hashString(cwd).toString(36)}`, name, cwd, firstSeenAt: Date.now() }];
  saveWildPlaces(next);
  return next;
}

/** All places including remembered wild ones (static order first). */
export function allPlaces(wild: WildPlace[] = loadWildPlaces()): PlaceDef[] {
  return [...PLACES, ...wild.map(wildPlaceToDef)];
}

/** FNV-1a 32-bit — same as spriteMapper.hashString, duplicated to keep this module dependency-free. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
