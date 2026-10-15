import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const NL = 0x0a;
const DEFAULT_CHUNK = 256 * 1024;

/**
 * Lines of a file from the last one up, read chunk by chunk so a multi-MB
 * transcript costs only as much as the caller consumes. Lines come back as raw
 * bytes (a multi-byte character split by a chunk boundary is rejoined before
 * the line is yielded); empty lines are skipped. Stops after `maxBytes` read.
 */
export function* linesBackward(
  file: string,
  opts: { chunkSize?: number; maxBytes?: number } = {},
): Generator<Buffer> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  const fd = openSync(file, 'r');
  try {
    let end = fstatSync(fd).size;
    const floor = opts.maxBytes !== undefined ? Math.max(0, end - opts.maxBytes) : 0;
    let carry = Buffer.alloc(0);
    while (end > floor) {
      const start = Math.max(floor, end - chunkSize);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const data = Buffer.concat([buf, carry]);
      let lineEnd = data.length;
      for (let nl = data.lastIndexOf(NL, lineEnd - 1); nl !== -1; nl = data.lastIndexOf(NL, lineEnd - 1)) {
        const line = data.subarray(nl + 1, lineEnd);
        if (line.length > 0) yield line;
        lineEnd = nl;
        if (nl === 0) break;
      }
      carry = data.subarray(0, lineEnd);
      end = start;
    }
    // The file's first line (or the line cut off at `maxBytes`, which is then partial).
    if (carry.length > 0 && floor === 0) yield carry;
  } finally {
    closeSync(fd);
  }
}
