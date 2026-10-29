// Rewards — every finished turn earns the hero a crafting material (rarity-
// weighted, biased toward the tool it was using) and writes a journal line
// per project ("where we left off"). Persisted to ~/.rts-agents/rewards.json.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActivityEvent, AgentState, InventoryEntry, ItemDef, ItemRarity, JournalEntry, RewardsState } from './types';
import { AWARD_COOLDOWN_MS, JOURNAL_PER_PROJECT, MAX_SUMMARY_LEN } from './types';

/** Tool category → which item kinds it tends to yield (mirrors the client's building map). */
type Kind = 'ore' | 'wood' | 'cloth' | 'scroll' | 'beast' | 'gem' | 'potion' | 'stone';

interface CatalogItem extends ItemDef {
  kind: Kind;
}

const RARITY_WEIGHT: Record<ItemRarity, number> = { common: 70, uncommon: 20, rare: 8, epic: 2 };

export const CATALOG: CatalogItem[] = [
  { id: 'iron-ore', name: 'Iron Ore', rarity: 'common', kind: 'ore', lore: 'Dug from the forge floor.' },
  { id: 'copper-ore', name: 'Copper Ore', rarity: 'common', kind: 'ore', lore: 'Warm to the touch.' },
  { id: 'coal-chunk', name: 'Coal Chunk', rarity: 'common', kind: 'ore', lore: 'Fuel for long nights.' },
  { id: 'oak-log', name: 'Oak Log', rarity: 'common', kind: 'wood', lore: 'Felled in the village grove.' },
  { id: 'pine-resin', name: 'Pine Resin', rarity: 'common', kind: 'wood', lore: 'Sticky, fragrant, useful.' },
  { id: 'stone-block', name: 'Stone Block', rarity: 'common', kind: 'stone', lore: 'One more for the wall.' },
  { id: 'clay-lump', name: 'Clay Lump', rarity: 'common', kind: 'stone', lore: 'Shapes anything you need.' },
  { id: 'linen-cloth', name: 'Linen Cloth', rarity: 'common', kind: 'cloth', lore: 'Woven by the library clerks.' },
  { id: 'leather-scrap', name: 'Leather Scrap', rarity: 'common', kind: 'beast', lore: 'Trimmed from a sparring dummy.' },
  { id: 'wheat-bundle', name: 'Wheat Bundle', rarity: 'common', kind: 'potion', lore: 'The tavern brews with it.' },
  { id: 'silver-ore', name: 'Silver Ore', rarity: 'uncommon', kind: 'ore', lore: 'Glints in the lamplight.' },
  { id: 'iron-ingot', name: 'Iron Ingot', rarity: 'uncommon', kind: 'ore', lore: 'Hammered true.' },
  { id: 'steel-ingot', name: 'Steel Ingot', rarity: 'uncommon', kind: 'beast', lore: 'Tempered in the arena.' },
  { id: 'enchanted-thread', name: 'Enchanted Thread', rarity: 'uncommon', kind: 'cloth', lore: 'Never tangles.' },
  { id: 'owl-feather', name: 'Owl Feather', rarity: 'uncommon', kind: 'scroll', lore: 'A scholar\'s quill.' },
  { id: 'beeswax', name: 'Beeswax', rarity: 'uncommon', kind: 'potion', lore: 'Seals the chapel letters.' },
  { id: 'glass-vial', name: 'Glass Vial', rarity: 'uncommon', kind: 'potion', lore: 'Blown by the alchemist.' },
  { id: 'monster-fang', name: 'Monster Fang', rarity: 'uncommon', kind: 'beast', lore: 'Taken, not given.' },
  { id: 'gold-ore', name: 'Gold Ore', rarity: 'rare', kind: 'ore', lore: 'The castle\'s favourite.' },
  { id: 'mithril-shard', name: 'Mithril Shard', rarity: 'rare', kind: 'ore', lore: 'Light as a whisper.' },
  { id: 'sapphire', name: 'Sapphire', rarity: 'rare', kind: 'gem', lore: 'Deep as the pond.' },
  { id: 'emerald', name: 'Emerald', rarity: 'rare', kind: 'gem', lore: 'Green as the meadow.' },
  { id: 'ancient-scroll', name: 'Ancient Scroll', rarity: 'rare', kind: 'scroll', lore: 'The library\'s oldest page.' },
  { id: 'phoenix-feather', name: 'Phoenix Feather', rarity: 'rare', kind: 'scroll', lore: 'Still warm.' },
  { id: 'dragon-scale', name: 'Dragon Scale', rarity: 'epic', kind: 'beast', lore: 'Pried from the Simone lair.' },
  { id: 'star-ruby', name: 'Star Ruby', rarity: 'epic', kind: 'gem', lore: 'Holds a point of light.' },
  { id: 'void-crystal', name: 'Void Crystal', rarity: 'epic', kind: 'potion', lore: 'Hums at the alchemist\'s.' },
  { id: 'philosophers-salt', name: "Philosopher's Salt", rarity: 'epic', kind: 'stone', lore: 'Turns effort into gold.' },
];

