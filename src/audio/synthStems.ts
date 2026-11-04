import { TrackEffects } from '../types/audio';

export const DEFAULT_EFFECTS: TrackEffects = {
  eqLowGain: 0,
  eqMidGain: 0,
  eqMidFreq: 1200,
  eqMidQ: 1.2,
  eqHighGain: 0,
  compEnabled: false,
  compThreshold: -24,
  compRatio: 4,
  compAttack: 0.01,
  compRelease: 0.15,
  reverbMix: 0,
  reverbDecay: 1.8,
  delayMix: 0,
  delayTime: 0.375,
  delayFeedback: 0.35,
  drive: 0,
  voiceSoftener: 0,
  noiseRemoval: 0,
  dryLevel: 100,
  wetLevel: 100,
  autoPitchAmount: 0,
  autoPitchScale: 'C_major',
  harmonyAmount: 0,
  harmonyMode: 'choir',
};

function softClip(x: number): number {
  return Math.tanh(x);
}

/**
 * Generates a punchy stereo drum groove buffer (8 seconds at 120 BPM = 4 bars)
 */
export function generateDrumsStem(ctx: BaseAudioContext, duration = 8): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  const bpm = 120;
  const beatDur = 60 / bpm; // 0.5s per beat
  const sixteenth = beatDur / 4; // 0.125s

  const totalSixteenths = Math.floor(duration / sixteenth);

  for (let step = 0; step < totalSixteenths; step++) {
    const startSample = Math.floor(step * sixteenth * sampleRate);
    const stepInBar = step % 16;

    // Kick on 0, 4, 8, 12, 14
    if (stepInBar === 0 || stepInBar === 4 || stepInBar === 8 || stepInBar === 12 || stepInBar === 14) {
      const kickGain = stepInBar === 14 ? 0.65 : 0.95;
      const kickSamples = Math.floor(0.32 * sampleRate);
      let phase = 0;
      for (let i = 0; i < kickSamples && startSample + i < length; i++) {
        const t = i / sampleRate;
        const freq = 46 + 130 * Math.exp(-t * 36);
        phase += (2 * Math.PI * freq) / sampleRate;
        const env = Math.exp(-t * 9.5);
        const click = t < 0.008 ? Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 250) * 0.35 : 0;
        const sample = softClip((Math.sin(phase) * 1.3 + click) * env * kickGain);
        left[startSample + i] += sample;
        right[startSample + i] += sample;
      }
    }

    // Snare on 4 and 12
    if (stepInBar === 4 || stepInBar === 12) {
      const snareSamples = Math.floor(0.24 * sampleRate);
      let bodyPhase = 0;
      for (let i = 0; i < snareSamples && startSample + i < length; i++) {
        const t = i / sampleRate;
        const bodyFreq = 165 + 90 * Math.exp(-t * 45);
        bodyPhase += (2 * Math.PI * bodyFreq) / sampleRate;
        const body = Math.sin(bodyPhase) * Math.exp(-t * 20) * 0.55;
        const noiseEnv = Math.exp(-t * 14);
        const noiseL = (Math.random() * 2 - 1) * noiseEnv * 0.55;
        const noiseR = (Math.random() * 2 - 1) * noiseEnv * 0.55;
        left[startSample + i] += softClip(body + noiseL);
        right[startSample + i] += softClip(body + noiseR);
      }
    }

    // Crisp Stereo Hi-Hat on every 16th note
    const isOffbeat = stepInBar % 4 === 2;
    const hatDur = isOffbeat ? 0.095 : 0.038;
    const hatGain = isOffbeat ? 0.28 : stepInBar % 2 === 0 ? 0.16 : 0.1;
    const hatSamples = Math.floor(hatDur * sampleRate);
    for (let i = 0; i < hatSamples && startSample + i < length; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t * (isOffbeat ? 28 : 65));
      const metallic =
        Math.sin(2 * Math.PI * 6340 * t) * 0.3 +
        Math.sin(2 * Math.PI * 8420 * t) * 0.3 +
        (Math.random() * 2 - 1) * 0.7;
      left[startSample + i] += metallic * env * hatGain * 0.9;
      right[startSample + i] += metallic * env * hatGain * 1.1;
    }
  }

  return buffer;
}

