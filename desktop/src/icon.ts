// Programmatic pixel-art sword icon (no asset files): 16×16 art rendered to a
// BGRA bitmap at 1×/2× for the tray and 4× for the window.

import { nativeImage, type NativeImage } from 'electron';

// '#' blade, '=' guard/pommel, '@' grip, '.' transparent.
const ART = [
  '................',
  '..............##',
  '.............##.',
  '............##..',
  '...........##...',
  '..........##....',
  '.........##.....',
  '..=.....##......',
  '...=...##.......',
  '....=.##........',
  '.....===........',
  '....@@.=........',
  '...@@...=.......',
  '..@@............',
  '.=..............',
  '................',
];

// [b, g, r, a]
const PALETTE: Record<string, [number, number, number, number]> = {
  '#': [0xee, 0xe4, 0xdb, 0xff],
  '=': [0x4a, 0xb2, 0xe0, 0xff],
  '@': [0x2e, 0x4a, 0x7a, 0xff],
};

function bitmap(scale: number): Buffer {
  const size = 16 * scale;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ch = ART[Math.floor(y / scale)]?.[Math.floor(x / scale)] ?? '.';
      const px = PALETTE[ch];
      if (!px) continue;
      buf.set(px, (y * size + x) * 4);
    }
  }
  return buf;
}

export function trayIcon(): NativeImage {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: bitmap(1) });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: bitmap(2) });
  return img;
}

export function windowIcon(): NativeImage {
  return nativeImage.createFromBitmap(bitmap(4), { width: 64, height: 64 });
}
