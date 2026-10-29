// SessionParser — per-session incremental JSONL parsing.
// One instance per session file. feed() accepts arbitrary chunk boundaries and
// never throws on malformed/unknown lines. See PROTOCOL.md "Status derivation".

import type { AgentStatus } from './types';
import { MAX_DETAIL_LEN, MAX_SUMMARY_LEN } from './types';

/** Feed-event kinds a parser can emit (session lifecycle kinds come from the store). */
export type ParsedEventKind = 'tool_start' | 'tool_done' | 'tool_error' | 'thinking' | 'turn_done';

export interface ParsedEvent {
  kind: ParsedEventKind;
  tool: string | null;
  detail: string | null;
  /** tool_error only: absolute paths the failing tool was working on (where the bug lives). */
  paths?: string[];
}

/** The effect of one parsed log line on its session. Consumed by AgentStore. */
export interface SessionUpdate {
  /** Epoch ms — the line's ISO timestamp when present, else the previous line's, else now. */
  ts: number;
  status?: AgentStatus;
  /** Present only when this line names a current tool (tool_start). */
  tool?: string | null;
  detail?: string | null;
  model?: string;
  cwd?: string;
  gitBranch?: string;
  /** Latest assistant prose (raw, ≤ MAX_SUMMARY_LEN) — the closing summary once the turn ends. */
  lastText?: string;
  /** Absolute paths the latest tool touched (file input or paths in a shell command). */
  workPaths?: string[];
  /** User-chosen name from a `custom-title` / `agent-name` line (/rename). */
  customTitle?: string;
  /** Title from an `ai-title` line (highest precedence). */
  aiTitle?: string;
  /** Title candidate from a real user prompt (middle precedence; store keeps the first). */
  promptTitle?: string;
  /** Title candidate from a `last-prompt` line (lowest precedence). */
  lastPromptTitle?: string;
  /** Feed events produced by this line (often empty or a single entry). */
  events: ParsedEvent[];
}

const TERMINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);
const TITLE_SNIPPET_LEN = 60;
const MAX_PENDING_TOOLS = 512;
/** Warn about sustained skipping once this many lines were skipped with zero parsed. */
const SKIP_WARN_THRESHOLD = 25;
/** Model id Claude Code stamps on synthetic notice lines (API errors etc.). */
const SYNTHETIC_MODEL = '<synthetic>';

// ── small safe-access helpers ────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function truncateDetail(s: string): string | null {
  const c = collapse(s);
  return c.length > 0 ? clamp(c, MAX_DETAIL_LEN) : null;
}

/** Last path segment, handling both `/` and `\` separators (logs may come from any OS). */
export function lastPathSegment(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).at(-1) ?? trimmed;
}

