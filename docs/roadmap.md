# CogRush – Roadmap to the full game

Backbone: the GDD's own roadmap ("Roadmap and open questions"), cut into vertical slices. Every slice ends in something playable on a phone and keeps the sim deterministic. Source of truth for rules and numbers stays the GDD (https://claude.ai/artifact/291Hp9mNBSjU3jJai155E3); this file only orders the work.

Status as of 2026-10-22: Slices 1–4 playable (local match vs bot), PWA basics done. Code: `/home/daniel/development/CogRush` (single Vite package, sim in `src/sim/`, client in `src/main.ts`).

Legend: `[x]` done · `[ ]` to do · **Done when** = the check that closes the slice.

---

## Open design gaps (decide before or during the slice that needs them)

Found while building the sandbox. None of these are answered by the GDD yet.

1. **Robot-vs-tower DPS** (needed by Slice 2/3). Still open. Placeholder per robot in `ROBOTS[*].towerDps`: 10 for most, Breaker 20 (also hits towers next to its path in an open lane), Colossus 40, Drone 0. Breach multiplies by 3.
2. **Neutral bounty** (Slice 3). Default in code: neutral kills pay the same 25% of send cost.
3. **First-wave timing** (Slice 4). Default in code: first neutral wave at 0:30, 10 s after sending unlocks.
4. **Robots boxed in a pocket** (Slice 2). Still open. Current behaviour: the trapped robot follows the HP-weighted field and chews out at 1× damage, without Breach bonuses.
5. Already open in the GDD: 4 vs 3 factory slots (Slice 3), fixed vs random lane variants (Slice 5), sound scope for the first playable (Slice 7), trademark/domain check for "CogRush" (before any public release).
6. Smaller ones, with the defaults now in code: Repair doesn't heal shields; each robot gets one shield, no stacking; Splitter's Scouts pay bounty and count as leaks; the Colossus gate is on sending; factory upgrades cost 1×/2× the factory price (Scout factory 100/200); wave cap +50% per factory level; demolishing refunds queued robots; a leak costs 1 life for every robot type.
7. **Balance changes vs. GDD numbers** (from the headless runner, `npm run balance`; retuned 2026-10-22 after Daniel halved the income interval to 5 s): sent robots have 2× HP and gain 45% HP per minute of match time (otherwise sends stop leaking and sudden-death neutrals decide every match); Scout 60→40 HP, Drone 120→90, Tank 400→480, Breaker 300→360; Flak 25→50 dps (Explosive does 0.5× to Drones, the only air robot); Repair heals 1.5% of max HP/s and heals don't stack, Shield gives 25% of max HP once. Result: median match 11.6 min, Hard beats Normal beats Easy, a casual player beats Easy. Strongest bot strategy is a Splitter/Shield/Repair + Scout mix (96%); Splitters alone win 44%, so it's the mixed-armor combo, not one robot.

---

## Slice 1 – Lane sandbox ✅ DONE

- [x] Vite + TypeScript + PixiJS v8 project, portrait client
- [x] Deterministic integer sim at 20 Hz, command queue in, events out
- [x] 11×20 lane, spawn/exit rows unbuildable
- [x] Gatling tower: place, sell (75% refund), target and fire
- [x] Flow-field pathfinding (Dijkstra from exit), recomputed on build/sell/destroy
- [x] Seal check with red "seals your lane" preview
- [x] Breach mode: +50% speed, 3× tower damage, 3×3 splash, HP-weighted field, no refund, 2 lives per leak
- [x] Neutral waves every 30 s with +8% HP, Scout and Tank
- [x] Lives, gold, income tick
- [x] Sim tests (`npm test`)

**Done when:** you can maze one lane with Gatlings on a phone, neutral waves walk the shortest path, and sealing triggers Breach. ✔

---

## Slice 2 – Combat ✅ DONE

Goal: all six towers, upgrades and the damage triangle feel right in the single-lane sandbox.

