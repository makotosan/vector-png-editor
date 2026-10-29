// Minimal PNG reading for tests: an IHDR header parse and a full
// decode (node:zlib inflate + scanline unfiltering), so the suite
// needs no external PNG dependency. Supports the shapes resvg
// emits: non-interlaced, bit depth 8, colour types 6 (RGBA) and
// 2 (RGB). Anything else is an explicit error, not a fallback.
import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function parsePngHeader(bytes) {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  }
  let offset = 8;
  const idat = [];
  let header;
  while (offset < bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: readU32(data, 0),
        height: readU32(data, 4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG has no IHDR');
  return { ...header, idat };
}

function readU32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function decodePng(bytes) {
  const { width, height, bitDepth, colorType, interlace, idat } = parsePngHeader(bytes);
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG shape: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const compressed = new Uint8Array(idat.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of idat) {
    compressed.set(chunk, at);
    at += chunk.length;
  }
  const raw = inflateSync(compressed);
  const data = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = new Uint8Array(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      line[x] = (line[x] + predictor) & 0xff;
    }
    data.set(line, y * stride);
    prev = line;
  }
  return {
    width,
    height,
    channels,
    data,
    /** Pixel at (x, y) as [r, g, b, a]; alpha is 255 for RGB input. */
    pixelAt(x, y) {
      const i = (y * width + x) * channels;
      return [data[i], data[i + 1], data[i + 2], channels === 4 ? data[i + 3] : 255];
    },
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
