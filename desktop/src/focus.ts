// "Go to terminal": bring the window hosting a running claude pid to the front
// (Windows only). A PowerShell script walks the pid's parent chain to the first
// process with a visible top-level window, picks the Windows Terminal tab named
// after the session via UI Automation, then restores + foregrounds the window.
// Inputs travel as environment variables, never spliced into the script text.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FocusSessionRequest, FocusSessionResult, TranscriptLookup } from '../../client/src/types/desktop';

const FOCUS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = [ordered]@{ ok = $false; method = 'not-found'; detail = ''; app = $null; window = $null; tab = $null; foreground = $false; chain = @() }
function Finish { $out | ConvertTo-Json -Compress -Depth 4; exit 0 }
try {
  $target = [int]$env:RTS_FOCUS_PID
  $titles = @(([string]$env:RTS_FOCUS_TITLES) -split "\n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $dry = $env:RTS_FOCUS_DRY -eq '1'
  $noFg = $env:RTS_FOCUS_NOFG -eq '1'

  Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class RtsFocus {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public static List<IntPtr> Windows(uint pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && Title(h).Length > 0) r.Add(h);
      return true;
    }, IntPtr.Zero);
    return r;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static bool Focus(IntPtr h) {
    ShowWindow(h, IsIconic(h) ? 9 : 5); // SW_RESTORE when minimised, else SW_SHOW (keeps maximised)
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return true;
    uint dummy; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out dummy); uint me = GetCurrentThreadId();
    if (fg != 0 && fg != me) {
      AttachThreadInput(me, fg, true);
      BringWindowToTop(h); SetForegroundWindow(h);
      AttachThreadInput(me, fg, false);
    }
    return GetForegroundWindow() == h;
  }
}
'@

  $procs = @{}
  foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate) { $procs[[int]$p.ProcessId] = $p }
  if (-not $procs.ContainsKey($target)) { $out.method = 'pid-gone'; $out.detail = "Process $target is no longer running."; Finish }

  $stop = @('explorer.exe', 'svchost.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'userinit.exe', 'sihost.exe', 'System', 'Idle')
  $hostPid = $null; $hostName = $null; $wins = $null
  $id = $target; $seen = @{}; $child = $null
  while ($procs.ContainsKey($id) -and -not $seen.ContainsKey($id)) {
    $seen[$id] = 1
    $p = $procs[$id]
    # A parent pid can be reused by a newer, unrelated process once the real parent exits.
    if ($child -and $p.CreationDate -and $child.CreationDate -and $p.CreationDate -gt $child.CreationDate) { break }
    $name = [string]$p.Name
    if ($stop -contains $name) { break }
    $out.chain += "$name#$id"
    $w = [RtsFocus]::Windows([uint32]$id)
    if ($w.Count -gt 0) { $hostPid = $id; $hostName = $name; $wins = $w; break }
    $child = $p
    $id = [int]$p.ParentProcessId
  }

  # Default-terminal handoff: WT hosts the console but is not an ancestor — look for the tab there.
  if (-not $wins -and $titles.Count -gt 0) {
    foreach ($wt in @($procs.Values | Where-Object { $_.Name -eq 'WindowsTerminal.exe' })) {
      $w = [RtsFocus]::Windows([uint32]$wt.ProcessId)
      if ($w.Count -gt 0) { $hostPid = [int]$wt.ProcessId; $hostName = 'WindowsTerminal.exe'; $wins = $w; break }
    }
  }
  if (-not $wins) { $out.detail = 'No visible window found for this session (it may run headless or in a service).'; Finish }

  $friendly = @{ 'WindowsTerminal.exe' = 'Windows Terminal'; 'Code.exe' = 'VS Code'; 'electron.exe' = 'RTS Agents'; 'Cursor.exe' = 'Cursor'; 'conhost.exe' = 'console window'; 'OpenConsole.exe' = 'console window'; 'cmd.exe' = 'console window'; 'powershell.exe' = 'console window'; 'pwsh.exe' = 'console window'; 'WezTerm.exe' = 'WezTerm'; 'wezterm-gui.exe' = 'WezTerm'; 'alacritty.exe' = 'Alacritty'; 'mintty.exe' = 'mintty' }
  $out.app = if ($friendly.ContainsKey($hostName)) { $friendly[$hostName] } else { $hostName }

  $hwnd = $wins[0]
  $tabEl = $null
  if ($hostName -eq 'WindowsTerminal.exe' -and $titles.Count -gt 0) {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
    $all = @()
    foreach ($h in $wins) {
      try {
        foreach ($t in [Windows.Automation.AutomationElement]::FromHandle($h).FindAll([Windows.Automation.TreeScope]::Descendants, $cond)) {
          # WT prefixes the title with Claude's spinner glyph ("✳ FAT-340") — compare without it.
          $all += [pscustomobject]@{ hwnd = $h; el = $t; name = $t.Current.Name; bare = ($t.Current.Name -replace '^[^\p{L}\p{N}]+', '').Trim() }
        }
      } catch {}
    }
    $match = @()
    foreach ($title in $titles) {
      $match = @($all | Where-Object { $_.bare -ieq $title })
      if ($match.Count -eq 0) { $match = @($all | Where-Object { $_.name.IndexOf($title, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
      if ($match.Count -gt 0) { break }
    }
    if ($match.Count -gt 0) {
      $tabEl = $match[0].el; $hwnd = $match[0].hwnd; $out.tab = $match[0].name
      if ($match.Count -gt 1) { $out.detail = "$($match.Count) tabs share that name; picked the first." }
    } elseif ($all.Count -gt 0) {
      $out.detail = "No tab named like '" + ($titles -join "' / '") + "' among $($all.Count) tabs."
    }
  } elseif ($wins.Count -gt 1 -and $titles.Count -gt 0) {
    foreach ($h in $wins) {
      $wt = [RtsFocus]::Title($h)
      if (@($titles | Where-Object { $wt.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0) { $hwnd = $h; break }
    }
  }
  $out.window = [RtsFocus]::Title($hwnd)

  if ($dry) {
    $out.ok = $true
    $out.method = if ($tabEl) { 'wt-tab' } else { 'window' }
    $out.detail = ('dry run; ' + $out.detail).Trim()
    Finish
  }
  if ($tabEl) {
    try { $tabEl.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { $tabEl = $null; $out.detail = "Tab select failed: $($_.Exception.Message)" }
  }
  if (-not $noFg) { $out.foreground = [RtsFocus]::Focus($hwnd) }
  $out.ok = $true
  $out.method = if ($tabEl) { 'wt-tab' } else { 'window' }
  if (-not $out.foreground -and -not $noFg) { $out.detail = ('Windows kept focus elsewhere; the window was restored behind it. ' + $out.detail).Trim() }
  Finish
} catch {
  $out.method = 'error'; $out.detail = $_.Exception.Message; Finish
}
`;

/** Strip control characters / newlines (the titles list is newline-separated) and cap the length. */
function cleanTitle(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120);
  return s.length > 0 ? s : null;
}

function fail(method: FocusSessionResult['method'], detail: string): FocusSessionResult {
  return { ok: false, method, detail, app: null, window: null, tab: null, foreground: false, chain: [] };
}

let encoded: string | null = null;

/** Finds and fronts the terminal hosting `pid`; resolves (never rejects) with what happened. */
export function focusSession(raw: unknown): Promise<FocusSessionResult> {
  const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<FocusSessionRequest>;
  const pid = Number(req.pid);
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(fail('error', 'focusSession: pid must be a positive integer'));
  if (process.platform !== 'win32') return Promise.resolve(fail('unsupported', 'Go to terminal is Windows-only for now.'));
  const titles = (Array.isArray(req.titles) ? req.titles : []).map(cleanTitle).filter((t): t is string => t !== null).slice(0, 4);

  encoded ??= Buffer.from(FOCUS_SCRIPT, 'utf16le').toString('base64');
  const env = {
    ...process.env,
    RTS_FOCUS_PID: String(pid),
    RTS_FOCUS_TITLES: titles.join('\n'),
    RTS_FOCUS_DRY: req.dryRun === true ? '1' : '0',
    RTS_FOCUS_NOFG: req.skipForeground === true ? '1' : '0',
  };
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded as string],
      { env, windowsHide: true, timeout: 20_000, encoding: 'utf8', maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const line = stdout
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.trim().startsWith('{'));
        if (line) {
          try {
            const r = JSON.parse(line) as FocusSessionResult;
            resolve({ ...r, chain: Array.isArray(r.chain) ? r.chain : r.chain ? [String(r.chain)] : [] });
            return;
          } catch {
            // fall through to the error below
          }
        }
        resolve(fail('error', (err?.message ?? stderr.trim()) || 'PowerShell returned no result'));
      }
    );
  });
}

/** Where `claude` keeps transcripts for the sessions this app spawns. */
function configDir(): string {
  const env = process.env['CLAUDE_CONFIG_DIR'];
  return env && env.trim() ? env : path.join(os.homedir(), '.claude');
}

/** Is `<config>/projects/<slug>/<sessionId>.jsonl` on disk, and under which project slug? */
export function findTranscript(sessionId: unknown): TranscriptLookup {
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) return { found: false, projectDir: null };
  const projects = path.join(configDir(), 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return { found: false, projectDir: null };
  }
  for (const d of dirs) {
    if (fs.existsSync(path.join(projects, d, `${sessionId}.jsonl`))) return { found: true, projectDir: d };
  }
  return { found: false, projectDir: null };
}
