/**
 * Shared FX return buses: one reverb and one tempo-synced (ping-pong) delay. Tracks feed them
 * through post-fader sends, so every track sits in the same space and the reverb is computed
 * once instead of per track.
 */
import { DEFAULT_RETURNS, DelayDivision, FxReturns } from '../types/audio';

/** Delay time in seconds for a note value at `bpm`. */
export function delaySeconds(division: DelayDivision, bpm: number): number {
  const beat = 60 / Math.max(40, Math.min(240, bpm));
  const mult: Record<DelayDivision, number> = {
    '1/2': 2,
    '1/4': 1,
    '1/4d': 1.5,
    '1/8': 0.5,
    '1/8d': 0.75,
    '1/16': 0.25,
  };
  return Math.min(1.9, beat * mult[division]);
}

/** Deterministic PRNG so a given reverb sounds identical in playback and every export. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stereo reverb impulse: decorrelated noise with an exponential decay reaching -60 dB at
 * `rt60` seconds, a few early reflections, and high frequencies decaying faster than lows.
 */
export function createReverbImpulse(
  ctx: BaseAudioContext,
  rt60: number,
  seed = 1
): AudioBuffer {
  const rate = ctx.sampleRate;
  const seconds = Math.max(0.4, Math.min(6, rt60));
  const length = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const rand = mulberry32(seed * 7919 + ch * 104729 + Math.round(seconds * 1000));
    const data = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const env = Math.exp((-6.9 * t) / seconds); // -60 dB at rt60
      // Darken the tail over time: one-pole low-pass whose cutoff falls as the tail decays
      const coef = 0.15 + 0.8 * Math.min(1, t / seconds);
      lp = lp + (1 - coef) * ((rand() * 2 - 1) - lp);
      data[i] = lp * env;
    }
    // Early reflections (first ~60 ms)
    const taps = [0.011, 0.019, 0.027, 0.034, 0.043, 0.058];
    taps.forEach((tap, k) => {
      const idx = Math.floor((tap + (ch ? 0.0023 : 0)) * rate);
      if (idx < length) data[idx] += (rand() > 0.5 ? 1 : -1) * 0.5 * Math.pow(0.82, k);
    });
    // Normalize total energy: convolution output power = input power x sum(h^2), so a fixed
    // sum(h^2) of 0.25 (-6 dB) keeps every size at a similar, comfortable return level.
    let sum = 0;
    for (let i = 0; i < length; i++) sum += data[i] * data[i];
    const norm = Math.sqrt(0.25 / (sum + 1e-12));
    for (let i = 0; i < length; i++) data[i] *= norm;
  }
  return ir;
}

export interface ReturnBuses {
  reverbIn: GainNode;
  delayIn: GainNode;
  output: GainNode;
  apply: (returns: FxReturns, bpm: number, immediate?: boolean) => void;
}

export function createReturnBuses(
  ctx: BaseAudioContext,
  returns: FxReturns = DEFAULT_RETURNS,
  bpm = 120
): ReturnBuses {
  const output = ctx.createGain();

  // Reverb: in -> pre-delay -> convolver -> tone -> level
  const reverbIn = ctx.createGain();
  const preDelay = ctx.createDelay(0.25);
  const convolver = ctx.createConvolver();
  const reverbTone = ctx.createBiquadFilter();
  reverbTone.type = 'lowpass';
  reverbTone.Q.value = 0.5;
  const reverbOut = ctx.createGain();
  reverbIn.connect(preDelay);
  preDelay.connect(convolver);
  convolver.connect(reverbTone);
  reverbTone.connect(reverbOut);
  reverbOut.connect(output);

  // Delay: in -> L delay -> (feedback, tone) -> R delay -> back to L  (ping-pong)
  const delayIn = ctx.createGain();
  const delayL = ctx.createDelay(2);
  const delayR = ctx.createDelay(2);
  const fbLR = ctx.createGain();
  const fbRL = ctx.createGain();
  const delayToneL = ctx.createBiquadFilter();
  delayToneL.type = 'lowpass';
  const delayToneR = ctx.createBiquadFilter();
  delayToneR.type = 'lowpass';
  const panL = ctx.createStereoPanner();
  const panR = ctx.createStereoPanner();
  const delayOut = ctx.createGain();
  delayIn.connect(delayL);
  delayL.connect(delayToneL);
  delayToneL.connect(panL);
  delayToneL.connect(fbLR);
  fbLR.connect(delayR);
  delayR.connect(delayToneR);
  delayToneR.connect(panR);
  delayToneR.connect(fbRL);
  fbRL.connect(delayL);
  panL.connect(delayOut);
  panR.connect(delayOut);
  delayOut.connect(output);

  let irSize = -1;
  const apply = (r: FxReturns, tempo: number, immediate = false) => {
    const now = ctx.currentTime;
    const set = (p: AudioParam, v: number) =>
      immediate ? (p.value = v) : p.setTargetAtTime(v, now, 0.03);

    if (Math.abs(r.reverbSize - irSize) > 0.05) {
      convolver.buffer = createReverbImpulse(ctx, r.reverbSize);
      irSize = r.reverbSize;
    }
    set(preDelay.delayTime, Math.max(0, Math.min(150, r.reverbPreDelayMs)) / 1000);
    set(reverbTone.frequency, 2500 * Math.pow(16000 / 2500, Math.max(0, Math.min(100, r.reverbTone)) / 100));
    set(reverbOut.gain, Math.max(0, Math.min(1.5, r.reverbLevel)));

    const dt = delaySeconds(r.delayDivision, tempo);
    set(delayL.delayTime, dt);
    set(delayR.delayTime, dt);
    const fb = Math.max(0, Math.min(0.85, r.delayFeedback));
    set(fbLR.gain, fb);
    set(fbRL.gain, fb);
    const toneHz = 1800 * Math.pow(14000 / 1800, Math.max(0, Math.min(100, r.delayTone)) / 100);
    set(delayToneL.frequency, toneHz);
    set(delayToneR.frequency, toneHz);
    set(panL.pan, r.delayPingPong ? -0.85 : 0);
    set(panR.pan, r.delayPingPong ? 0.85 : 0);
    set(delayOut.gain, Math.max(0, Math.min(1.5, r.delayLevel)));
  };
  apply(returns, bpm, true);

  return { reverbIn, delayIn, output, apply };
}
