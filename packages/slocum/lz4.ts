/**
 * LZ4 block decoding, for the compressed members of the Slocum file family.
 *
 * Slocum publishes each file in two forms: plain (`.sbd`, `.tbd`, `.dbd`, …)
 * and compressed (`.scd`, `.tcd`, `.dcd`, …), plus `.ccc` for a compressed
 * sensor-list cache. The compressed form is a bare sequence of
 * `(2-byte big-endian length, LZ4 block)` pairs — no LZ4 *frame* header, no
 * checksums, and each block decompresses to at most 32 KiB.
 *
 * **No dependency, on the same argument `kmz.ts` makes about ZIP libraries.**
 * The block format is published and small; this is the whole of it. A library
 * would bring the frame format, streaming, and a compressor — none of which
 * this needs — and would have to be bundled into a page whose point is that
 * it runs entirely in the reader's browser.
 *
 * Ported from `SlocumIO.jl`'s `decompress.jl`, which is what the fixture is
 * ultimately checked against.
 */

/** Each block decompresses to at most this much. */
export const MAX_BLOCK_BYTES = 32 * 1024;

/**
 * Decompress one LZ4 block.
 *
 * A block is a sequence of sequences. Each begins with a token byte whose
 * high nibble is a literal count and low nibble a match count, either of
 * which extends through following `0xff` bytes when it reads 15. Literals are
 * copied straight out; a match copies from earlier in the *output* at a
 * little-endian 16-bit backward offset, with a minimum length of 4.
 *
 * The final sequence of a block ends after its literals, with no match — so
 * running out of source right after a literal copy is the normal way to
 * finish, not a truncation.
 */
export function decompressBlock(src: Uint8Array, maxOutput = MAX_BLOCK_BYTES): Uint8Array {
  const n = src.length;
  if (n === 0) return new Uint8Array(0);

  const dst = new Uint8Array(maxOutput);
  let si = 0;
  let di = 0;

  while (si < n) {
    const token = src[si++];
    let litLen = token >> 4;
    let matchLen = token & 0x0f;

    if (litLen === 15) {
      while (si < n) {
        const extra = src[si++];
        litLen += extra;
        if (extra !== 0xff) break;
      }
    }

    if (litLen > 0) {
      if (si + litLen > n) throw new Error('LZ4: literals run past end of block');
      if (di + litLen > maxOutput) throw new Error('LZ4: output overflow copying literals');
      dst.set(src.subarray(si, si + litLen), di);
      si += litLen;
      di += litLen;
    }

    // End of block: the last sequence has literals and no match.
    if (si >= n) break;
    if (si + 2 > n) throw new Error('LZ4: truncated match offset');

    const offset = src[si] | (src[si + 1] << 8);
    si += 2;
    if (offset === 0) throw new Error('LZ4: zero match offset');

    if (matchLen === 15) {
      while (si < n) {
        const extra = src[si++];
        matchLen += extra;
        if (extra !== 0xff) break;
      }
    }
    matchLen += 4; // the format's minimum match

    const from = di - offset;
    if (from < 0) throw new Error('LZ4: match reaches before the start of the output');
    if (di + matchLen > maxOutput) throw new Error('LZ4: output overflow copying a match');

    // Byte at a time, deliberately: matches are allowed to overlap their own
    // output — that is how the format encodes a run — so `copyWithin` and any
    // other bulk move would read bytes this loop has not written yet.
    for (let k = 0; k < matchLen; k++) dst[di + k] = dst[from + k];
    di += matchLen;
  }

  return dst.subarray(0, di);
}

/**
 * Decompress a whole compressed Slocum file: `(uint16be length, block)` until
 * the bytes run out or a zero length ends it.
 */
export function decompressStream(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  let i = 0;

  while (i + 2 <= bytes.length) {
    const size = (bytes[i] << 8) | bytes[i + 1];
    i += 2;
    if (size === 0) break;
    if (i + size > bytes.length) {
      throw new Error(`LZ4: truncated block at byte ${i} (wanted ${size})`);
    }
    const out = decompressBlock(bytes.subarray(i, i + size));
    i += size;
    parts.push(out);
    total += out.length;
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/**
 * Whether a filename is one of the compressed forms.
 *
 * The rule is structural rather than a list: three characters, a family
 * letter, `c`, then a form letter. `sbd`→`scd`, `tbd`→`tcd`, `dbd`→`dcd`,
 * and `cac`→`ccc` for a cache.
 *
 * **The family set has to include `c`, or the cache is left out.** A cache
 * file's own family letter is `c`, so `ccc` — the one compressed form a
 * reader is most likely to meet, since a glider's cache directory is where
 * they mostly live — fails a set built from the data extensions alone.
 * `SlocumIO.jl` has the same set and works around it with a separate
 * `endswith(".ccc")` at the one call site that needed it.
 */
export function isCompressedName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return (
    ext.length === 3 &&
    'cdemnst'.includes(ext[0]) &&
    ext[1] === 'c' &&
    'dgc'.includes(ext[2])
  );
}