- [ ] Decide gap 4 (boxed-in robots) and gap 1 (robot-vs-tower DPS) (placeholders in config, still Daniel's call)
- [x] Tower data table for all six: Gatling, Flak, EMP, Mortar, Tesla, Laser (cost, HP, range, DPS, damage type, targets)
- [x] Ground vs air targeting flag on towers and robots
- [x] Attack behaviours: single target, splash (Flak, Mortar), slow aura (EMP), chain (Tesla), line pierce (Laser)
- [x] Damage triangle applied on every hit (already in config, wire it to all towers)
- [x] Upgrades L2 (1× cost: +60% dmg, +10% range, +25% HP) and L3 (2× cost, same again)
- [x] L3 branch choice for all six (12 branches: armor-piercing, overdrive, long range, shrapnel, stun, overload, burning ground, cluster, chain 5, arc focus, wide beam, melt)
- [x] Sell refund counts the upgrade spend
- [x] Build sheet with all towers; tower panel with upgrade/branch/sell and range ring
- [x] Quick walls: drag to place a line of Gatlings
- [x] Add remaining neutral robot types needed to test armor (Shield bot for shielded, Drone for air)
- [x] Sim tests: triangle multipliers, each attack type, upgrade math, branch effects stay deterministic

**Done when:** every tower and branch can be built and upgraded on a phone, and a scripted test shows two L3 towers of one type beat four mixed L1 towers against their matching armor (the GDD's "specializing has to pay" check). ✔ (sim test 10)

---

## Slice 3 – Economy and sending ✅ DONE (played vs the bot rather than hot-seat)

Goal: two lanes, real 1v1 economy, both controlled locally (hot-seat or second lane driven by a dumb scripted sender until Slice 4).

- [x] Decide gap 2 (neutral bounty) and factory slots (4 vs 3): defaults 25% and 4 slots, Daniel can still change them
- [x] Sim holds two lanes; a sent robot spawns at the other lane's spawn
- [x] Commands become per-player (`player` field on every command)
- [x] All 8 robots: Scout, Drone (straight flight), Repair bot (heal aura), Shield bot (shield aura), Tank, Splitter (3 Scouts on death), Breaker (hits towers next to path), Colossus (from 5:00)
- [x] Factories: Scout free, 4 slots, build/upgrade L2–L3 (+25% HP, bigger wave cap), demolish without refund
- [x] Send queue: per-robot build time, one-tap Release, max per wave
- [x] 4 s incoming preview event + banner with wave composition
- [x] Income: +1 per 10 gold sent, tick every 10 s, frozen while sealed
- [x] Bounty 25% to defender, leak gold 50% to sender
- [x] Full visibility: opponent lives, gold, income, factories, queued count (not types)
- [x] UI: bottom bar tabs Build · Send · Factories; top HUD with tick countdown and opponent lives
- [x] Layout: phone shows own lane + tappable mini-map / full opponent view; tablet/desktop show both lanes side by side
- [x] All economy values in `config.ts`
- [x] Sim tests: income math, bounty/leak payouts, Splitter, auras, queue release

**Done when:** two people can play a full hot-seat match on one device where sending raises income, waves are previewed 4 s ahead, and a match can be won by draining lives.

---

## Slice 4 – Bot and match flow ✅ PLAYABLE

Goal: the first real playable: one human vs a bot, start to finish.

- [x] Decide gap 3 (first-wave timing)
- [x] Match flow: menu → prep phase 20 s (sending locked) → match → sudden death from 10:00 (waves every 15 s, +30% HP) → win/lose screen
- [x] Bot issues only normal commands, with a reaction delay
- [x] Bot mazing: BFS "path gain per cell", best affordable spot, never seals
- [x] Bot tower choice by incoming armor; branch choice by most-sent robot
- [x] Bot sending: budget split by difficulty; Easy trickles, Hard bursts and counters the weakest damage type
- [ ] Bot factories: fixed plan per difficulty ✔; Hard pivots when sends keep dying (not yet)
- [x] Easy / Normal / Hard (80/20 3 s, 60/40 1.5 s, adaptive 0.5 s)
- [x] Headless bot-vs-bot runner (Node, no Pixi) that plays N seeded matches and prints win rates, match length, tower/robot usage
- [x] First balance pass with the runner: median match 10–12 min; early rush can punish greedy income (GDD "first balancing check")

**Done when:** a fresh player can beat Easy, lose to Hard, matches land around 10–12 minutes in the headless runner, and no single opener wins >60% of bot-vs-bot games. Status: median 11.4 min ✔; best strategy wins 73% (target 60%, needs real play-testing next).

---

## Slice 5 – Mastery: replays, stats, lane variants

Goal: players can see why they lost and every match isn't the same maze.

- [ ] Record matches as seed + command log; replay viewer with play/pause/speed
- [ ] Desync guard: hash state every N ticks during replay and in tests
- [ ] Post-match stats: damage per tower, leaks by robot type, income over time for both players
- [ ] Decide fixed vs random lane variants; build 3–4 lane shapes with fixed obstacles
- [ ] Bot ladder Easy → Hard with local progress saved

**Done when:** any finished match can be replayed identically from its log, the stats screen shows where it was lost, and you can pick between at least 3 lanes.

---

## Slice 6 – Mobile polish and PWA

Goal: feels like a finished phone game, installable and offline.

- [ ] Touch: 44 px targets, 32 px cells at 360 px width, pinch zoom and drag pan
- [ ] Desktop: mouse wheel/drag camera (not yet), hotkeys 1–6, Q–I, Space, U, S ✔ (plus A/B for branches, P pause)
- [x] PWA manifest + service worker; installs to home screen, local play works offline (SVG icon only; PNG icons for iOS still to do)
- [ ] Performance: 60 fps on a mid-range Android with a full Sudden-death wave on screen (pooling, batched draws)
- [ ] One-tap upgrade/send flows reviewed for thumb reach
- [ ] Onboarding: short first-match hints (build, maze, send)

**Done when:** the game installs from the browser on a mid-range phone, runs offline vs the bot at a steady 60 fps through sudden death, and every action is reachable with one thumb.

---

## Slice 7 – Online 1v1

Goal: two players on two devices.

- [ ] Restructure into a monorepo: `sim`, `client`, `bot`, `server` packages (sim already engine-independent)
- [ ] Node + WebSocket server running the same sim as authority (or lockstep; decide after a latency test)
- [ ] Lobby: create/join by code, then quick match
- [ ] Reconnect after a dropped connection; forfeit timeout
- [ ] Server-side validation of every command
- [ ] Online replays use the same command log
- [ ] Ranked rating (after casual works)

**Done when:** two phones on different networks finish a full match with no desync, and a player who drops for 10 s can rejoin.

---

## Slice 8 – 3–4 player ring

- [ ] Sim holds N lanes; sends go A → B → C → A
- [ ] Elimination: a dead player's lane is skipped in the ring
- [ ] Layout for 3–4 lanes on phone (mini-maps) and desktop
- [ ] Bot and lobby support for 3–4 players

**Done when:** a 4-player match (any mix of humans and bots) plays to a single winner.

---

## Slice 9 – Later

- [ ] Destroyable factories (rule change only; HP already in the data model)
- [ ] Real art: sprite atlas replacing vector placeholders through the visual lookup table
- [ ] Sound effects and music
- [ ] Trademark/domain check done before public launch

**Done when:** each item ships on its own; no slice depends on them.
