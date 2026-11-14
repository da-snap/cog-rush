// All tuning values in one place (GDD: Economy and match pacing, Towers, Robots).
// Sim units: 1 cell = 1000 "mc" (milli-cells), HP is stored x1000. Integer math only.

export const TICK_HZ = 20
export const MC = 1000

export const COLS = 11
export const ROWS = 20
export const SPAWN_ROWS = 2 // rows 0..1
export const EXIT_ROWS = 2 // rows 18..19

export const START_GOLD = 175 // fun plan 2026-11-09: thinner minute-1 maze so early sends can hurt
export const START_INCOME = 10
export const INCOME_EVERY_S = 5 // Daniel 2026-10-22: halved from the GDD's 10 s
export const LIVES = 100 // fun plan: core HP; a leak costs ROBOTS[kind].leak (x2 while sealed)
export const SELL_REFUND_PCT = 75

export const WAVE_EVERY_S = 30
export const FIRST_WAVE_S = 30 // default for gap 3: first neutral wave 10 s after prep ends
export const WAVE_HP_GROWTH_PCT = 8

export const BREACH = {
  speedPct: 150,
  towerDmgMult: 3,
  hpCostPer: 50, // breach field: crossing a tower cell costs 1 + hp/50 steps
}

export type Armor = 'light' | 'heavy' | 'shielded'
export type DamageType = 'kinetic' | 'explosive' | 'energy'

export const ARMOR_MULT_PCT: Record<DamageType, Record<Armor, number>> = {
  kinetic: { light: 150, heavy: 100, shielded: 50 },
  explosive: { light: 50, heavy: 150, shielded: 100 },
  energy: { light: 100, heavy: 50, shielded: 150 },
}

// Upgrades: L2 costs 1x base, L3 2x base. Each level: +60% dmg, +10% range, +25% HP (compounding).
export const UPGRADE = { costMult: [1, 2], dmgPct: 160, rangePct: 110, hpPct: 125 }

export type Attack = 'single' | 'splash' | 'aura' | 'chain' | 'beam'
export interface TowerDef {
  name: string; cost: number; hp: number; rangeMc: number; dps: number; dmg: DamageType
  ground: boolean; air: boolean; attack: Attack
  period: number // ticks between shots; damage per shot = dps * period / TICK_HZ
  splashMc?: number; slowPct?: number; chain?: number; chainMc?: number; beamMc?: number
  branches: [Branch, Branch]
}
export interface Branch { key: string; name: string; desc: string }

export const TOWERS = {
  gatling: {
    name: 'Gatling', cost: 25, hp: 250, rangeMc: 3000, dps: 15, dmg: 'kinetic', ground: true, air: true, attack: 'single', period: 2,
    branches: [{ key: 'pierce', name: 'Armor-piercing', desc: 'Ignores armor type' }, { key: 'overdrive', name: 'Overdrive', desc: '+80% fire rate' }],
  },
  flak: {
    name: 'Flak', cost: 40, hp: 220, rangeMc: 4000, dps: 50, // balance: GDD 25, but Explosive does 0.5x to Drones (Light), the only air robot
    dmg: 'explosive', ground: false, air: true, attack: 'splash', period: 10, splashMc: 750,
    branches: [{ key: 'longRange', name: 'Long range', desc: '+50% range' }, { key: 'shrapnel', name: 'Shrapnel', desc: 'Wider splash' }],
  },
  emp: {
    name: 'EMP', cost: 50, hp: 220, rangeMc: 2500, dps: 5, dmg: 'energy', ground: true, air: true, attack: 'aura', period: 10, slowPct: 40,
    branches: [{ key: 'stun', name: 'Stun pulse', desc: 'Stuns robots in range every 5 s' }, { key: 'overload', name: 'Overload', desc: 'Slowed robots take +25% damage' }],
  },
  mortar: {
    name: 'Mortar', cost: 60, hp: 250, rangeMc: 4000, dps: 18, dmg: 'explosive', ground: true, air: false, attack: 'splash', period: 30, splashMc: 1000,
    branches: [{ key: 'burn', name: 'Burning ground', desc: 'Impact cell burns for 3 s' }, { key: 'cluster', name: 'Cluster shells', desc: '3 smaller impacts' }],
  },
  tesla: {
    name: 'Tesla', cost: 70, hp: 250, rangeMc: 2500, dps: 15, dmg: 'energy', ground: true, air: true, attack: 'chain', period: 10, chain: 3, chainMc: 1500,
    branches: [{ key: 'chain5', name: 'Chain 5', desc: 'Chains to 5 targets' }, { key: 'arcFocus', name: 'Arc focus', desc: '+100% damage, chains to 1' }],
  },
  laser: {
    name: 'Laser', cost: 90, hp: 270, rangeMc: 5000, dps: 30, dmg: 'energy', ground: true, air: false, attack: 'beam', period: 1, beamMc: 400,
    branches: [{ key: 'wide', name: 'Wide beam', desc: 'Wider beam' }, { key: 'melt', name: 'Melt', desc: 'Damage ramps up on the same target' }],
  },
} satisfies Record<string, TowerDef>
export type TowerKind = keyof typeof TOWERS
export const TOWER_KINDS = Object.keys(TOWERS) as TowerKind[]

