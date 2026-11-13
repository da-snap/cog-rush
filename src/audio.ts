// Synthesized sound effects and music (WebAudio, no audio files).
// Everything is created lazily on the first user gesture, as browsers require.
import type { TowerKind } from './sim/config.ts'

let ctx: AudioContext | null = null
let master: GainNode, sfx: GainNode, music: GainNode, musicTone: BiquadFilterNode
let noise: AudioBuffer
let muted = false
try { muted = localStorage.getItem('cogrush-muted') === '1' } catch { /* storage blocked */ }

export function unlockAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return }
  ctx = new AudioContext()
  master = ctx.createGain(); master.gain.value = muted ? 0 : 0.8; master.connect(ctx.destination)
  // a little compression keeps big fights from clipping
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 6
  comp.connect(master)
  sfx = ctx.createGain(); sfx.gain.value = 0.55; sfx.connect(comp)
  music = ctx.createGain(); music.gain.value = 0.22
  // the music bus is filtered: calm = muffled, intense = full brightness
  musicTone = ctx.createBiquadFilter(); musicTone.type = 'lowpass'; musicTone.frequency.value = 1400
  music.connect(musicTone).connect(comp)
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
  const d = noise.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
}

export const isMuted = () => muted
export function toggleMute() {
  muted = !muted
  try { localStorage.setItem('cogrush-muted', muted ? '1' : '0') } catch { /* storage blocked */ }
  if (ctx) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.05)
  return muted
}

// --- building blocks -----------------------------------------------------------

function tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, dest = sfx, at = 0) {
  if (!ctx) return
  const t = ctx.currentTime + at
  const o = ctx.createOscillator(), g = ctx.createGain()
  o.type = type
  o.frequency.setValueAtTime(f0, t)
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(dest)
  o.start(t); o.stop(t + dur + 0.02)
}

function burst(dur: number, vol: number, freq: number, q = 1, type: BiquadFilterType = 'lowpass', at = 0) {
  if (!ctx) return
  const t = ctx.currentTime + at
  const s = ctx.createBufferSource(); s.buffer = noise
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q
  f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.25), t + dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(vol, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  s.connect(f).connect(g).connect(sfx)
  s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02)
}

// rate limit per sound so a full lane doesn't turn into white noise
const last = new Map<string, number>()
const ok = (key: string, gapMs: number) => {
  if (!ctx || muted) return false
  const now = performance.now()
  if ((last.get(key) ?? 0) + gapMs > now) return false
  last.set(key, now)
  return true
}

// --- effects -------------------------------------------------------------------

