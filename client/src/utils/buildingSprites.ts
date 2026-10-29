// Pixel-matrix sprite definitions for the 8 classic village buildings.
// The world renderer (world/places.ts) draws only `tavern` from here (at
// scale 3, the centre of the map); the tool buildings now live on as action
// *categories* (world/actors.ts) rather than separate buildings.
//
// Each sprite is a character matrix rendered at SPRITE_SCALE (2px per char).
// Conventions: '.' = transparent. Roofs use R (dark/eave), r (mid), q (shingle
// highlight). Walls use w (plaster), t (timber), S/s (stone). Windows use
// G (frame) + g (glass; recoloured warm in the lit variant). Doors use D/d.
// All rows in a sprite must be exactly the same length (see the width checks
// in scripts run at review time — renderMatrix tolerates ragged rows but the
// art would visibly misalign).

import type { BuildingId } from '../types/agent';

export interface SpriteDef {
  rows: string[];
  palette: Record<string, string>;
  /** chars recoloured in the "lit windows" variant */
  lit: Record<string, string>;
  /** chars that emit a soft halo at night */
  glowChars: string;
  doorDx: number;
  doorDy: number;
}

export const SPRITE_SCALE = 2;

export const BUILDING_DEFS: Record<BuildingId, SpriteDef> = {
  // Big blue shingled roof, cream walls, twin windows, hanging book sign.
  library: {
    rows: [
      '.........RRRRRRRRRRRR.........',
      '........qqqqqqqqqqqqqq........',
      '.......rrrrrrrrrrrrrrrr.......',
      '......rrrqrrrqrrrqrrrqrr......',
      '.....rrrrrrrrrrrrrrrrrrrr.....',
      '....rqrrrqrrrqrrrqrrrqrrrq....',
      '...rrrrrrrrrrrrrrrrrrrrrrrr...',
      '..RRRRRRRRRRRRRRRRRRRRRRRRRR..',
      '..twwwwwwwwwwwwwwwwwwwwwwwwt..',
      '..twwwGGGGwwwwwwwwwwGGGGwwwt..',
      '..twwwGggGwwwwwwwwwwGggGwwwt..',
      '..twwwGggGwwwwwwwwwwGggGwwwt..',
      '..twwwGGGGwwwwwwwwwwGGGGwwwt..',
      '..twwwwwwwwwwwwwwwwwwwwwwwwt..',
      '..twwwwwwwwwwDDDDwwwwwwwwwwt..',
      '..twwbBBbwwwwDddDwwwwwwwwwwt..',
      '..twwbBBbwwwwDddDwwwwwwwwwwt..',
      '..twwwwwwwwwwDddDwwwwwwwwwwt..',
      '..twwwwwwwwwwDddDwwwwwwwwwwt..',
      '..SSsSSSsSSSSDddDSSSsSSSsSSS..',
      '..SSSsSSsSSSSDddDSsSSSsSSSsS..',
    ],
    palette: {
      q: '#6f9fd6', r: '#4878b4', R: '#33598c',
      w: '#e7d4a4', t: '#8a6a42', G: '#6b5634', g: '#3d4f66',
      b: '#6e4a2a', B: '#f1ead6', D: '#54371f', d: '#7d5230',
      S: '#9aa1ad', s: '#7d828c',
    },
    lit: { g: '#ffd97a' },
    glowChars: 'g',
    doorDx: 29,
    doorDy: 39,
  },

  // Stone smithy: dark slate roof, ember chimney, open front with furnace
  // glow and an anvil inside.
  forge: {
    rows: [
      '......................oyo.....',
      '.....................ssss.....',
      '.....................ssss.....',
      '.....................ssss.....',
      '..RRRRRRRRRRRRRRRRRRRssssRR...',
      '.rrrrrrrrrrrrrrrrrrrrssssrrr..',
      '.rqrrrqrrrqrrrqrrrqrrrqrrrrr..',
      'RRRRRRRRRRRRRRRRRRRRRRRRRRRRRR',
      '.SSSSSSSSSSSSSSSSSSSSSSSSSSSS.',
      '.SsSSSsSSSSSsSSSSsSSSSSsSSSsS.',
      '.SSKKKKKKKKKKSSSSSSSGggGSSSSS.',
      '.SSKKKKKKKKKKSSSSSSSGggGSSSSS.',
      '.SSKKoooKKKKKSSSSSSSGggGSSSSS.',
      '.SSKoyyyoKKKKSSSSSSSSSSSSSSSS.',
      '.SSKoyyoKAAAKSSSSSSSSSSSSSSSS.',
      '.SSKKyyKAAAAKSSSSSSSSSSSSSSSS.',
      '.SSKKKKKKKKKKSSSSSSSSSSSSSSSS.',
      '.ssSSsSSSsSSSSsSSSsSSSSsSSSss.',
    ],
    palette: {
      s: '#5d6068', S: '#7d8089', R: '#3f4046', r: '#54555c', q: '#6a6d75',
      K: '#241c16', A: '#8b95a3', o: '#ff8c3b', y: '#ffd166',
      G: '#3a3f47', g: '#4a3520',
    },
    lit: { g: '#ffae45', K: '#3a2516' },
    glowChars: 'goy',
    doorDx: 15,
    doorDy: 33,
  },

  // Open sand ring with a stone wall, red banners on posts, south entrance.
  arena: {
    rows: [
      '...P............................P...',
      '...PFFF......................FFFP...',
      '...PFF........................FFP...',
      '...P............................P...',
      '..........SSSSSSSSSSSSSSSS..........',
      '.......SSSddddddddddddddddSSS.......',
      '.....SSddddddddddddddddddddddSS.....',
      '....SSddddddddddddddddddddddddSS....',
      '...SSdddedddddddddddddddddedddddSS..',
      '...SSdddddddedddddddddeddddddddSS...',
      '...SSddeddddddddddedddddddddeddSS...',
      '....SSddddddddddddddddddddddddSS....',
      '.....SSddddddddddddddddddddddSS.....',
      '.......SSSddddddddddddddddSSS.......',
      '..........SSSSSSddddSSSSSS..........',
      '..........ssssssddddssssss..........',
    ],
    palette: {
      P: '#6b4226', F: '#d4493f', S: '#9aa1ad', s: '#565a63',
      d: '#e0c27e', e: '#cfae66',
    },
    lit: {},
    glowChars: '',
    doorDx: 36,
    doorDy: 30,
  },

  // Grey keep with crenellated towers, banner, arched timber gate.
  castle: {
    rows: [
      '...............P................',
      '...............PFFFF............',
      '...............PFF..............',
      '...............P................',
      'SS.SS.SS................SS.SS.SS',
      'SSSSSSSS................SSSSSSSS',
      'SsssssSS................SSsssssS',
      'SSSggSSS................SSSggSSS',
      'SSSSSSSS.SS.SS.SS.SS.SS.SSSSSSSS',
      'SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS',
      'SsSSSsSSSSsSSSSSsSSSSsSSSSSsSSsS',
      'SSSgSSSSSSSSgSSSSSSSSgSSSSSSgSSS',
      'SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS',
      'SSsSSSSsSSSSSSsSSSSSSSsSSSSSsSSS',
      'SSSSSSSSSSSSKKKKKKKKSSSSSSSSSSSS',
      'SSSSSSSSSSSKKKKKKKKKKSSSSSSSSSSS',
      'SsSSSsSSSSSKDddddddDKSSSSsSSSsSS',
      'SSSSSSSSSSSKDddddddDKSSSSSSSSSSS',
      'SSSgSSSSSSSKDdDddDdDKSSSSSSgSSSS',
      'SSSSSSSSSSSKDddddddDKSSSSSSSSSSS',
      'SsSSSSsSSSSKDdDddDdDKSSSsSSSSsSS',
      'SSSSSSSSSSSKDddddddDKSSSSSSSSSSS',
      'sSSSsSSSSSSKDddddddDKSSSSSsSSSss',
      'sssssssssssKDddddddDKsssssssssss',
    ],
    palette: {
      P: '#6b4226', F: '#d4493f', S: '#9aa1ad', s: '#777d88',
      g: '#2f3540', K: '#1d1812', D: '#4a3322', d: '#6e4f2e',
    },
    lit: { g: '#ffd97a' },
    glowChars: 'g',
    doorDx: 32,
    doorDy: 45,
  },

  // Tall narrow stone tower with a burning beacon on top.
  watchtower: {
    rows: [
      '......oo.......',
      '.....oyyo......',
      '....WWyyWW.....',
      '....WWWWWW.....',
      '...SSSSSSSSS...',
      '..SS.SS.SS.SS..',
      '..SSSSSSSSSSS..',
      '..SSgSSSSSgSS..',
      '..SSSSSSSSSSS..',
      '...SSSSSSSSS...',
      '...SsSSSsSSS...',
      '...SSSgSSSSS...',
      '...SSSSSSSSS...',
      '...SSsSSSsSS...',
      '...SSSSSSSSS...',
      '...SSSSSgSSS...',
      '...SsSSSSSsS...',
      '...SSSSSSSSS...',
      '...SSSgSSSSS...',
      '...SSSSSSSSS...',
      '...SsSSSsSSS...',
      '...SSSSSSSSS...',
      '...SSSSSSSSS...',
      '..SSSSSSSSSSS..',
      '..SsSSSsSSsSS..',
      '..SSSDddDSSSS..',
      '..SSSDddDSSSS..',
    ],
    palette: {
      o: '#ff8c3b', y: '#ffd166', W: '#7a5230',
      S: '#9aa1ad', s: '#777d88', g: '#574a2e',
      D: '#3f2c19', d: '#6e4f2e',
    },
    lit: { g: '#ffd97a' },
    glowChars: 'goy',
    doorDx: 14,
    doorDy: 51,
  },

  // Half-timbered inn: warm windows, brick chimney, hanging mug sign.
  tavern: {
    rows: [
      '.....CCC........................',
      '.....CCC..RRRRRRRRRRRR..........',
      '.....CCCqrrrrrrrrrrrrrrq........',
      '......qrrrqrrrqrrrqrrrqrrq......',
      '....qrrrrrrrrrrrrrrrrrrrrrrq....',
      '..qrrrqrrrqrrrqrrrqrrrqrrrqrrr..',
      'RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR',
      '..tttttttttttttttttttttttttttt..',
      '..twGggGwwwtwwGggGwwtwwGggGwwt..',
      '..twGggGwwwtwwGggGwwtwwGggGwwt..',
      '..twwwwwwwwtwwwwwwwwtwwwwwwwwt..',
      '..tttttttttttttttttttttttttttt..',
      '..twbbbbwwwtwwDDDDwwtwwwwwwwwt..',
      '..twbMMbwwwtwwDddDwwtwwwwwwwwt..',
      '..twbbbbwwwtwwDddDwwtwwwwwwwwt..',
      '..twwwwwwwwtwwDddDwwtwwwwwwwwt..',
      '..SsSSSsSSSSSsDddDSsSSSsSSSsSS..',
      '..SSsSSSsSSSSsDddDSSsSSsSSSsSS..',
    ],
    palette: {
      C: '#9b5e4a', R: '#7e2f28', r: '#b5483c', q: '#d4685c',
      t: '#6e4a2a', w: '#e6d2a8', G: '#6b5634', g: '#caa55e',
      b: '#5d4524', M: '#e8b04f', D: '#4a2f1b', d: '#74552e',
      S: '#9aa1ad', s: '#777d88',
    },
    lit: { g: '#ffd97a' },
    glowChars: 'g',
    doorDx: 31,
    doorDy: 33,
  },

  // White chapel: gold cross, slate-blue shingled roof, arched window.
  chapel: {
    rows: [
      '...........CC...........',
      '..........CCCC..........',
      '...........CC...........',
      '..........RRRR..........',
      '.........RRRRRR.........',
      '........RRrrrrRR........',
      '.......RRrrrrrrRR.......',
      '.........WggggW.........',
      '.........WggggW.........',
      '.........WWWWWW.........',
      '....RRRRRRRRRRRRRRRR....',
      '...RRrrrrrrrrrrrrrrRR...',
      '..RRrrrqrrrqrrrqrrrqRR..',
      '.RRrrrrrrrrrrrrrrrrrrRR.',
      'RRRRRRRRRRRRRRRRRRRRRRRR',
      '..wwwwwwwwwwwwwwwwwwww..',
      '..wwGgGwwwwwwwwwwGgGww..',
      '..wwGgGwwwGggGwwwGgGww..',
      '..wwGgGwwwGggGwwwGgGww..',
      '..wwwwwwwwGggGwwwwwwww..',
      '..wwwwwwwwDDDDwwwwwwww..',
      '..wwwwwwwwDddDwwwwwwww..',
      '..wwwwwwwwDddDwwwwwwww..',
      '..SsSSsSSSDddDSSsSSsSS..',
      '.SSsSSSsSSDddDSsSSSsSSs.',
    ],
    palette: {
      C: '#e9c46a', R: '#5c6e8e', r: '#7286a8', q: '#8ea2c2',
      W: '#8a8070', w: '#ece4d4', G: '#8a8070', g: '#41546e',
      D: '#4a3a28', d: '#6e5a40', S: '#9aa1ad', s: '#7d828c',
    },
    lit: { g: '#ffd97a' },
    glowChars: 'g',
    doorDx: 23,
    doorDy: 47,
  },

  // Striped purple tent with gold stars and a bubbling cauldron out front.
  alchemist: {
    rows: [
      '.............uu.............',
      '............uTTu............',
      '...........uTTTTu...........',
      '..........uTttttTu..........',
      '.........uTttxtttTu.........',
      '........uTttttttttTu........',
      '.......uTtttttxttttTu.......',
      '......uTttxtttttttttTu......',
      '.....uTtttttttxttttttTu.....',
      '....uTttttttttttttttttTu....',
      '...uTttttttttttttttttttTu...',
      '..uTttttttttttttttttttttTu..',
      '.uTtttttttttKKKKtttttttttTu.',
      '.uTttttttttKKKKKKttttttttTu.',
      '.uTttttttttKKKKKKttttttttTu.',
      '.uTttttttttKKKKKKttttttttTu.',
      'uTTTTTTTTTTTKKKKKKTTTTTTTTTu',
      '....l.l.....KKKKKK..........',
      '...clllllc..KKKKKK..........',
      '...ccccccc..KKKKKK..........',
      '....ccccc...................',
      '.....WWW....................',
    ],
    palette: {
      u: '#9b6fc4', T: '#5d3a7d', t: '#7a4f9e', x: '#e8d76a',
      K: '#221a2e', c: '#3a3f47', l: '#74d77b', W: '#7a5230',
    },
    lit: { l: '#a5f7a0', K: '#2e2440' },
    glowChars: 'lx',
    doorDx: 28,
    doorDy: 38,
  },
};
