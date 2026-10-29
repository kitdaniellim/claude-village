// Postinstall: (1) download the Electron binary — electron >= 44 no longer does
// this itself, it exposes `install-electron` instead (no-op once present);
// (2) node-pty >= 1.1 is N-API and ships prebuilds that load under Electron
// as-is, so only fall back to electron-rebuild when no prebuild exists.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Runs a Node script with the current node binary (no shell → spaces in paths are safe).
function runNode(label, script, args = []) {
  console.log(`[desktop] ${label}`);
  const res = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', cwd: ROOT });
  if (res.status !== 0) {
    console.error(`[desktop] ${label} failed (exit ${res.status ?? res.signal})`);
    process.exit(res.status ?? 1);
  }
}

// 1. Electron binary
runNode('electron: ensuring binary is downloaded', path.join(ROOT, 'node_modules', 'electron', 'install.js'));

// 2. node-pty
const prebuild = path.join(ROOT, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node');
if (fs.existsSync(prebuild) && process.env.npm_config_build_from_source !== 'true') {
  console.log(`[desktop] node-pty: N-API prebuild found (${path.relative(ROOT, prebuild)}) — no Electron rebuild needed`);
} else {
  runNode(
    'node-pty: no prebuild for this platform — running electron-rebuild',
    path.join(ROOT, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'),
    ['-f', '-w', 'node-pty']
  );
}
