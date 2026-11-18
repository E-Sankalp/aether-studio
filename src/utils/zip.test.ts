import { describe, expect, it } from 'vitest';
import { crc32, createZip } from './zip';
import { quantize16 } from '../audio/audioEncoders';

describe('zip', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a readable stored archive', async () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new TextEncoder().encode('hello stems');
    const zip = new Uint8Array(await createZip([{ name: 'Drums.wav', data: a }, { name: 'Vocal ✓.wav', data: b }]).arrayBuffer());
    const v = new DataView(zip.buffer);
    // end of central directory
    const eocd = zip.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(2);
    let cd = v.getUint32(eocd + 16, true);
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      expect(v.getUint32(cd, true)).toBe(0x02014b50);
      const size = v.getUint32(cd + 24, true);
      const nameLen = v.getUint16(cd + 28, true);
      const local = v.getUint32(cd + 42, true);
      const crc = v.getUint32(cd + 16, true);
      names.push(new TextDecoder().decode(zip.subarray(cd + 46, cd + 46 + nameLen)));
      // local header points at the same data, and the CRC checks out
      expect(v.getUint32(local, true)).toBe(0x04034b50);
      const dataStart = local + 30 + v.getUint16(local + 26, true);
      expect(crc32(zip.subarray(dataStart, dataStart + size))).toBe(crc);
      cd += 46 + nameLen;
    }
    expect(names).toEqual(['Drums.wav', 'Vocal ✓.wav']);
  });
});

describe('16-bit dither', () => {
  it('keeps detail below 1 LSB instead of truncating it to silence', () => {
    // A tone at 0.4 LSB: plain rounding turns it into digital silence
    const n = 48000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (0.4 / 32767) * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    const plain = Array.from(x, (s) => Math.round(s * 32767));
    expect(plain.every((v) => v === 0)).toBe(true);
    const q = quantize16(x);
    let corr = 0;
    for (let i = 0; i < n; i++) corr += q[i] * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    // correlation with the tone ~ amplitude * n / 2 = 9600
    expect(corr / (n / 2)).toBeGreaterThan(0.3);
    expect(corr / (n / 2)).toBeLessThan(0.5);
  });

  it('adds only about 1 LSB of noise and clips cleanly', () => {
    const q = quantize16(new Float32Array(10000));
    const rms = Math.sqrt(q.reduce((s, v) => s + v * v, 0) / q.length);
    expect(rms).toBeGreaterThan(0.3);
    expect(rms).toBeLessThan(0.8);
    expect(Math.max(...q.map(Math.abs))).toBeLessThanOrEqual(1);
    const loud = quantize16(new Float32Array([1.5, -1.5, 1, -1]));
    expect(Array.from(loud)).toEqual([32767, -32768, expect.any(Number), expect.any(Number)]);
    expect(loud[2]).toBeGreaterThanOrEqual(32766);
  });
});
