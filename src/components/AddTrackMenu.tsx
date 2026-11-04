import React from 'react';
import { Mic, Upload } from 'lucide-react';

export type StemType = 'vocal' | 'drums' | 'bass' | 'chords' | 'lead';

export const STEM_LABELS: Record<StemType, string> = {
  vocal: 'Vocal',
  drums: 'Drums',
  bass: 'Bass',
  chords: 'Chords',
  lead: 'Lead',
};

const OPTIONS: { type: StemType | 'empty'; title: string; desc: string; color: string }[] = [
  { type: 'empty', title: 'Empty track', desc: 'Record or drop audio in', color: '#8d8d96' },
  { type: 'vocal', title: 'Vocal', desc: 'Voice with softener & cleanup', color: '#f12c4c' },
  { type: 'drums', title: 'Drums', desc: '120 BPM groove', color: '#ff8a1f' },
  { type: 'bass', title: 'Bass', desc: 'Analog sub bass', color: '#f5c518' },
  { type: 'chords', title: 'Chords', desc: 'Warm seventh chords', color: '#2ecc71' },
  { type: 'lead', title: 'Lead', desc: 'Plucky arp melody', color: '#1fb6ff' },
];

interface AddTrackMenuProps {
  isRecording: boolean;
  onPick: (type: StemType | 'empty') => void;
  onImport: () => void;
  onRecord: () => void;
}

export const AddTrackMenu: React.FC<AddTrackMenuProps> = ({
  isRecording,
  onPick,
  onImport,
  onRecord,
}) => (
  <div className="flex flex-col">
    <div className="flex flex-col gap-1">
      {OPTIONS.map((o) => (
        <button
          key={o.type}
          onClick={() => onPick(o.type)}
          className="flex items-center gap-3 p-2 rounded-xl text-left hover:bg-raised transition-colors"
        >
          <span
            className="w-9 h-9 rounded-lg shrink-0"
            style={{ backgroundColor: `${o.color}26`, boxShadow: `inset 0 0 0 1.5px ${o.color}` }}
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-ink">{o.title}</span>
            <span className="block text-xs text-mute truncate">{o.desc}</span>
          </span>
        </button>
      ))}
    </div>
    <div className="h-px bg-line my-2" />
    <div className="grid grid-cols-2 gap-2">
      <button
        onClick={onImport}
        className="flex items-center justify-center gap-2 h-10 rounded-xl bg-raised text-[13px] font-medium hover:bg-[#2b2b31]"
      >
        <Upload className="w-4 h-4" />
        Import
      </button>
      <button
        onClick={onRecord}
        className={`flex items-center justify-center gap-2 h-10 rounded-xl text-[13px] font-medium ${
          isRecording ? 'bg-accent text-white animate-pulse' : 'bg-raised hover:bg-[#2b2b31]'
        }`}
      >
        <Mic className="w-4 h-4" />
        {isRecording ? 'Stop' : 'Record'}
      </button>
    </div>
  </div>
);
