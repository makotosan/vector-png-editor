// Decoded-RGBA extraction for PNG byte streams, mirroring what
// the Python Core's render gate reads through PIL
// (Image.open(...).convert("RGBA") -> (size, tobytes())):
// scanline unfiltering and expansion of every color type to
// 8-bit RGBA. The gate compares two renders of the same engine,
// and both engines here emit 8-bit RGBA (color type 6) PNGs;
// the other color types are expanded per the PNG specification
// so a differently-encoded but pixel-equal render still compares
// equal, as it does under PIL. 16-bit channels are reduced by
// their high byte (neither renderer emits 16-bit output; PIL's
// own 16-bit conversions apply scaling that is not reproduced
// here), and Adam7 interlacing is rejected — neither renderer
// produces it.
import { parseChunks } from './container.ts';
import { inflateBounded } from './zlib.ts';

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePngRgba(png: Uint8Array): RgbaImage {
  const chunks = parseChunks(png);
  const ihdr = chunks.find((chunk) => chunk.kind === 'IHDR');
  if (ihdr === undefined || ihdr.payload.length !== 13) {
    throw new Error('Renderer PNG has no valid IHDR');
  }
  const view = new DataView(
    ihdr.payload.buffer, ihdr.payload.byteOffset, ihdr.payload.byteLength,
  );
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const bitDepth = ihdr.payload[8];
  const colorType = ihdr.payload[9];
  const interlace = ihdr.payload[12];
  if (interlace !== 0) {
    throw new Error('Renderer PNG is interlaced; interlaced output is unsupported');
  }
  const channels = CHANNELS[colorType];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(bitDepth)) {
    throw new Error(`Renderer PNG has unsupported format (color ${colorType}, depth ${bitDepth})`);
  }
  if (colorType === 3 && bitDepth === 16) {
    throw new Error('Renderer PNG has unsupported format (palette, depth 16)');
  }
  const paletteChunk = chunks.find((chunk) => chunk.kind === 'PLTE');
  const trnsChunk = chunks.find((chunk) => chunk.kind === 'tRNS');
  const idat = Buffer.concat(
    chunks.filter((chunk) => chunk.kind === 'IDAT').map((chunk) => chunk.payload),
  );
  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const expected = height * (rowBytes + 1);
  const inflated = inflateBounded(idat, expected);
  if (inflated.status !== 'ok' || inflated.output.length !== expected) {
    throw new Error('Renderer PNG pixel data does not decode to the declared size');
  }
  // Unfilter (bytes per pixel for filtering rounds up to 1).
  const raw = inflated.output;
  const filterUnit = Math.max(1, Math.floor(bitsPerPixel / 8));
  const rows: Uint8Array[] = [];
  let prev: Uint8Array | undefined;
  for (let y = 0; y < height; y++) {
    const start = y * (rowBytes + 1);
    const filter = raw[start];
    const row = new Uint8Array(raw.subarray(start + 1, start + 1 + rowBytes));
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= filterUnit ? row[x - filterUnit] : 0;
      const up = prev !== undefined ? prev[x] : 0;
      const upLeft = prev !== undefined && x >= filterUnit ? prev[x - filterUnit] : 0;
      switch (filter) {
        case 0: break;
        case 1: row[x] = (row[x] + left) & 0xff; break;
        case 2: row[x] = (row[x] + up) & 0xff; break;
        case 3: row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          row[x] = (row[x] + predictor) & 0xff;
          break;
        }
        default:
          throw new Error(`Renderer PNG uses unknown filter ${filter}`);
      }
    }
    rows.push(row);
    prev = row;
  }
  const sample = (row: Uint8Array, x: number, channel: number): number => {
    if (bitDepth === 8) return row[x * channels + channel];
    if (bitDepth === 16) return row[(x * channels + channel) * 2];
    // Sub-byte samples (grayscale 1/2/4, palette indices).
    const bit = x * bitDepth;
    const byte = row[Math.floor(bit / 8)];
    const shift = 8 - bitDepth - (bit % 8);
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };
  const scale = (value: number): number =>
    bitDepth >= 8 ? value : Math.round((value * 255) / ((1 << bitDepth) - 1));
  const palette = paletteChunk?.payload;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      switch (colorType) {
        case 6:
          data[off] = sample(row, x, 0);
          data[off + 1] = sample(row, x, 1);
          data[off + 2] = sample(row, x, 2);
          data[off + 3] = sample(row, x, 3);
          break;
        case 2:
          data[off] = sample(row, x, 0);
          data[off + 1] = sample(row, x, 1);
          data[off + 2] = sample(row, x, 2);
          data[off + 3] = 255;
          break;
        case 4: {
          const gray = scale(sample(row, x, 0));
          data[off] = gray;
          data[off + 1] = gray;
          data[off + 2] = gray;
          data[off + 3] = sample(row, x, 1);
          break;
        }
        case 0: {
          const gray = scale(sample(row, x, 0));
          data[off] = gray;
          data[off + 1] = gray;
          data[off + 2] = gray;
          data[off + 3] = 255;
          break;
        }
        case 3: {
          const index = sample(row, x, 0);
          if (palette === undefined || index * 3 + 2 >= palette.length) {
            throw new Error('Renderer PNG palette index out of range');
          }
          data[off] = palette[index * 3];
          data[off + 1] = palette[index * 3 + 1];
          data[off + 2] = palette[index * 3 + 2];
          data[off + 3] =
            trnsChunk !== undefined && index < trnsChunk.payload.length
              ? trnsChunk.payload[index]
              : 255;
          break;
        }
      }
    }
  }
  return { width, height, data };
}

/** The Core gate's equality: same size, same decoded RGBA bytes. */
export function rgbaEqual(a: RgbaImage, b: RgbaImage): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.data.length !== b.data.length) return false;
  return a.data.every((byte, index) => byte === b.data[index]);
}
