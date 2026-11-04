import { TrackEffects, VocalScale } from '../types/audio';
import { DEFAULT_EFFECTS } from './synthStems';

export interface EffectPreset {
  id: string;
  label: string;
  desc: string;
  values: Partial<TrackEffects>;
}

export const VOCAL_SCALES: { id: VocalScale; label: string; semitones: number[] }[] = [
  { id: 'C_major', label: 'C Maj / A Min', semitones: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'G_major', label: 'G Maj / E Min', semitones: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'F_major', label: 'F Maj / D Min', semitones: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'D_major', label: 'D Maj / B Min', semitones: [1, 2, 4, 6, 7, 9, 11] },
  { id: 'Eb_major', label: 'Eb Maj / C Min', semitones: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'chromatic', label: 'Chromatic (12-Note)', semitones: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

/**
 * One-tap voice chains. Each preset combines cleanup (noise removal, softener),
 * pitch & harmony, tone (EQ), dynamics (compressor), and space (reverb / delay)
 * so ordinary recordings sound polished for their use case.
 */
export const VOICE_PRESETS: EffectPreset[] = [
  {
    id: 'studioSinger',
    label: 'Studio singer',
    desc: 'Smooth, airy lead vocal with natural pitch tune & plate reverb',
    values: {
      voiceSoftener: 55, noiseRemoval: 30, dryLevel: 100, wetLevel: 100,
      autoPitchAmount: 45, autoPitchScale: 'C_major', harmonyAmount: 20, harmonyMode: 'doubler',
      eqLowGain: -2.5, eqMidGain: 2, eqMidFreq: 3000, eqMidQ: 1.2, eqHighGain: 4,
      compEnabled: true, compThreshold: -20, compRatio: 3.5, compAttack: 0.012, compRelease: 0.14,
      drive: 5, reverbMix: 0.22, reverbDecay: 1.8, delayMix: 0.1, delayTime: 0.375, delayFeedback: 0.3,
    },
  },
  {
    id: 'autoTunePop',
    label: 'Auto-Tune pop',
    desc: 'Hard pitch snap with modern crisp vocal presence & stereo doubler',
    values: {
      voiceSoftener: 50, noiseRemoval: 35, dryLevel: 100, wetLevel: 105,
      autoPitchAmount: 95, autoPitchScale: 'C_major', harmonyAmount: 35, harmonyMode: 'doubler',
      eqLowGain: -3, eqMidGain: 3, eqMidFreq: 3200, eqMidQ: 1.4, eqHighGain: 5,
      compEnabled: true, compThreshold: -22, compRatio: 5, compAttack: 0.005, compRelease: 0.1,
      drive: 8, reverbMix: 0.2, reverbDecay: 1.6, delayMix: 0.15, delayTime: 0.25, delayFeedback: 0.35,
    },
  },
  {
    id: 'choirHarmony',
    label: 'Choir harmony',
    desc: 'Layered stereo vocal harmonies with lush hall space',
    values: {
      voiceSoftener: 60, noiseRemoval: 30, dryLevel: 90, wetLevel: 120,
      autoPitchAmount: 60, autoPitchScale: 'C_major', harmonyAmount: 75, harmonyMode: 'choir',
      eqLowGain: -1, eqMidGain: 1.5, eqMidFreq: 2500, eqMidQ: 1.0, eqHighGain: 3.5,
      compEnabled: true, compThreshold: -20, compRatio: 3.5, compAttack: 0.015, compRelease: 0.2,
      drive: 4, reverbMix: 0.4, reverbDecay: 3.0, delayMix: 0.12, delayTime: 0.375, delayFeedback: 0.3,
    },
  },
  {
    id: 'stageSinger',
    label: 'Stage singer',
    desc: 'Big concert-hall reverb with rhythmic echo',
    values: {
      voiceSoftener: 45, noiseRemoval: 25, dryLevel: 90, wetLevel: 115,
      autoPitchAmount: 35, harmonyAmount: 25, harmonyMode: 'octave',
      eqLowGain: -1.5, eqMidGain: 1.5, eqMidFreq: 2800, eqMidQ: 1.1, eqHighGain: 3.5,
      compEnabled: true, compThreshold: -22, compRatio: 3, compAttack: 0.012, compRelease: 0.16,
      drive: 8, reverbMix: 0.42, reverbDecay: 3.2, delayMix: 0.22, delayTime: 0.5, delayFeedback: 0.42,
    },
  },
  {
    id: 'podcast',
    label: 'Podcast',
    desc: 'Clear, present speech with background noise reduced',
    values: {
      voiceSoftener: 45, noiseRemoval: 65, dryLevel: 100, wetLevel: 100,
      autoPitchAmount: 0, harmonyAmount: 0,
      eqLowGain: 2, eqMidGain: 2.5, eqMidFreq: 3500, eqMidQ: 1, eqHighGain: 1.5,
      compEnabled: true, compThreshold: -24, compRatio: 4, compAttack: 0.008, compRelease: 0.2,
      drive: 0, reverbMix: 0, delayMix: 0,
    },
  },
  {
    id: 'storyteller',
    label: 'Storyteller',
    desc: 'Warm, intimate narration with a touch of room',
    values: {
      voiceSoftener: 60, noiseRemoval: 50, dryLevel: 100, wetLevel: 90,
      autoPitchAmount: 0, harmonyAmount: 0,
      eqLowGain: 3, eqMidGain: 1.5, eqMidFreq: 2200, eqMidQ: 1, eqHighGain: 1,
      compEnabled: true, compThreshold: -22, compRatio: 3, compAttack: 0.015, compRelease: 0.25,
      drive: 4, reverbMix: 0.12, reverbDecay: 1.2, delayMix: 0,
    },
  },
  {
    id: 'radioHost',
    label: 'Radio host',
    desc: 'Deep, punchy broadcast voice',
    values: {
      voiceSoftener: 25, noiseRemoval: 55, dryLevel: 100, wetLevel: 100,
      autoPitchAmount: 0, harmonyAmount: 0,
      eqLowGain: 4, eqMidGain: 3, eqMidFreq: 3200, eqMidQ: 1.4, eqHighGain: 2,
      compEnabled: true, compThreshold: -26, compRatio: 6, compAttack: 0.004, compRelease: 0.12,
      drive: 12, reverbMix: 0.05, reverbDecay: 0.6, delayMix: 0,
    },
  },
  {
    id: 'cleanVoice',
    label: 'Clean voice',
    desc: 'Just remove noise and even out the level',
    values: {
      voiceSoftener: 35, noiseRemoval: 70, dryLevel: 100, wetLevel: 100,
      autoPitchAmount: 0, harmonyAmount: 0,
      compEnabled: true, compThreshold: -26, compRatio: 2.5, compAttack: 0.01, compRelease: 0.18,
      reverbMix: 0, delayMix: 0,
    },
  },
];

export const MUSIC_PRESETS: EffectPreset[] = [
  {
    id: 'brightAir',
    label: 'Bright air',
    desc: 'Open top end',
    values: {
      voiceSoftener: 35, noiseRemoval: 25,
      eqLowGain: -3.5, eqMidGain: 2.5, eqMidFreq: 2800, eqMidQ: 1.4, eqHighGain: 5.5,
      compEnabled: true, compThreshold: -22, compRatio: 4.5,
      reverbMix: 0.22, reverbDecay: 1.9, delayMix: 0.14, delayTime: 0.375, drive: 8,
    },
  },
  {
    id: 'warmBass',
    label: 'Sub warmth',
    desc: 'Fat low end',
    values: {
      eqLowGain: 5.5, eqMidGain: -2, eqMidFreq: 450, eqMidQ: 1.8, eqHighGain: -4,
      compEnabled: true, compThreshold: -18, compRatio: 6, drive: 28,
    },
  },
  {
    id: 'ambientHall',
    label: 'Wet space',
    desc: 'Lush reverb and echo',
    values: {
      voiceSoftener: 40, noiseRemoval: 20, dryLevel: 75, wetLevel: 120,
      eqLowGain: -2, eqMidGain: 1.5, eqMidFreq: 1600, eqHighGain: 4,
      reverbMix: 0.52, reverbDecay: 3.8, delayMix: 0.32, delayTime: 0.5, delayFeedback: 0.55,
    },
  },
  { id: 'reset', label: 'Reset', desc: 'Back to flat', values: {} },
];

export const applyPresetValues = (preset: EffectPreset): TrackEffects => ({
  ...DEFAULT_EFFECTS,
  ...preset.values,
});
