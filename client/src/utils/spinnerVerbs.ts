// Claude Code's own spinner verbs ("Sketching…", "Canoodling…") — the words its
// status line shows while a session works. They're never written to the session
// logs, so the village rolls one per working beat to feel like the real terminal.

export const SPINNER_VERBS: readonly string[] = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming', "Beboppin'",
  'Befuddling', 'Billowing', 'Blanching', 'Bloviating', 'Boogieing', 'Boondoggling', 'Booping',
  'Bootstrapping', 'Brewing', 'Bunning', 'Burrowing', 'Calculating', 'Canoodling', 'Caramelizing',
  'Cascading', 'Catapulting', 'Cerebrating', 'Channeling', 'Choreographing', 'Churning', 'Clauding',
  'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting', 'Considering',
  'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Crystallizing', 'Cultivating',
  'Deciphering', 'Deliberating', 'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing',
  'Doodling', 'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing', 'Enchanting',
  'Envisioning', 'Fermenting', 'Fiddle-faddling', 'Finagling', 'Flambéing', 'Flibbertigibbeting',
  'Flowing', 'Flummoxing', 'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting',
  'Gallivanting', 'Galloping', 'Garnishing', 'Generating', 'Gesticulating', 'Germinating',
  'Gitifying', 'Grooving', 'Gusting', 'Harmonizing', 'Hashing', 'Hatching', 'Herding', 'Honking',
  'Hullaballooing', 'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating',
  'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning', 'Kerfuffling', 'Kneading',
  'Leavening', 'Levitating', 'Lollygagging', 'Manifesting', 'Marinating', 'Meandering',
  'Metamorphosing', 'Misting', 'Moonwalking', 'Moseying', 'Mulling', 'Mustering', 'Nebulizing',
  'Nesting', 'Newspapering', 'Noodling', 'Nucleating', 'Onioning', 'Orbiting', 'Orchestrating',
  'Osmosing', 'Perambulating', 'Percolating', 'Perusing', 'Philosophizing', 'Photosynthesizing',
  'Polishing', 'Pollinating', 'Pondering', 'Pontificating', 'Pouncing', 'Precipitating',
  'Prestidigitating', 'Processing', 'Proofing', 'Propagating', 'Puttering', 'Puzzling',
  'Quantumizing', 'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting',
  'Ruminating', 'Sautéing', 'Scampering', 'Schlepping', 'Scurrying', 'Seasoning', 'Shenaniganing',
  'Shimmying', 'Simmering', 'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping',
  'Spelunking', 'Spinning', 'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Swooping',
  'Symbioting', 'Synthesizing', 'Tempering', 'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering',
  'Topsy-turvying', 'Transfiguring', 'Transmogrifying', 'Transmuting', 'Twisting', 'Undulating',
  'Unfurling', 'Unraveling', 'Vibing', 'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting',
  'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling', 'Zesting', 'Zigzagging',
];

/** A verb that changes every `periodMs` per session, like the CLI spinner rotating. */
export function spinnerVerb(sessionSeed: number, now: number = Date.now(), periodMs = 8000): string {
  const beat = Math.floor(now / periodMs);
  const i = (Math.imul(sessionSeed ^ beat, 0x9e3779b1) >>> 0) % SPINNER_VERBS.length;
  return SPINNER_VERBS[i] ?? 'Working';
}
