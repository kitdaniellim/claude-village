# Art assets — RTS Agents

This folder is the **only** place third-party art lives. One subfolder per pack, each with
its own `LICENSE.txt` (asset name, author, source URL, license, fetch date, and the pack's
own README/attribution text verbatim). Code credits live in `client/src/utils/credits.ts`
(rendered in ⚙ Settings → About) and in the root `README.md` Credits table — add a row in
all three when you add a pack.

Rules: images only (never run anything from here); keep files unmodified (re-tint in code);
CC-BY / CC-BY-SA packs need *visible* attribution, CC-BY-SA also share-alike — this repo is
a private tool, fine, but don't relicense; prefer CC0 / CC-BY / OGA-BY when choosing new art.

| Folder | Pack | Used for |
| --- | --- | --- |
| `characters/lpc/` | [LPC] Medieval fantasy character sprites — wulax (CC-BY-SA 3.0 / GPL 3.0 / OGA-BY 3.0) | hero bodies: walk / slash / thrust / spellcast / shoot / hurt (`world/lpcHero.ts`) |
| `tiles/lpc/` | LPC Tile Atlas — adrix89 et al. (CC-BY-SA 3.0 / GPL 3.0) | grass, dirt roads (autotiled), water, trees, bushes, rocks, fences, crops (`world/tileset.ts`) |
| `dragon/` | Red Dragon — ZaPaper (CC-BY 3.0) | the Simone lair dragon (`world/dragonSprite.ts`) |
| `icons/crafting/` | RPG crafting material icons — BizmasterStudios (CC-BY 4.0) | reward items in the backpack / journal / toasts (`utils/itemIcons.ts`) |
| `portraits/fantasy-32/` | 32x32 Fantasy portrait set — CobraLad (CC-BY 3.0) | hero faces on party cards, terminal tabs / session header, journal rows and award toasts, matched to the LPC look (`utils/portraits.ts`, `components/Portrait.tsx`) |
| `monsters/calciumtrice/` | Forest Monsters (eyeball) + Animated Goblins + Animated Orcs — Calciumtrice (CC-BY 3.0) | error monsters beside a hero whose tool failed: eyeball (1st error), knife goblin (2nd), spear orc as the ogre (3rd+) — idle / taunt / walk / death rows (`world/monsterSprite.ts`, `world/monsters.ts`) |
| `monsters/user-preview/` | Pixel Art Animated Ogre + Goblin — user-supplied marketplace preview images (Downloads, 2026-10-15), original author/licence unknown, personal use only — verify licence before distributing | preferred goblin (streak 2) + ogre (streak 3+) art: idle / walk / attack rows extracted from the previews (no death row: programmatic fall); Calciumtrice goblin/orc are the load-failure fallback (`world/monsterSprite.ts`) |
| `weapons/ocal-swords/` | sword-ocal_20230219 — openclipart.org swords (public domain / CC0), per-sword URLs in its LICENSE.txt | hero swords: one per hero from its hash (squires: tanto / gladius), gripped at the LPC hand and rotated per frame (`world/weaponSprite.ts`, `world/lpcHero.ts` hand table) |
| `dragon/flying-rework/` | Flying Dragon Rework 1.1 — ZaPaper & Jordan Irwin (AntumDeluge), credits to Buko Studios, commissioned by PlayCraft (CC-BY 3.0; README / CHANGES / LICENSE copied verbatim) | the Simone dragon at play: flight loops, chase, landing and lying down to be petted — rows N/E/S/W x 3 flap frames, 144x128 red sheet (`world/dragonPlay.ts`); gold / twin-headed / 191x161 variants kept for later |
| `icons/lemcraft/` | LemCraft heart — Matt Hackett of Lost Decade Games (CC0 1.0) | hearts floating over a hero petting the dragon (`world/dragonPlay.ts`) |
| `icons/inventory-24/` | Various inventory 24 pixel icon set — OceansDream (CC-BY 3.0 / CC-BY-SA 3.0) | the leather bag cell (0, 4) as the top-bar backpack button and the Backpack panel header / tab; flap-open animation is CSS on the same cell (`components/PixelIcon.tsx` BagIcon, `components/TopBar.css`) |

## Reference list (the user's "our art" picks — 2026-10-14)

Saved so future work pulls from the same visual family:

- Free pixel-art asset roundup (r/godot): https://www.reddit.com/r/godot/comments/msg1yn/lots_of_free_pixel_art_assets_for_your_projects/
- LPC Tile Atlas: https://opengameart.org/content/lpc-tile-atlas
- LPC Medieval Fantasy Character Sprites: https://opengameart.org/content/lpc-medieval-fantasy-character-sprites
- RPG crafting material icons: https://opengameart.org/content/rpg-crafting-material-icons
- 32x32 fantasy portrait set: https://opengameart.org/content/32x32-fantasy-portrait-set
- Red Dragon (chosen for the lair): https://opengameart.org/content/red-dragon-0

Style rules that follow from these: Liberated Pixel Cup proportions (32 px tiles drawn at
0.5× into the 16 px world, 64 px character frames at 0.5×), nearest-neighbour scaling only
at draw time, warm muted palette, crisp 1-px outlines. Buildings, cities and UI chrome are
still programmatic — match the LPC palette when extending them.