/** Same tool → category grouping as the client's spriteMapper, reduced to item kinds. */
function kindForTool(tool: string | null): Kind | null {
  if (!tool) return null;
  if (/^(Read|Glob|LS|Grep|NotebookRead)$/.test(tool)) return 'scroll';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'ore';
  if (/^(Bash|PowerShell|BashOutput|KillShell|Execute)$/.test(tool)) return 'beast';
  if (/^(Task|Agent|Workflow)$/.test(tool)) return 'gem';
  if (/^(TodoRead|TodoWrite|EnterPlanMode|ExitPlanMode)$/.test(tool)) return 'stone';
  if (/^(WebSearch|WebFetch)$/.test(tool)) return 'cloth';
  return 'potion';
}

function pickWeighted<T>(items: T[], weight: (t: T) => number, roll: number): T {
  const total = items.reduce((s, t) => s + weight(t), 0);
  let r = roll * total;
  for (const t of items) {
    r -= weight(t);
    if (r <= 0) return t;
  }
  return items[items.length - 1] as T;
}

/** Roll an item: rarity by weight, 70 % biased to the tool's kind. */
export function rollItem(tool: string | null, rng: () => number = Math.random): CatalogItem {
  const kind = kindForTool(tool);
  const pool = kind && rng() < 0.7 ? CATALOG.filter((i) => i.kind === kind) : CATALOG;
  return pickWeighted(pool.length > 0 ? pool : CATALOG, (i) => RARITY_WEIGHT[i.rarity], rng());
}

/** Every main-chain assistant text block in a transcript, with its timestamp. */
function readAssistantTexts(file: string): { ts: number; text: string }[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: { ts: number; text: string }[] = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"assistant"') || !line.includes('"text"')) continue;
    try {
      const o = JSON.parse(line) as { type?: string; isSidechain?: boolean; timestamp?: string; message?: { content?: unknown } };
      if (o.type !== 'assistant' || o.isSidechain) continue;
      const blocks = Array.isArray(o.message?.content) ? (o.message?.content as { type?: string; text?: string }[]) : [];
      const text = blocks.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => (b.text as string).trim()).join('\n\n');
      const ts = Date.parse(o.timestamp ?? '');
      if (text && Number.isFinite(ts)) out.push({ ts, text: text.slice(0, MAX_SUMMARY_LEN) });
    } catch {
      // malformed line — skip
    }
  }
  return out;
}

interface Persisted {
  inventory: InventoryEntry[];
  journal: JournalEntry[];
}

export class Rewards {
  private inventory: InventoryEntry[] = [];
  private journal: JournalEntry[] = [];
  private seq = 0;
  private lastAwardAt = new Map<string, number>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private listener: ((state: RewardsState, award: JournalEntry) => void) | null = null;

  constructor(private readonly file: string = path.join(os.homedir(), '.rts-agents', 'rewards.json')) {
    this.load();
  }

  onChange(listener: (state: RewardsState, award: JournalEntry) => void): void {
    this.listener = listener;
  }

  getState(): RewardsState {
    return { catalog: CATALOG.map(({ kind: _k, ...def }) => def), inventory: [...this.inventory], journal: [...this.journal] };
  }

