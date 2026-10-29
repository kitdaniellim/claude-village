// Third-party art credits. Every pack lives under client/public/assets/<pack>/
// with its own LICENSE.txt; this list is what the settings About row and the
// README show (CC-BY / CC-BY-SA require the attribution to be visible).

export interface Credit {
  asset: string;
  author: string;
  license: string;
  url: string;
}

export const CREDITS: Credit[] = [
  {
    asset: 'Hero sprites — "[LPC] Medieval fantasy character sprites"',
    author: 'wulax (Johannes Sjölund), base sprites by Stephen Challener (Redshrike)',
    license: 'CC-BY-SA 3.0 / GPL 3.0 / OGA-BY 3.0',
    url: 'https://opengameart.org/content/lpc-medieval-fantasy-character-sprites',
  },
  {
    asset: 'Terrain, trees, props — "LPC Tile Atlas"',
    author: 'adrix89, from Liberated Pixel Cup art by Lanea Zimmerman, Stephen Challener, Charles Sanchez, Manuel Riecke, Daniel Armstrong, Casper Nilsson, Daniel Eddeland, Johann Charlot, Skyler Robert Colladay',
    license: 'CC-BY-SA 3.0 / GPL 3.0',
    url: 'https://opengameart.org/content/lpc-tile-atlas',
  },
  {
    asset: 'Lair dragon — "Red Dragon"',
    author: 'ZaPaper, credits to Buko Studios, commissioned by PlayCraft',
    license: 'CC-BY 3.0',
    url: 'https://opengameart.org/content/red-dragon-0',
  },
  {
    asset: 'Error monsters: eyeball — "Forest Monsters"',
    author: 'Calciumtrice',
    license: 'CC-BY 3.0',
    url: 'https://opengameart.org/content/forest-monsters',
  },
  {
    asset: 'Error monsters: goblin — "Animated Goblins"',
    author: 'Calciumtrice',
    license: 'CC-BY 3.0',
    url: 'https://opengameart.org/content/animated-goblins',
  },
  {
    asset: 'Error monsters: ogre (spear orc) — "Animated Orcs"',
    author: 'Calciumtrice',
    license: 'CC-BY 3.0',
    url: 'https://opengameart.org/content/animated-orcs',
  },
  {
    asset: 'Error monsters: goblin + ogre — "Pixel Art Animated Goblin / Ogre" (user-supplied preview images)',
    author: 'original author unknown',
    license: 'unknown — personal use only; verify licence before distributing',
    url: 'assets/monsters/user-preview/LICENSE.txt', // no public source: link the local licence note
  },
  {
    asset: 'Hero swords — "sword-ocal_20230219" (openclipart.org)',
    author: 'openclipart.org contributors',
    license: 'Public domain (CC0 1.0)',
    url: 'https://openclipart.org/detail/22181',
  },
  {
    asset: 'Simone dragon at play — "Flying Dragon Rework"',
    author: 'ZaPaper & Jordan Irwin (AntumDeluge), credits to Buko Studios, commissioned by PlayCraft',
    license: 'CC-BY 3.0',
    url: 'https://opengameart.org/node/83655',
  },
  {
    asset: 'Petting hearts — "LemCraft"',
    author: 'Matt Hackett of Lost Decade Games',
    license: 'CC0 1.0',
    url: 'https://opengameart.org/content/lemcraft',
  },
  {
    asset: 'Crafting item icons — "RPG crafting material icons"',
    author: 'BizmasterStudios',
    license: 'CC-BY 4.0',
    url: 'https://opengameart.org/content/rpg-crafting-material-icons',
  },
  {
    asset: 'Hero portraits — "32x32 Fantasy portrait set"',
    author: 'CobraLad',
    license: 'CC-BY 3.0',
    url: 'https://opengameart.org/content/32x32-fantasy-portrait-set',
  },
  {
    asset: 'Backpack bag icon — "Various inventory 24 pixel icon set"',
    author: 'OceansDream',
    license: 'CC-BY 3.0',
    url: 'https://opengameart.org/content/various-inventory-24-pixel-icon-set',
  },
];

/** One-line attribution, e.g. for a status row. */
export function creditLine(c: Credit): string {
  return `${c.asset} by ${c.author} — ${c.license}`;
}
