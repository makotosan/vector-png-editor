// zlib helpers mirroring the Python Core's use of the zlib module.
//
// The Core leans on three pieces of zlib behaviour that Node's
// one-shot inflate does not reproduce directly, so they are rebuilt
// here from what Node does expose:
//
// 1. CRC-32 for PNG chunks. Node's zlib has no CRC API, so the
//    standard table-driven CRC-32/ISO-HDLC (the PNG/zlib CRC) is
//    implemented here; it is the same function as Python's
//    zlib.crc32.
//
// 2. Bounded decompression with exact stream-end semantics. The
//    Core uses zlib.decompressobj().decompress(data, cap) and then
//    distinguishes: output over the cap (unconsumed input left
//    because the output filled up), a stream that ends before the
//    input does (unused_data), a stream that never ends (truncated
//    or corrupt). Node's inflateSync with maxOutputLength throws a
//    distinct ERR_BUFFER_TOO_LARGE when the output would exceed the
//    cap, which identifies the overflow case. It silently IGNORES
//    trailing bytes after a complete stream, though, so exactness
//    is recovered by a second probe: if the input minus its last
//    byte still inflates successfully, the stream must have ended
//    before the input did (the trailing byte of a complete stream
//    is part of its Adler-32, so no proper prefix of an exact
//    stream can inflate). Truncated and corrupt inputs throw, which
//    both callers map to the same rejection as the Core.
//
// 3. Compression for building. deflateSync is used as-is. NOTE: its
//    bytes are NOT identical to Python's zlib.compress in general
//    (Node bundles zlib 1.3.2.1-motley; CPython links zlib 1.3, and
//    the two make different match choices on some inputs — measured
//    on an SVG source: 89 vs 88 bytes). The decompressed content is
//    identical; only the compressed representation varies, as it
//    may between any two zlib builds. Callers that must reproduce
//    an existing file byte-for-byte preserve the original
//    compressed payload instead (see container.ts rebuild).
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32/ISO-HDLC of the given bytes, as an unsigned 32-bit number. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type InflateOutcome =
  | { status: 'ok'; output: Buffer }
  | { status: 'overflow' }
  | { status: 'invalid' };

/**
 * Inflate `data`, accepting at most `cap` bytes of output.
 * - 'ok': the output fit the cap AND the zlib stream ends exactly
 *   at the end of `data` (the Core's eof / no unused_data /
 *   no unconsumed_tail conditions).
 * - 'overflow': the true output exceeds `cap`.
 * - 'invalid': corrupt, truncated, or trailing data after the
 *   stream end.
 */
export function inflateBounded(data: Uint8Array, cap: number): InflateOutcome {
  let output: Buffer;
  try {
    output = inflateSync(data, { maxOutputLength: cap });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      return { status: 'overflow' };
    }
    return { status: 'invalid' };
  }
  // The stream inflated within the cap. If dropping the final byte
  // still inflates, a complete stream ended before the input did:
  // trailing data, which the Core rejects.
  if (data.length > 0) {
    try {
      inflateSync(data.subarray(0, data.length - 1), { maxOutputLength: cap });
      return { status: 'invalid' };
    } catch {
      // Expected: an exact stream cannot inflate without its
      // final (Adler-32) byte.
    }
  }
  return { status: 'ok', output };
}

/** Compress with zlib format, as Python's zlib.compress does. */
export function deflate(data: Uint8Array): Buffer {
  return deflateSync(data);
}