// Branch numbers the GDD doesn't give yet (placeholders, tune freely).
export const BRANCH = {
  overdrivePct: 180,
  longRangePct: 150,
  shrapnelSplashMc: 1500,
  stunEveryTicks: 100, stunTicks: 20, // stun lasts 1 s
  overloadPct: 125,
  burnTicks: 60, burnDpsPct: 50, // burning cell: 50% of the mortar's dps for 3 s
  clusterOffsetsMc: [[0, 0], [-800, 0], [800, 0]], clusterDmgPct: 50, clusterSplashMc: 600,
  chain5: 5, arcFocusDmgPct: 200,
  wideBeamMc: 900,
  meltRampPctPerS: 20, meltMaxPct: 300,
}

export type RobotKind = 'scout' | 'drone' | 'repair' | 'shield' | 'tank' | 'splitter' | 'breaker' | 'colossus'
export interface RobotDef {
  name: string; armor: Armor; air: boolean; hp: number; speedMcPerS: number
  sendCost: number; buildS: number; maxWave: number; factoryCost: number
  leak: number // core damage when it reaches the exit
  towerDps: number // open design gap 1: placeholder damage vs towers (Breach multiplies by 3)
  radiusMc: number // crowd footprint (Daniel 2026-11-14): 3 Scouts or 2 mid-size fit a 1-cell gap, a Colossus fills it; air ignores it
}
// balance vs GDD: Scout 60→40 HP, Drone 120→90, Tank 400→480, Breaker 300→360 (speed decides exposure in a maze)
export const ROBOTS: Record<RobotKind, RobotDef> = {
  scout: { name: 'Scout', armor: 'light', air: false, hp: 40, speedMcPerS: 2000, sendCost: 10, buildS: 1, maxWave: 12, factoryCost: 0, leak: 1, towerDps: 10, radiusMc: 160 },
  drone: { name: 'Drone', armor: 'light', air: true, hp: 90, speedMcPerS: 1400, sendCost: 25, buildS: 3, maxWave: 6, factoryCost: 120, leak: 2, towerDps: 0, radiusMc: 0 },
  repair: { name: 'Repair bot', armor: 'light', air: false, hp: 150, speedMcPerS: 1000, sendCost: 30, buildS: 4, maxWave: 3, factoryCost: 150, leak: 3, towerDps: 10, radiusMc: 225 },
  shield: { name: 'Shield bot', armor: 'shielded', air: false, hp: 200, speedMcPerS: 1000, sendCost: 35, buildS: 4, maxWave: 3, factoryCost: 150, leak: 3, towerDps: 10, radiusMc: 225 },
  tank: { name: 'Tank', armor: 'heavy', air: false, hp: 400, speedMcPerS: 800, sendCost: 40, buildS: 5, maxWave: 4, factoryCost: 150, leak: 4, towerDps: 10, radiusMc: 240 },
  splitter: { name: 'Splitter', armor: 'shielded', air: false, hp: 250, speedMcPerS: 1000, sendCost: 45, buildS: 5, maxWave: 3, factoryCost: 180, leak: 3, towerDps: 10, radiusMc: 225 },
  breaker: { name: 'Breaker', armor: 'heavy', air: false, hp: 300, speedMcPerS: 900, sendCost: 50, buildS: 6, maxWave: 3, factoryCost: 200, leak: 4, towerDps: 20, radiusMc: 240 },
  colossus: { name: 'Colossus', armor: 'heavy', air: false, hp: 3000, speedMcPerS: 600, sendCost: 300, buildS: 30, maxWave: 1, factoryCost: 400, leak: 15, towerDps: 40, radiusMc: 480 },
}
export const ROBOT_KINDS = Object.keys(ROBOTS) as RobotKind[]

export const AURA = { repairMc: 2000, repairPctPerS: 1.5, shieldMc: 2000, shieldPct: 25 } // balance: % of the target's max HP (flat GDD values break once HP scales; healing stacks up over a long maze)

// Factories and sending. Values marked "default" are not in the GDD yet.
export const FACTORY = {
  slots: 4, // Scout is free and uses no slot
  upgradeCostMult: [1, 2], // default: L2 = 1x factory cost, L3 = 2x (like towers)
  scoutUpgradeCost: 100, // default: Scout factory has no build cost to scale from
  hpPctPerLevel: 25,
  buildPctByLevel: [100, 75, 50], // fun plan: upgraded factories build faster
  waveCapPctPerLevel: 50, // default: max per wave +50% per level
}
export const SEND = {
  prepS: 20,
  hpPct: 200, // balance: sent robots get 2x the GDD HP (neutrals use the base table)
  hpGrowthPctPerMin: 10, hpGrowthPctPerMin2: 20, // fun plan: linear, not compounding (45%/min compounding made a 10:00 Scout tougher than a Colossus)
  goldPerIncome: 25, // +1 income per 15 gold of robots released
  burstMin: 6, burstShieldPct: 30, // Overdrive: a release of 6+ robots spawns with a 30% shield
  previewS: 4,
  bountyPct: 25, // to the defender, also for neutral kills (default for gap 2)
  leakPct: 30, // to the sender
  colossusFromS: 300, // default: gate is on sending
}
export const SUDDEN = { fromS: 480, everyS: 15, hpGrowthPct: 60 }

// ponytail: fixed 4-wave neutral cycle, "small and predictable", one extra Scout every 4 waves.
export function neutralWave(n: number): RobotKind[] {
  const base = ([
    ['scout', 'scout', 'scout', 'scout'],
    ['scout', 'scout', 'drone', 'drone'],
    ['tank', 'scout', 'scout'],
    ['shield', 'scout', 'scout'],
  ] as RobotKind[][])[n % 4]
  return [...base, ...Array(Math.floor(n / 4)).fill('scout')]
}
