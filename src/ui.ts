// Design-system tokens and stroke icons for the HTML UI (the board itself is drawn in scene3d.ts).
import { ROBOTS, TOWERS, type Armor, type DamageType, type RobotKind, type TowerKind } from './sim/config.ts'

// Design-system tokens
export const C = {
  void: 0x0b0d10, hull: 0x14171c, plate: 0x1c2027, seam: 0x2a3038, seam2: 0x3a424d, groove: 0x20252c,
  dust: 0x9ba3ae, white: 0xeceef1, hazard: 0xffc42e, hazardDeep: 0xd99a00, rogue: 0xff5468, online: 0x8ce66b,
  gold: 0xf2d58a, offline: 0x4a525e, board: 0x12151a, drop: 0x10161a, core: 0x1a1014,
}
export const DMG_COLOR: Record<DamageType, number> = { kinetic: 0xd9dee5, explosive: 0xff6b2c, energy: 0x3be3cf }
export const ARMOR_COLOR: Record<Armor, number> = { light: 0xd9dee5, heavy: 0xff6b2c, shielded: 0x3be3cf }

// 24px stroke icons from the design system: towers have a round core, robots wear their armor silhouette.
export const TOWER_ICON: Record<TowerKind, string> = {
  gatling: 'M7 14a5 5 0 1 0 10 0a5 5 0 1 0 -10 0M10 9V3M14 9V3',
  flak: 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3 3M19 5l-3 3',
  emp: 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M4.5 7.5a9 9 0 0 1 15 0M4.5 16.5a9 9 0 0 0 15 0',
  mortar: 'M6 19a6 6 0 0 1 12 0zM12 13l5-8M15 3l4 2.5',
  tesla: 'M8 21a4 4 0 0 1 8 0zM12 17v-5M14 2l-4 6h4l-2 4',
  laser: 'M3 14a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M11 14h10M17 10v8',
}
export const ROBOT_ICON: Record<RobotKind, string> = {
  scout: 'M12 4 21 20H3zM12 13v2',
  drone: 'M12 7 19 19H5zM3 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M17 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  repair: 'M12 4 21 20H3zM12 11v6M9 14h6',
  shield: 'M12 2 21 7v10l-9 5-9-5V7zM8 11a5 5 0 0 1 8 0',
  tank: 'M4 6h16v12H4zM4 10h16M8 14h8',
  splitter: 'M12 2 21 7v10l-9 5-9-5V7zM12 2v20',
  breaker: 'M4 4h16v16H4zM8 8l8 4-8 4z',
  colossus: 'M4 4h16v16H4zM8 8h8v8H8z',
}

export const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
export const towerColor = (k: TowerKind) => DMG_COLOR[TOWERS[k].dmg]
export const robotColor = (k: RobotKind) => ARMOR_COLOR[ROBOTS[k].armor]
/** Inline SVG for HTML panels, same icons as the board. */
export const svgIcon = (d: string, color: number, size = 22) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${hex(color)}" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="${d}"/></svg>`