/**
 * Generates an analog resonant synth bassline (8 seconds, 120 BPM)
 */
export function generateBassStem(ctx: BaseAudioContext, duration = 8): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  const bpm = 120;
  const sixteenth = 60 / bpm / 4; // 0.125s
  const totalSixteenths = Math.floor(duration / sixteenth);

  const barRoots = [55.0, 43.65, 65.41, 49.0];

  for (let step = 0; step < totalSixteenths; step++) {
    const barIdx = Math.floor(step / 16) % barRoots.length;
    const stepInBar = step % 16;
    const baseFreq = barRoots[barIdx];
    const octaveMult = stepInBar % 4 === 2 ? 2.0 : 1.0;
    const freq = baseFreq * octaveMult;

    const startSample = Math.floor(step * sixteenth * sampleRate);
    const noteSamples = Math.floor(sixteenth * 0.92 * sampleRate);

    let phase1 = 0;
    let phase2 = 0;
    let subPhase = 0;

    for (let i = 0; i < noteSamples && startSample + i < length; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / 0.006);
      const decay = Math.exp(-t * 9.5);
      const env = attack * (0.35 + 0.65 * decay);

      phase1 += (freq * 0.997) / sampleRate;
      phase2 += (freq * 1.003) / sampleRate;
      subPhase += (2 * Math.PI * baseFreq) / sampleRate;

      const saw1 = 2 * (phase1 - Math.floor(phase1 + 0.5));
      const saw2 = 2 * (phase2 - Math.floor(phase2 + 0.5));
      const sub = Math.sin(subPhase);

      const harmonicBrightness = Math.exp(-t * 14);
      const sigL = softClip((sub * 0.65 + saw1 * (0.25 + 0.45 * harmonicBrightness)) * env * 0.75);
      const sigR = softClip((sub * 0.65 + saw2 * (0.25 + 0.45 * harmonicBrightness)) * env * 0.75);

      left[startSample + i] += sigL;
      right[startSample + i] += sigR;
    }
  }

  return buffer;
}

/**
 * Generates lush stereo polysynth seventh chords
 */
export function generateChordsStem(ctx: BaseAudioContext, duration = 8): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  const chords = [
    [220.0, 261.63, 329.63, 392.0, 493.88], // Am9
    [174.61, 220.0, 261.63, 329.63, 392.0], // Fmaj9
    [261.63, 329.63, 392.0, 493.88, 587.33], // Cmaj9
    [196.0, 246.94, 293.66, 329.63, 392.0], // G6/9
  ];

  const barDur = 2.0;
  const numBars = Math.ceil(duration / barDur);

  for (let bar = 0; bar < numBars; bar++) {
    const chord = chords[bar % chords.length];
    const startSample = Math.floor(bar * barDur * sampleRate);
    const barSamples = Math.floor(barDur * sampleRate);

    for (let i = 0; i < barSamples && startSample + i < length; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / 0.18);
      const release = t > barDur - 0.25 ? Math.max(0, (barDur - t) / 0.25) : 1;
      const beatPhase = (t % 0.5) / 0.5;
      const pump = 0.45 + 0.55 * Math.min(1, beatPhase * 2.2);
      const env = attack * release * pump;

      let sumL = 0;
      let sumR = 0;
      for (let n = 0; n < chord.length; n++) {
        const freq = chord[n];
        const lfo = Math.sin(2 * Math.PI * (0.8 + n * 0.15) * t) * 0.0025;
        const sL = Math.sin(2 * Math.PI * freq * (1 - 0.003 + lfo) * t) +
                   0.35 * Math.sin(4 * Math.PI * freq * (1 - 0.002) * t);
        const sR = Math.sin(2 * Math.PI * freq * (1 + 0.003 - lfo) * t) +
                   0.35 * Math.sin(4 * Math.PI * freq * (1 + 0.002) * t);
        sumL += sL;
        sumR += sR;
      }

      left[startSample + i] += softClip((sumL / chord.length) * env * 0.65);
      right[startSample + i] += softClip((sumR / chord.length) * env * 0.65);
    }
  }

  return buffer;
}

