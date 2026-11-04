import { AudioClip, AudioTrack, TrackEffects } from '../types/audio';
import { audioEngine } from './audioEngine';
import { applyPresetValues, VOICE_PRESETS } from './presets';
import {
  DEFAULT_EFFECTS,
  generateBassStem,
  generateChordsStem,
  generateDrumsStem,
  generateLeadStem,
} from './synthStems';

export type TemplateId = 'scratch' | 'singing' | 'podcast' | 'story' | 'demo';

export const TRACK_COLORS = ['#f12c4c', '#ff8a1f', '#f5c518', '#2ecc71', '#1fb6ff', '#9b6bff'];

export interface ProjectSeed {
  tracks: AudioTrack[];
  clips: AudioClip[];
  bpm: number;
}

const makeTrack = (
  id: string,
  name: string,
  color: string,
  volume: number,
  pan: number,
  effects: Partial<TrackEffects> = {}
): AudioTrack => ({
  id,
  name,
  color,
  volume,
  pan,
  muted: false,
  solo: false,
  armed: false,
  effects: { ...DEFAULT_EFFECTS, ...effects },
});

const voiceFx = (presetId: string): TrackEffects => {
  const preset = VOICE_PRESETS.find((p) => p.id === presetId);
  return preset ? applyPresetValues(preset) : { ...DEFAULT_EFFECTS };
};

const makeClip = (
  id: string,
  trackId: string,
  name: string,
  bufferId: string,
  color: string,
  startTime: number,
  duration: number,
  fadeIn: number,
  fadeOut: number
): AudioClip => ({
  id,
  trackId,
  name,
  bufferId,
  color,
  startTime,
  duration,
  fadeIn,
  fadeOut,
  offset: 0,
  gain: 1,
  pitchSemitones: 0,
  playbackRate: 1,
});

export function buildTemplate(id: TemplateId, ctx: BaseAudioContext): ProjectSeed {
  const [red, orange, , green, blue] = TRACK_COLORS;

  switch (id) {
    case 'singing':
      return {
        bpm: 120,
        clips: [],
        tracks: [
          makeTrack('trk_vocals', 'Vocals', red, 0.9, 0, voiceFx('studioSinger')),
          makeTrack('trk_backing', 'Backing', blue, 0.7, 0),
        ],
      };

    case 'podcast':
      return {
        bpm: 120,
        clips: [],
        tracks: [
          makeTrack('trk_host', 'Host', orange, 0.9, -0.1, voiceFx('podcast')),
          makeTrack('trk_guest', 'Guest', green, 0.9, 0.1, voiceFx('podcast')),
          makeTrack('trk_music', 'Music', blue, 0.35, 0),
        ],
      };

    case 'story':
      return {
        bpm: 90,
        clips: [],
        tracks: [
          makeTrack('trk_narration', 'Narration', green, 0.9, 0, voiceFx('storyteller')),
          makeTrack('trk_ambience', 'Ambience', blue, 0.4, 0),
        ],
      };

    case 'demo': {
      audioEngine.registerBuffer('stem_drums', generateDrumsStem(ctx, 8));
      audioEngine.registerBuffer('stem_bass', generateBassStem(ctx, 8));
      audioEngine.registerBuffer('stem_chords', generateChordsStem(ctx, 8));
      audioEngine.registerBuffer('stem_lead', generateLeadStem(ctx, 8));
      return {
        bpm: 120,
        tracks: [
          makeTrack('trk_drums', 'Drums', TRACK_COLORS[0], 0.95, 0, {
            eqLowGain: 2.5, eqHighGain: 2, compEnabled: true, compThreshold: -18, compRatio: 4, drive: 10,
          }),
          makeTrack('trk_bass', 'Bass', TRACK_COLORS[1], 0.88, 0, {
            eqLowGain: 4, eqMidGain: -1.5, compEnabled: true, compThreshold: -20, compRatio: 5, drive: 16,
          }),
          makeTrack('trk_chords', 'Chords', TRACK_COLORS[3], 0.78, -0.15, {
            eqHighGain: 3, reverbMix: 0.28, reverbDecay: 2.4,
          }),
          makeTrack('trk_lead', 'Lead', TRACK_COLORS[4], 0.82, 0.2, {
            eqMidGain: 2, eqHighGain: 3.5, delayMix: 0.24, delayTime: 0.375, delayFeedback: 0.4, reverbMix: 0.22,
          }),
        ],
        clips: [
          makeClip('clp_drums_1', 'trk_drums', 'Groove', 'stem_drums', TRACK_COLORS[0], 0, 8, 0, 0.1),
          makeClip('clp_bass_1', 'trk_bass', 'Sub bass', 'stem_bass', TRACK_COLORS[1], 0, 8, 0.05, 0.15),
          makeClip('clp_chords_1', 'trk_chords', 'Seventh chords', 'stem_chords', TRACK_COLORS[3], 0, 8, 0.25, 0.4),
          makeClip('clp_lead_1', 'trk_lead', 'Arp lead', 'stem_lead', TRACK_COLORS[4], 2, 6, 0.2, 0.5),
        ],
      };
    }

    case 'scratch':
    default:
      return {
        bpm: 120,
        clips: [],
        tracks: [makeTrack(`trk_${Date.now()}`, 'Audio 1', red, 0.85, 0)],
      };
  }
}