export function shot(kind: TowerKind) {
  if (!ok('shot-' + kind, kind === 'laser' ? 140 : 70)) return
  switch (kind) {
    case 'gatling': burst(0.05, 0.25, 3200, 0.8, 'bandpass'); tone('square', 900, 300, 0.04, 0.05); break
    case 'flak': burst(0.18, 0.35, 1800); tone('sawtooth', 300, 80, 0.12, 0.08); break
    case 'emp': tone('sine', 180, 600, 0.25, 0.12); tone('triangle', 90, 300, 0.25, 0.08); break
    case 'mortar': tone('sine', 140, 50, 0.22, 0.35); burst(0.12, 0.2, 900); break
    case 'tesla': burst(0.12, 0.25, 5000, 4, 'bandpass'); tone('sawtooth', 1200, 2400, 0.08, 0.05); break
    case 'laser': tone('sawtooth', 1600, 1500, 0.14, 0.05); tone('sine', 3200, 3000, 0.14, 0.04); break
  }
}
export function boom(big = false) {
  if (!ok('boom', 90)) return
  burst(big ? 0.7 : 0.35, big ? 0.7 : 0.4, big ? 1200 : 2200)
  tone('sine', big ? 110 : 160, 35, big ? 0.6 : 0.3, big ? 0.6 : 0.35)
}
export function kill() { if (ok('kill', 60)) { tone('square', 700, 180, 0.09, 0.07); burst(0.08, 0.15, 2500) } }
export function leak() { if (ok('leak', 200)) { tone('square', 440, 440, 0.12, 0.12); tone('square', 330, 330, 0.18, 0.12, sfx, 0.13) } }
export function build() { if (ok('build', 50)) { tone('square', 220, 110, 0.07, 0.12); burst(0.06, 0.2, 1500) } }
export function sell() { if (ok('sell', 80)) { tone('triangle', 600, 900, 0.08, 0.1); tone('triangle', 900, 1200, 0.08, 0.08, sfx, 0.07) } }
export function upgrade() { if (ok('up', 80)) [523, 659, 784].forEach((f, i) => tone('triangle', f, f, 0.12, 0.1, sfx, i * 0.06)) }
export function release() { if (ok('rel', 150)) { burst(0.4, 0.3, 600, 1, 'highpass'); tone('sawtooth', 110, 440, 0.35, 0.08) } }
export function click() { if (ok('click', 30)) tone('square', 1400, 1000, 0.03, 0.04) }
export function deny() { if (ok('deny', 120)) tone('square', 160, 120, 0.12, 0.08) }
export function horn() { if (ok('horn', 500)) { tone('sawtooth', 110, 110, 0.6, 0.12); tone('sawtooth', 165, 165, 0.6, 0.08) } }
export function alarm() { if (ok('alarm', 1500)) for (let i = 0; i < 3; i++) tone('square', 880, 660, 0.15, 0.08, sfx, i * 0.22) }
export function stinger(win: boolean) {
  const notes = win ? [392, 523, 659, 784] : [392, 330, 262, 196]
  notes.forEach((f, i) => tone('triangle', f, f, 0.35, 0.16, sfx, i * 0.16))
}

// --- music: a small industrial loop that follows the danger ---------------
// intensity 0..1 (see setIntensity) drives tempo, filter, hats, arp density and a lead line

let musicTimer = 0, step = 0, target = 0, level = 0
const BASS = [55, 55, 65.4, 55, 49, 49, 58.3, 49]
const ARP = [220, 261.6, 329.6, 261.6, 196, 246.9, 293.7, 246.9]

export function startMusic() {
  if (!ctx || musicTimer) return
  const tick = () => {
    if (!ctx) return
    level += (target - level) * 0.04 // ~2 s glide so it swells instead of jumping
    const t = ctx.currentTime
    musicTone.frequency.setTargetAtTime(1400 + level * 6600, t, 0.2)
    music.gain.setTargetAtTime(0.2 + level * 0.08, t, 0.2)
    const bar = Math.floor(step / 4) % BASS.length
    const arp = ARP[(step + bar) % ARP.length]
    if (step % 2 === 0) tone('sawtooth', BASS[bar], BASS[bar] * 0.98, 0.22, 0.25, music)
    if (step % 4 === 0) burst(0.12, 0.3, 160) // kick-ish
    if (level > 0.6 && step % 8 === 6) burst(0.12, 0.25, 160) // extra kick, double-time feel
    if (step % 8 === 4) burst(0.08, 0.18, 4000, 1, 'highpass') // snare-ish hat
    if (level > 0.3 && step % 2 === 1) burst(0.03, 0.08, 7000, 1, 'highpass') // offbeat hats
    if (level > 0.45 || step % 2 === 1) tone('square', arp, arp, 0.09, 0.05, music)
    if (level > 0.75 && step % 4 === 2) tone('sawtooth', arp * 2, arp * 2, 0.16, 0.035, music) // lead stab
    step++
    musicTimer = window.setTimeout(tick, 150 - level * 50)
  }
  tick()
}
export function stopMusic() { clearTimeout(musicTimer); musicTimer = 0 }
/** 0 = calm, 1 = all hands. Call often; the music glides toward it. */
export function setIntensity(x: number, instant = false) { target = Math.max(0, Math.min(1, x)); if (instant) level = target }
