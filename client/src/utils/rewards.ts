// Rewards helpers shared by the backpack (quest log) and toasts: catalog lookup,
// project → place/repo resolution, date grouping and relative times.

import type { ItemDef, JournalEntry, RewardsState } from '../types/agent';
import { allPlaces, isRootCwd, isScratchCwd, PLACES, resolvePlace, TAVERN_PLACE } from '../world/registry';
import type { PlaceDef, RepoDef } from '../world/registry';

/** Placeholder for ids the catalog no longer knows. */
const UNKNOWN_ITEM: ItemDef = { id: 'unknown', name: 'Unknown Item', rarity: 'common', lore: 'Lost to the archives.' };

export function catalogMap(rewards: RewardsState | null): Map<string, ItemDef> {
  const m = new Map<string, ItemDef>();
  for (const it of rewards?.catalog ?? []) m.set(it.id, it);
  return m;
}

export function lookupItem(catalog: Map<string, ItemDef>, itemId: string | null): ItemDef {
  return (itemId && catalog.get(itemId)) || { ...UNKNOWN_ITEM, id: itemId ?? 'unknown' };
}

/** Projects seen in the inventory or journal, most recently active first. */
export function projectList(rewards: RewardsState | null): string[] {
  const last = new Map<string, number>();
  for (const e of rewards?.inventory ?? []) last.set(e.project, Math.max(last.get(e.project) ?? 0, e.lastAt));
  for (const j of rewards?.journal ?? []) last.set(j.project, Math.max(last.get(j.project) ?? 0, j.ts));
  return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

// ── Place → project grouping ─────────────────────────────────────────────────

/** Catch-all for scratch, temp and tool-output folders (never a map place). */
export const WILDERNESS_PLACE: PlaceDef = {
  id: 'wilderness',
  name: 'Wilderness',
  kind: 'wild',
  tagline: 'Scratch folders and stray camps',
  match: [],
  repos: [],
};

/** Where a project's rewards are filed: a map place (+ repo), the Tavern or the Wilderness. */
export interface ProjectHome {
  place: PlaceDef;
  repo: RepoDef | null;
  /** True for real map places — their headers open the quest chooser. */
  onMap: boolean;
}

/** Folder names that hold tool output (handoffs, test results), not projects. */
const OUTPUT_DIR = /^(handoffs?|results?(-.*)?|test-results|output|out|logs?|scratch(pad)?|te?mp)$/i;
/** Basename of the coding root, used when a root project has no journal cwd. */
const ROOT_NAME = 'coding';

const lastSeg = (p: string): string => p.split(/[\\/]+/).filter(Boolean).at(-1) ?? p;

/** Repo/place by project name; multi-segment match lists ("momma + web") are too generic alone. */
function homeByName(project: string, places: PlaceDef[]): ProjectHome | null {
  const p = project.toLowerCase();
  for (const place of places) {
    for (const repo of place.repos) {
      const names = [repo.id, repo.name, ...(repo.match.length === 1 ? repo.match : [])];
      if (names.some((s) => s.toLowerCase() === p)) return { place, repo, onMap: true };
    }
    if ([place.id, place.name, ...place.match].some((s) => s.toLowerCase() === p)) return { place, repo: null, onMap: true };
  }
  return null;
}

/** Name match, else the journal cwd (folds sub-folders like "v2" into their repo), else Wilderness. */
export function resolveProjectHome(project: string, cwd: string | null): ProjectHome {
  const tavern: ProjectHome = { place: TAVERN_PLACE, repo: null, onMap: false };
  const wilderness: ProjectHome = { place: WILDERNESS_PLACE, repo: null, onMap: false };
  if (OUTPUT_DIR.test(project)) return wilderness;
  const places = allPlaces().filter((pl) => !OUTPUT_DIR.test(pl.name));
  const byName = homeByName(project, places);
  if (byName) return byName;
  if (!cwd) return project.toLowerCase() === ROOT_NAME ? tavern : wilderness;
  if (isScratchCwd(cwd)) return wilderness;
  if (isRootCwd(cwd)) return tavern;
  const hit = resolvePlace(cwd);
  // Remembered wild places named like output folders still count as scratch.
  if (!hit || OUTPUT_DIR.test(lastSeg(hit.repo?.cwd ?? hit.place.name))) return wilderness;
  return { place: hit.place, repo: hit.repo, onMap: true };
}

/** Newest journal cwd per project (inventory rows carry none). */
function latestCwds(rewards: RewardsState | null): Map<string, string> {
  const best = new Map<string, { ts: number; cwd: string }>();
  for (const j of rewards?.journal ?? []) {
    if (!j.cwd) continue;
    const cur = best.get(j.project);
    if (!cur || j.ts > cur.ts) best.set(j.project, { ts: j.ts, cwd: j.cwd });
  }
  return new Map([...best].map(([p, v]) => [p, v.cwd]));
}

export function projectHomes(rewards: RewardsState | null): Map<string, ProjectHome> {
  const cwds = latestCwds(rewards);
  const m = new Map<string, ProjectHome>();
  for (const p of projectList(rewards)) m.set(p, resolveProjectHome(p, cwds.get(p) ?? null));
  return m;
}

/** Stable sub-group key: the repo, or the raw project when the place has no matching repo. */
export function subKeyOf(home: ProjectHome, project: string): string {
  return `${home.place.id}/${home.repo ? home.repo.id : `~${project}`}`;
}

/** "SIF · FlashWorks", or the place alone (plus the raw folder when no repo matched). */
export function homeLabel(home: ProjectHome, project: string): string {
  if (home.repo) return home.repo.name === home.place.name ? home.place.name : `${home.place.name} · ${home.repo.name}`;
  if (home.place.id === TAVERN_PLACE.id) return home.place.name;
  return project.toLowerCase() === home.place.name.toLowerCase() ? home.place.name : `${home.place.name} · ${project}`;
}

/** Resolve a journal entry's home, preferring the per-project cache. */
/** Handoff docs (`/handoff`, handoffs/…) get their own shelf in the backpack. */
export const HANDOFFS_PLACE: PlaceDef = {
  id: 'handoffs',
  name: 'Handoffs',
  kind: 'wild',
  tagline: 'Sessions handed over to the next one',
  match: [],
  repos: [],
};

const HANDOFF_RE = /(^|[\\/])handoffs?([\\/]|$)/i;

/** A place by the session name / project name keywords (PIXEL PERF → HABITS · Pixel Perfect). */
function homeByTitle(text: string): ProjectHome | null {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  for (const place of PLACES) {
    if (!place.titleMatch?.some((w) => t.includes(w.toLowerCase()))) continue;
    const repo = place.repos.find((r) => r.titleMatch?.some((w) => t.includes(w.toLowerCase()))) ?? null;
    return { place, repo, onMap: true };
  }
  return null;
}

/**
 * Where a quest-log entry belongs. The folder decides when it names a project; sessions run from
 * the coding root (most of them on the Mac) or a scratch folder are filed by their session name,
 * and handoff runs get the Handoffs shelf. What's left stays Tavern / Wilderness (All only).
 */
export function entryHome(j: JournalEntry, homes: Map<string, ProjectHome>): ProjectHome {
  const base = homes.get(j.project) ?? resolveProjectHome(j.project, j.cwd);
  if (base.place.id !== TAVERN_PLACE.id && base.place.id !== WILDERNESS_PLACE.id) return base;
  if (HANDOFF_RE.test(j.project) || HANDOFF_RE.test(j.cwd ?? '')) return { place: HANDOFFS_PLACE, repo: null, onMap: false };
  return homeByTitle(`${j.sessionName ?? ''} ${j.project}`) ?? base;
}

/** Places that never get a filter chip: their entries are the leftovers, shown under All. */
export const NO_CHIP_PLACES = new Set([TAVERN_PLACE.id, WILDERNESS_PLACE.id]);

export interface RewardsSubGroup {
  key: string;
  name: string;
  home: ProjectHome;
  /** Raw project names folded into this sub-group (e.g. "flashworks-framework-v2", "v2"). */
  projects: string[];
}

export interface RewardsPlaceGroup {
  place: PlaceDef;
  subs: RewardsSubGroup[];
}

/** Places in registry order, then the Tavern, then the Wilderness; repos in registry order. */
export function groupProjects(projects: string[], homes: Map<string, ProjectHome>): RewardsPlaceGroup[] {
  const order = [...allPlaces().map((p) => p.id), TAVERN_PLACE.id, WILDERNESS_PLACE.id];
  const groups = new Map<string, RewardsPlaceGroup>();
  for (const project of projects) {
    const home = homes.get(project) ?? resolveProjectHome(project, null);
    let g = groups.get(home.place.id);
    if (!g) groups.set(home.place.id, (g = { place: home.place, subs: [] }));
    const key = subKeyOf(home, project);
    const sub = g.subs.find((s) => s.key === key);
    if (sub) sub.projects.push(project);
    else g.subs.push({ key, name: home.repo?.name ?? project, home, projects: [project] });
  }
  const rank = (id: string): number => {
    const i = order.indexOf(id);
    return i < 0 ? order.length - 2 : i; // unknown wild ids sit just before the Tavern
  };
  const repoRank = (s: RewardsSubGroup): number => {
    const i = s.home.repo ? s.home.place.repos.findIndex((r) => r.id === s.home.repo?.id) : -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const out = [...groups.values()].sort((a, b) => rank(a.place.id) - rank(b.place.id));
  // Stable sort keeps recency order among subs without a registry repo.
  for (const g of out) g.subs.sort((a, b) => repoRank(a) - repoRank(b));
  return out;
}

// ── Time ─────────────────────────────────────────────────────────────────────

export function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local calendar day, e.g. "2026-10-18" — groups the quest log. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** "Today", "Yesterday", "Oct 15" (year added when it isn't this year). */
export function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  if (dayKey(ts) === dayKey(now)) return 'Today';
  if (dayKey(ts) === dayKey(now - 86_400_000)) return 'Yesterday';
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

// ── Quest-log text: summaries are the hero's raw markdown closing message ──

/** Markdown → readable plain text: drops headings marks, tables, code fences, emphasis, links. */
export function cleanSummary(md: string): string {
  return md
    // Drop the tutor preface paragraph ("> 🎓 **Tutor** …") and inline images.
    .replace(/^\s*(?:>\s*)?(?:\*\*)?🎓[^\n]*(?:\n(?!\s*\n)[^\n]*)*\n*/u, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\|?\s*:?-{3,}/.test(l)) // table separator rows
    .map((l) =>
      l
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/^[-*+]\s+/, '• ')
        .replace(/^\|(.*)\|$/, '$1')
        .replace(/\s*\|\s*/g, ' · ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
    )
    .join('\n')
    .trim();
}

/** One line for the row: the gist's lead and step headings (the popover has the rest). */
export function summaryPreview(md: string | null): string | null {
  if (!md) return null;
  const text = conciseSummary(md)
    .split('\n')
    .map((l) => l.replace(/^•\s*/, '').trim())
    .filter((l) => l && !/^\+\d+ more$/.test(l))
    .join(' · ');
  return text || null;
}

const LEAD_MAX = 170;
const STEP_MAX = 64;
const MAX_STEPS = 4;
const LIST_RE = /^(?:\d+[.)]|•)\s+/;

/** Cut at a word boundary with an ellipsis. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 12)).replace(/[\s,;:–—-]+$/, '')}…`;
}

/**
 * The gist of a closing message: its first sentence, then one short heading per listed step
 * ("• sif-external to master"). The popover shows this; the full text is one click away.
 */
export function conciseSummary(md: string): string {
  const lines = cleanSummary(md).split('\n').filter(Boolean);
  const prose = lines.filter((l) => !LIST_RE.test(l));
  const firstProse = prose[0] ?? '';
  const sentence = /^.+?[.!?](?=\s|$)/.exec(firstProse)?.[0] ?? firstProse;
  const lead = clip(sentence, LEAD_MAX);
  const steps = lines
    .filter((l) => LIST_RE.test(l))
    .slice(0, MAX_STEPS)
    .map((l) => {
      const body = l.replace(LIST_RE, '');
      // The step's heading: up to its first sentence end or colon.
      const head = /^.+?(?:[.!?:](?=\s|$))/.exec(body)?.[0].replace(/[.:]$/, '') ?? body;
      return `• ${clip(head, STEP_MAX)}`;
    });
  const more = lines.filter((l) => LIST_RE.test(l)).length - steps.length;
  return [lead, ...steps, ...(more > 0 ? [`  +${more} more`] : [])].filter(Boolean).join('\n');
}

/** Name for a quest-log row: the /rename name, else the hero's current name, else "Nameless" (never an id). */
export function entryName(j: { sessionId: string; sessionName: string | null }, agents: { sessionId: string; customTitle: string | null }[]): string {
  return j.sessionName ?? agents.find((a) => a.sessionId === j.sessionId)?.customTitle ?? 'Nameless';
}
