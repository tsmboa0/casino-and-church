export const TILE = 16;
export const MAP_W = 87;
export const MAP_H = 31;
export const WORLD_W = MAP_W * TILE;   // 1392
export const WORLD_H = MAP_H * TILE;   // 496

/**  cols 0..38 CASINO | wall 39 | cols 40..45 CROSSROADS plaza (6 wide) | wall 46 | cols 47..86 CHURCH  */
export const CASINO_WALL_X = 39 * TILE;     // 624  (wall column spans 624..640)
export const CHURCH_WALL_X = 46 * TILE;     // 736 (wall column spans 736..752)
export const DOOR_Y0 = 9 * TILE;            // realm doorways span rows 9..11
export const DOOR_Y1 = 12 * TILE;

export const FLOOR_TOP = 2 * TILE;          // below the north wall faces
export const FLOOR_BOTTOM = 29 * TILE;      // south cap line

/** characters (player + NPCs) are drawn this much larger than the 16x32 art */
export const CHAR_SCALE = 1.25;

export type Realm = 'casino' | 'church';
export type Zone = Realm | 'plaza';
export type Facing = 'down' | 'left' | 'right' | 'up';

export const ATLAS_BASE = 'assets/vendor-built/';

// Brand palette (see PLAN.md §6.2)
export const COLORS = {
  ink: 0x14101c,
  gold: 0xf5c542,
  cream: 0xf4ead5,
  neonPink: 0xff2e88,
  neonRed: 0xe8394a,
  amber: 0xffb347,
  glassBlue: 0x3a7bd5,
  glassTeal: 0x2fb8a8,
  holy: 0xfff8e6,
};

/** Characters a new player may choose (pit_boss and monk are reserved for the two NPCs) */
export const AVATARS: { id: string; name: string; blurb: string }[] = [
  { id: 'c_tourist',        name: 'The Tourist',      blurb: 'Here for the lights.' },
  { id: 'c_valet',          name: 'The Valet',        blurb: 'Parks luck. Fast.' },
  { id: 'c_cashier',        name: 'The Cashier',      blurb: 'Counts everything.' },
  { id: 'c_high_roller',    name: 'The High Roller',  blurb: 'Never blinks.' },
  { id: 'c_bartender',      name: 'The Bartender',    blurb: 'Hears every prayer.' },
  { id: 'c_lounge_singer',  name: 'The Songbird',     blurb: 'Sings for tips.' },
  { id: 'c_cocktail_waitress', name: 'The Server',    blurb: 'Always on her feet.' },
  { id: 'c_card_shark',     name: 'The Card Shark',   blurb: 'Counts the deck.' },
  { id: 'm_bard',           name: 'The Bard',         blurb: 'Tells tall tales.' },
  { id: 'm_archer',         name: 'The Archer',       blurb: 'Aims for the jackpot.' },
  { id: 'm_lady',           name: 'The Lady',         blurb: 'Faith in good company.' },
  { id: 'm_jester',         name: 'The Jester',       blurb: 'Laughs at the odds.' },
];
export const AVATAR_IDS = AVATARS.map(a => a.id);