  /** Called for every feed event; only `turn_done` on a known agent earns anything. */
  onEvent(event: ActivityEvent, agent: AgentState | undefined): void {
    if (event.kind !== 'turn_done' || !agent) return;
    const summary = agent.lastText ?? event.detail;
    const last = this.lastAwardAt.get(agent.sessionId) ?? 0;
    // Claude flipping to idle again without saying anything new isn't a new finished task.
    const prevEntry = this.journal.find((j) => j.sessionId === agent.sessionId);
    if (prevEntry && summary && prevEntry.summary === summary) return;
    if (event.ts - last < AWARD_COOLDOWN_MS) {
      // Same turn reported twice (Claude's idle flip, then the log line): keep the first award
      // but take the closing text if the first report didn't have it.
      const prev = this.journal.find((j) => j.sessionId === agent.sessionId);
      if (prev && !prev.summary && summary) {
        prev.summary = summary;
        this.scheduleSave();
        this.emit(prev);
      }
      return;
    }
    this.lastAwardAt.set(agent.sessionId, event.ts);

    const item = rollItem(agent.tool);
    const entry = this.inventory.find((e) => e.project === agent.project && e.itemId === item.id);
    if (entry) {
      entry.count += 1;
      entry.lastAt = event.ts;
    } else {
      this.inventory.push({ project: agent.project, itemId: item.id, count: 1, lastAt: event.ts });
    }

    const line: JournalEntry = {
      id: `j${Date.now().toString(36)}${(++this.seq).toString(36)}`,
      ts: event.ts,
      sessionId: agent.sessionId,
      shortId: agent.shortId,
      // Only the /rename name — the auto title is a prompt snippet and may hold secrets.
      sessionName: agent.customTitle,
      project: agent.project,
      cwd: agent.cwd,
      summary,
      itemId: item.id,
    };
    this.journal.unshift(line);
    // Cap per project so one busy repo can't push the others out.
    const seen = new Map<string, number>();
    this.journal = this.journal.filter((j) => {
      const n = (seen.get(j.project) ?? 0) + 1;
      seen.set(j.project, n);
      return n <= JOURNAL_PER_PROJECT;
    });

    this.scheduleSave();
    this.emit(line);
  }

  private emit(entry: JournalEntry): void {
    try {
      this.listener?.(this.getState(), entry);
    } catch (err) {
      console.error('[rts-agents] rewards listener failed:', err);
    }
  }

  /**
   * One-off repair for entries saved without a summary: read each session's transcript and
   * take the last assistant prose written up to that award. Also drops stored prompt-snippet
   * names (they could contain secrets) unless they were a /rename.
   */
  backfill(findTranscript: (sessionId: string) => string | null): void {
    const missing = this.journal.filter((j) => !j.summary);
    const bySession = new Map<string, JournalEntry[]>();
    for (const j of missing) bySession.set(j.sessionId, [...(bySession.get(j.sessionId) ?? []), j]);
    let fixed = 0;
    for (const [sessionId, entries] of bySession) {
      const file = findTranscript(sessionId);
      if (!file) continue;
      const texts = readAssistantTexts(file);
      const used = new Set(this.journal.filter((x) => x.sessionId === sessionId && x.summary).map((x) => x.summary));
      for (const j of entries) {
        // Latest prose at or just after the award (the idle flip can beat the log by a few seconds).
        let best: { ts: number; text: string } | null = null;
        for (const t of texts) {
          if (t.ts <= j.ts + 20_000 && t.ts >= j.ts - 6 * 60 * 60_000 && (!best || t.ts > best.ts)) best = t;
        }
        // Never hand one closing message to several entries — older ones stay "no summary".
        if (best && !used.has(best.text)) {
          j.summary = best.text;
          used.add(best.text);
          fixed += 1;
        }
      }
    }
    if (fixed > 0) {
      console.log(`[rts-agents] rewards: backfilled ${fixed} missing summar${fixed === 1 ? 'y' : 'ies'}`);
      this.scheduleSave();
    }
  }

  stop(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Persisted>;
      if (Array.isArray(raw.inventory)) this.inventory = raw.inventory;
      if (Array.isArray(raw.journal)) this.journal = raw.journal;
      // Older builds stored prompt snippets as names; only keep names that look like a /rename.
      for (const j of this.journal) if (j.sessionName && j.sessionName.length > 40) j.sessionName = null;
      // One closing message belongs to one task: older repeats of the same text lose it.
      const seenText = new Set<string>();
      for (const j of this.journal) {
        if (!j.summary) continue;
        const key = `${j.sessionId}\u0000${j.summary}`;
        if (seenText.has(key)) j.summary = null;
        else seenText.add(key);
      }
    } catch {
      // first run — nothing saved yet
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }

  private save(): void {
    const data: Persisted = { inventory: this.inventory, journal: this.journal };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[rts-agents] could not save rewards to ${this.file}:`, err);
    }
  }
}