/** Extract `detail` from a tool_use input per PROTOCOL.md rules. */
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\/[a-z]\/)[^"'`|;&<>\r\n]*/;

/** Normalise "/g/foo/bar" (Git Bash) to "G:\foo\bar"; leave Windows paths as they are. */
function toWinPath(p: string): string {
  const m = /^\/([a-z])\/(.*)$/.exec(p);
  return (m ? `${(m[1] as string).toUpperCase()}:\\${m[2]}` : p).replace(/\//g, '\\').replace(/[\\]+$/, '');
}

/**
 * Where the tool is really working: an absolute file/dir path from its input, or the
 * first absolute path in a shell command (`cd "G:/…/repo" && …`). Sessions often stay
 * in the coding root while touching a repo, so this places the hero better than `cwd`.
 */
function extractWorkPaths(input: unknown): string[] {
  const obj = asRecord(input);
  if (!obj) return [];
  const out: string[] = [];
  for (const key of ['file_path', 'notebook_path', 'path'] as const) {
    const v = asString(obj[key])?.trim();
    if (v && ABS_PATH_RE.test(v)) out.push(toWinPath(v));
  }
  const command = asString(obj['command']);
  if (command) {
    // Every absolute path in the command (quoted ones may contain spaces), first 4.
    const re = /["']((?:[A-Za-z]:[\\/]|\/[a-z]\/)[^"']+)["']|((?:[A-Za-z]:[\\/]|\/[a-z]\/)[^\s"'`|;&<>]+)/g;
    for (const m of command.matchAll(re)) {
      const raw = (m[1] ?? m[2] ?? '').trim();
      if (raw) out.push(toWinPath(raw));
      if (out.length >= 4) break;
    }
  }
  return out;
}

function extractDetail(input: unknown): string | null {
  const obj = asRecord(input);
  if (!obj) return null;

  const filePath = asString(obj['file_path']);
  if (filePath && filePath.trim()) return truncateDetail(lastPathSegment(filePath.trim()));

  const command = asString(obj['command']);
  if (command && command.trim()) return truncateDetail(command);

  for (const key of ['pattern', 'query', 'url'] as const) {
    const v = asString(obj[key]);
    if (v && v.trim()) return truncateDetail(v);
  }

  const description = asString(obj['description']);
  if (description && description.trim()) return truncateDetail(description);

  const prompt = asString(obj['prompt']);
  if (prompt && prompt.trim()) return truncateDetail(prompt);

  const todos = obj['todos'];
  if (Array.isArray(todos)) return `${todos.length} todos`;

  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return truncateDetail(v);
  }
  return null;
}

/** Pull a text snippet out of a tool_result `content` (string or block array). */
function resultSnippet(content: unknown): string | null {
  if (typeof content === 'string') return truncateDetail(content);
  if (Array.isArray(content)) {
    for (const b of content) {
      const block = asRecord(b);
      if (!block) continue;
      const text = asString(block['text']);
      if (text && text.trim()) return truncateDetail(text);
    }
  }
  return null;
}

/** First text block of a user message content array, or null. */
function firstTextBlock(blocks: unknown[] | null): string | null {
  if (!blocks) return null;
  for (const b of blocks) {
    const block = asRecord(b);
    if (!block) continue;
    if (asString(block['type']) === 'text') {
      const text = asString(block['text']);
      if (text) return text;
    }
  }
  return null;
}

// ── parser ───────────────────────────────────────────────────────────────────

export class SessionParser {
  /** Trailing partial line carried between feed() calls. */
  private carry = '';
  /** Last status this parser derived — used for thinking-transition detection. */
  private lastStatus: AgentStatus | null = null;
  /** Latest assistant prose on the main chain (the turn's closing words once it ends). */
  private lastText: string | null = null;
  /** Last line timestamp seen — fallback for timestamp-less lines (ai-title…). */
  private lastTs: number | null = null;
  /** tool_use id → tool name, so tool_done/tool_error can name the finished tool. */
  private readonly pendingTools = new Map<string, string>();
  /** tool_use id → paths it touched, so a later error knows where it happened. */
  private readonly pendingPaths = new Map<string, string[]>();
  // Diagnostics — skipping lines is per spec, but it must never be invisible.
  private linesParsed = 0;
  private linesSkippedJson = 0;
  private linesSkippedThrow = 0;
  private warnedJsonSkip = false;
  private warnedSustainedSkip = false;
  private loggedThrow = false;

  /** `label` identifies this session in diagnostics (e.g. the short session id). */
  constructor(private readonly label: string = '?') {}

  /** Diagnostic counters: parsed lines vs skipped (malformed JSON / thrown bug). */
  getCounters(): { linesParsed: number; linesSkippedJson: number; linesSkippedThrow: number } {
    return {
      linesParsed: this.linesParsed,
      linesSkippedJson: this.linesSkippedJson,
      linesSkippedThrow: this.linesSkippedThrow,
    };
  }

  /** Parse a chunk (arbitrary boundaries). Returns updates for complete lines only. */
  feed(chunk: string): SessionUpdate[] {
    if (!chunk.includes('\n')) {
      // No complete line yet — just grow the carry. Re-splitting carry+chunk on
      // every call would be quadratic when a huge line arrives in small chunks.
      this.carry += chunk;
      return [];
    }
    const text = this.carry + chunk;
    const lines = text.split('\n');
    this.carry = lines.pop() ?? '';

    const updates: SessionUpdate[] = [];
    for (const raw of lines) {
      if (!raw || raw === '\r') continue;
      try {
        const update = this.parseLine(raw);
        if (update) updates.push(update);
      } catch (err) {
        // A throw is a parser bug (malformed input is handled by the JSON.parse
        // skip path) — keep the watcher alive, but report it once per session.
        this.linesSkippedThrow += 1;
        if (!this.loggedThrow) {
          this.loggedThrow = true;
          console.error(`[rts-agents] parse error in session ${this.label} (line skipped):`, err);
        }
      }
    }
    return updates;
  }

  /** Count a malformed-JSON skip; warn on the first and on sustained 100% skipping. */
  private noteJsonSkip(): void {
    this.linesSkippedJson += 1;
    if (!this.warnedJsonSkip) {
      this.warnedJsonSkip = true;
      console.warn(`[rts-agents] session ${this.label}: skipped a malformed JSONL line`);
    } else if (
      !this.warnedSustainedSkip &&
      this.linesParsed === 0 &&
      this.linesSkippedJson >= SKIP_WARN_THRESHOLD
    ) {
      this.warnedSustainedSkip = true;
      console.warn(
        `[rts-agents] session ${this.label}: ${this.linesSkippedJson} lines skipped, 0 parsed — ` +
          'log format drift or encoding problem?'
      );
    }
  }

  /** Forget all incremental state (file truncated / re-reading from byte 0). */
  reset(): void {
    this.carry = '';
    this.lastStatus = null;
    this.lastTs = null;
    this.pendingTools.clear();
    this.pendingPaths.clear();
  }

  private parseLine(line: string): SessionUpdate | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.noteJsonSkip();
      return null; // malformed line — skip per spec (counted + rate-limited warn)
    }
    this.linesParsed += 1;
    const o = asRecord(parsed);
    if (!o) return null;

    const type = asString(o['type']);
    const ts = this.resolveTs(asString(o['timestamp']));

    if (type === 'ai-title') {
      const title = asString(o['aiTitle'])?.trim();
      return title ? { ts, events: [], aiTitle: collapse(title) } : null;
    }
    // /rename writes both lines with the same value; whichever arrives last wins.
    if (type === 'custom-title' || type === 'agent-name') {
      const name = asString(o[type === 'custom-title' ? 'customTitle' : 'agentName'])?.trim();
      return name ? { ts, events: [], customTitle: collapse(name) } : null;
    }
    if (type === 'last-prompt') {
      const lastPrompt = asString(o['lastPrompt'])?.trim();
      return lastPrompt
        ? { ts, events: [], lastPromptTitle: clamp(collapse(lastPrompt), TITLE_SNIPPET_LEN) }
        : null;
    }
    if (type !== 'assistant' && type !== 'user') return null; // system/mode/summary/… — ignore

    const update: SessionUpdate = { ts, events: [] };
    const cwd = asString(o['cwd']);
    if (cwd) update.cwd = cwd;
    const gitBranch = asString(o['gitBranch']);
    if (gitBranch) update.gitBranch = gitBranch;

    // Sidechain (subagent) traffic: bump eventCount/lastEventAt only — no status.
    if (o['isSidechain'] === true) return update;

    const message = asRecord(o['message']);
    if (type === 'assistant') {
      this.parseAssistant(message, update);
    } else {
      this.parseUser(o, message, update);
    }

    if (update.status !== undefined) this.lastStatus = update.status;
    return update;
  }

  private parseAssistant(message: Record<string, unknown> | null, update: SessionUpdate): void {
    if (!message) return;

    const model = asString(message['model']);
    // Synthetic notice lines carry model "<synthetic>" — keep the last real model id.
    if (model && model !== SYNTHETIC_MODEL) update.model = model;

    const content = message['content'];
    const blocks: unknown[] = Array.isArray(content) ? content : [];

    let lastToolUse: { name: string; input: unknown } | null = null;
    let textSnippet: string | null = null;
    let fullText = '';
    let sawToolUse = false;

    for (const b of blocks) {
      const block = asRecord(b);
      if (!block) continue;
      const blockType = asString(block['type']);
      if (blockType === 'tool_use') {
        const name = asString(block['name']);
        if (!name) continue;
        sawToolUse = true;
        const id = asString(block['id']);
        if (id) {
          this.rememberTool(id, name);
          const p = extractWorkPaths(block['input']);
          if (p.length > 0) this.pendingPaths.set(id, p);
        }
        const detail = extractDetail(block['input']);
        update.events.push({ kind: 'tool_start', tool: name, detail });
        lastToolUse = { name, input: block['input'] };
      } else if (blockType === 'text') {
        const text = asString(block['text']);
        if (text && text.trim()) {
          if (textSnippet === null) textSnippet = truncateDetail(text);
          fullText = fullText ? `${fullText}\n\n${text.trim()}` : text.trim();
        }
      }
    }

    // Claude Code logs each content block on its own line: remember the latest prose so a turn
    // that ends on a text-less line still has a closing summary.
    if (fullText) {
      this.lastText = clamp(fullText, MAX_SUMMARY_LEN);
      update.lastText = this.lastText;
    }

    if (sawToolUse && lastToolUse) {
      update.status = 'running';
      update.tool = lastToolUse.name;
      update.detail = extractDetail(lastToolUse.input);
      const paths = extractWorkPaths(lastToolUse.input);
      if (paths.length > 0) update.workPaths = paths;
      return;
    }

    const stopReason = asString(message['stop_reason']);
    if (stopReason && TERMINAL_STOP_REASONS.has(stopReason)) {
      update.status = 'done';
      update.events.push({
        kind: 'turn_done',
        tool: null,
        detail: textSnippet ?? (this.lastText ? truncateDetail(this.lastText) : null),
      });
      return;
    }

    // thinking/text only, mid-turn
    update.status = 'thinking';
    if (this.lastStatus !== 'thinking') {
      update.events.push({ kind: 'thinking', tool: null, detail: null });
    }
  }

  private parseUser(
    o: Record<string, unknown>,
    message: Record<string, unknown> | null,
    update: SessionUpdate
  ): void {
    if (!message) return;

    const content = message['content'];
    const blocks: unknown[] | null = Array.isArray(content) ? content : null;

    // Tool results?
    const toolResults: Record<string, unknown>[] = [];
    if (blocks) {
      for (const b of blocks) {
        const block = asRecord(b);
        if (block && asString(block['type']) === 'tool_result') toolResults.push(block);
      }
    }

    if (toolResults.length > 0) {
      let anyError = false;
      for (const tr of toolResults) {
        const id = asString(tr['tool_use_id']);
        const tool = id ? (this.pendingTools.get(id) ?? null) : null;
        const paths = id ? this.pendingPaths.get(id) : undefined;
        if (id) {
          this.pendingTools.delete(id);
          this.pendingPaths.delete(id);
        }
        const isError = tr['is_error'] === true;
        if (isError) anyError = true;
        update.events.push({
          kind: isError ? 'tool_error' : 'tool_done',
          tool,
          detail: isError ? resultSnippet(tr['content']) : null,
          ...(isError && paths ? { paths } : {}),
        });
      }
      update.status = anyError ? 'error' : 'thinking';
      return;
    }

    if (o['isMeta'] === true) return; // synthetic line — bump only

    // Real user prompt → model starts composing.
    update.status = 'thinking';

    if (o['isCompactSummary'] === true) return; // continuation blob — not a title
    const text = typeof content === 'string' ? content : firstTextBlock(blocks);
    const trimmed = text?.trim();
    // Skip local-command wrappers (<command-name>…, <local-command-stdout>…).
    if (trimmed && !trimmed.startsWith('<')) {
      update.promptTitle = clamp(collapse(trimmed), TITLE_SNIPPET_LEN);
    }
  }

  private rememberTool(id: string, name: string): void {
    this.pendingTools.set(id, name);
    if (this.pendingPaths.size > MAX_PENDING_TOOLS) {
      const oldestPath = this.pendingPaths.keys().next();
      if (!oldestPath.done) this.pendingPaths.delete(oldestPath.value);
    }
    if (this.pendingTools.size > MAX_PENDING_TOOLS) {
      const oldest = this.pendingTools.keys().next();
      if (!oldest.done) this.pendingTools.delete(oldest.value);
    }
  }

  private resolveTs(iso: string | null): number {
    if (iso) {
      const t = Date.parse(iso);
      if (Number.isFinite(t)) {
        this.lastTs = t;
        return t;
      }
    }
    return this.lastTs ?? Date.now();
  }
}
