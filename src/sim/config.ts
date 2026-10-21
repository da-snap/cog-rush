// All tuning values in one place (GDD: Economy and match pacing, Towers, Robots).
// Sim units: 1 cell = 1000 "mc" (milli-cells), HP is stored x1000. Integer math only.

export const TICK_HZ = 20
export const MC = 1000

export const COLS = 11
export const ROWS = 20
export const SPAWN_ROWS = 2 // rows 0..1
export const EXIT_ROWS = 2 // rows 18..19

export const START_GOLD = 250
export const START_INCOME = 10
export const INCOME_EVERY_S = 10
export const LIVES = 20
export const SELL_REFUND_PCT = 75

export const WAVE_EVERY_S = 30
export const FIRST_WAVE_S = 20 // ponytail: prep phase reused as the first-wave delay; sending isn't in the sandbox yet
export const WAVE_HP_GROWTH_PCT = 8
export const SPAWN_GAP_TICKS = 10 // 0.5 s between robots of one wave

export const BREACH = {
  speedPct: 150,
  towerDmgMult: 3,
  baseTowerDps: 10, // not in the GDD yet: robot damage vs towers before the 3x Breach multiplier
  hpCostPer: 50, // breach field: crossing a tower cell costs 1 + hp/50 steps
}

export type Armor = 'light' | 'heavy' | 'shielded'
export type DamageType = 'kinetic' | 'explosive' | 'energy'

export const ARMOR_MULT_PCT: Record<DamageType, Record<Armor, number>> = {
  kinetic: { light: 150, heavy: 100, shielded: 50 },
  explosive: { light: 50, heavy: 150, shielded: 100 },
  energy: { light: 100, heavy: 50, shielded: 150 },
}

export type TowerKind = 'gatling'
export const TOWERS: Record<TowerKind, { cost: number; hp: number; rangeMc: number; dps: number; dmg: DamageType }> = {
  gatling: { cost: 25, hp: 250, rangeMc: 3000, dps: 15, dmg: 'kinetic' },
}

export type RobotKind = 'scout' | 'tank'
export const ROBOTS: Record<RobotKind, { armor: Armor; hp: number; speedMcPerS: number; sendCost: number }> = {
  scout: { armor: 'light', hp: 60, speedMcPerS: 2000, sendCost: 10 },
  tank: { armor: 'heavy', hp: 400, speedMcPerS: 800, sendCost: 40 },
}

// ponytail: fixed neutral pattern, "small and predictable". Swap for a table when more robot types land.
export function neutralWave(n: number): RobotKind[] {
  return n % 3 === 2 ? ['tank', 'tank', 'scout', 'scout'] : Array(6).fill('scout')
}