/**
 * Generates an expressive stereo plucky lead / arpeggio melody
 */
export function generateLeadStem(ctx: BaseAudioContext, duration = 8): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  const motif = [
    659.25, 587.33, 523.25, 659.25, 783.99, 659.25, 523.25, 440.0,
    523.25, 587.33, 659.25, 523.25, 440.0, 392.0, 440.0, 523.25,
  ];

  const eighth = 0.25;
  const totalSteps = Math.floor(duration / eighth);

  for (let step = 0; step < totalSteps; step++) {
    const freq = motif[step % motif.length];
    const startSample = Math.floor(step * eighth * sampleRate);
    const noteSamples = Math.floor(eighth * 1.45 * sampleRate);

    for (let i = 0; i < noteSamples && startSample + i < length; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / 0.005);
      const decay = Math.exp(-t * 6.5);
      const vibrato = t > 0.08 ? Math.sin(2 * Math.PI * 5.5 * t) * 0.004 : 0;

      const f = freq * (1 + vibrato);
      const fundamental = Math.sin(2 * Math.PI * f * t);
      const secondHarm = Math.sin(4 * Math.PI * f * t) * Math.exp(-t * 14) * 0.55;
      const thirdHarm = Math.sin(6 * Math.PI * f * t) * Math.exp(-t * 22) * 0.35;

      const panOffset = Math.sin(step * 0.9) * 0.35;
      const sig = (fundamental + secondHarm + thirdHarm) * attack * decay * 0.42;

      left[startSample + i] += sig * (1 - panOffset * 0.5);
      right[startSample + i] += sig * (1 + panOffset * 0.5);
    }
  }

  return buffer;
}

/**
 * Generates an expressive formant-synthesized Vocal Lead stem (with subtle breath/room floor so Voice Softener & Noise Removal are immediately audible)
 */
export function generateVocalStem(ctx: BaseAudioContext, duration = 8): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  const notes = [
    { start: 0.0, dur: 1.8, freq: 440.0 },   // A4
    { start: 2.0, dur: 1.8, freq: 523.25 },  // C5
    { start: 4.0, dur: 1.8, freq: 493.88 },  // B4
    { start: 6.0, dur: 1.8, freq: 440.0 },   // A4
  ];

  // Subtle ambient mic floor so the user can test Noise Removal
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const hum = Math.sin(2 * Math.PI * 60 * t) * 0.012;
    const hiss = (Math.random() * 2 - 1) * 0.014;
    left[i] = hum + hiss;
    right[i] = hum + (Math.random() * 2 - 1) * 0.014;
  }

  for (const n of notes) {
    const startSample = Math.floor(n.start * sampleRate);
    const noteSamples = Math.floor(n.dur * sampleRate);

    for (let i = 0; i < noteSamples && startSample + i < length; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / 0.14);
      const release = t > n.dur - 0.25 ? Math.max(0, (n.dur - t) / 0.25) : 1;
      const env = attack * release;

      // Natural vocal vibrato
      const vib = Math.sin(2 * Math.PI * 5.4 * t) * 0.006 * Math.min(1, t / 0.35);
      const f0 = n.freq * (1 + vib);

      // Vocal formant harmonics ("Ah" / "Oh" vowel resonance + upper sibilance edge around 4.5kHz)
      const h1 = Math.sin(2 * Math.PI * f0 * t) * 0.55;
      const h2 = Math.sin(2 * Math.PI * f0 * 2 * t) * 0.42;
      const h3 = Math.sin(2 * Math.PI * f0 * 3 * t) * 0.25;
      const h4 = Math.sin(2 * Math.PI * f0 * 4 * t) * 0.14;
      const sibilanceEdge = Math.sin(2 * Math.PI * f0 * 10 * t) * 0.12;
      const breath = (Math.random() * 2 - 1) * 0.035;

      const voice = softClip((h1 + h2 + h3 + h4 + sibilanceEdge + breath) * env * 0.72);
      left[startSample + i] += voice * 0.96;
      right[startSample + i] += voice * 1.04;
    }
  }

  return buffer;
}
