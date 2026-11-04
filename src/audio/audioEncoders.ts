/** Offline audio encoders used by the Export menu (WAV 16/24-bit and MP3). */

export type ExportFormatId = 'wav16' | 'wav24' | 'mp3_320' | 'mp3_192' | 'mp3_128';

export interface ExportFormatOption {
  id: ExportFormatId;
  label: string;
  description: string;
  extension: 'wav' | 'mp3';
  mimeType: string;
}

export const EXPORT_FORMATS: ExportFormatOption[] = [
  {
    id: 'wav16',
    label: 'WAV · 16-bit',
    description: 'Lossless, CD quality. Largest files.',
    extension: 'wav',
    mimeType: 'audio/wav',
  },
  {
    id: 'wav24',
    label: 'WAV · 24-bit',
    description: 'Lossless studio quality for mastering.',
    extension: 'wav',
    mimeType: 'audio/wav',
  },
  {
    id: 'mp3_320',
    label: 'MP3 · 320 kbps',
    description: 'Highest MP3 quality, works everywhere.',
    extension: 'mp3',
    mimeType: 'audio/mpeg',
  },
  {
    id: 'mp3_192',
    label: 'MP3 · 192 kbps',
    description: 'Balanced quality and size.',
    extension: 'mp3',
    mimeType: 'audio/mpeg',
  },
  {
    id: 'mp3_128',
    label: 'MP3 · 128 kbps',
    description: 'Smallest file, good for sharing.',
    extension: 'mp3',
    mimeType: 'audio/mpeg',
  },
];

export const DEFAULT_EXPORT_FORMAT: ExportFormatId = 'wav16';

export function getExportFormat(id: ExportFormatId): ExportFormatOption {
  return EXPORT_FORMATS.find((f) => f.id === id) ?? EXPORT_FORMATS[0];
}

/** Encodes a rendered AudioBuffer as a PCM WAV file (16 or 24 bits per sample). */
function encodeWav(buffer: AudioBuffer, bitDepth: 16 | 24): Blob {
  const numChannels = buffer.numberOfChannels;
  const bytesPerSample = bitDepth / 8;
  const dataSize = buffer.length * numChannels * bytesPerSample;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      if (bitDepth === 16) {
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      } else {
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
      }
      offset += bytesPerSample;
    }
  }

  return new Blob([out], { type: 'audio/wav' });
}

function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Encodes an AudioBuffer as MP3. The encoder is loaded on demand to keep the app bundle small. */
async function encodeMp3(buffer: AudioBuffer, kbps: number): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const channels = Math.min(2, buffer.numberOfChannels);
  const encoder = new Mp3Encoder(channels, buffer.sampleRate, kbps);
  const left = floatToInt16(buffer.getChannelData(0));
  const right = channels > 1 ? floatToInt16(buffer.getChannelData(1)) : undefined;

  const blockSize = 1152 * 16;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < left.length; i += blockSize) {
    const l = left.subarray(i, i + blockSize);
    const chunk = right
      ? encoder.encodeBuffer(l, right.subarray(i, i + blockSize))
      : encoder.encodeBuffer(l);
    if (chunk.length > 0) parts.push(new Uint8Array(chunk));
    // Yield regularly so the UI stays responsive while long projects encode
    if ((i / blockSize) % 40 === 39) await new Promise((r) => setTimeout(r, 0));
  }
  const tail = encoder.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail));

  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}

/** Encodes a rendered mix in the chosen export format. */
export async function encodeAudioBuffer(
  buffer: AudioBuffer,
  formatId: ExportFormatId
): Promise<Blob> {
  switch (formatId) {
    case 'wav24':
      return encodeWav(buffer, 24);
    case 'mp3_320':
      return encodeMp3(buffer, 320);
    case 'mp3_192':
      return encodeMp3(buffer, 192);
    case 'mp3_128':
      return encodeMp3(buffer, 128);
    case 'wav16':
    default:
      return encodeWav(buffer, 16);
  }
}
