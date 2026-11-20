import { inflateRawSync } from 'node:zlib';

/** The flat files of a zip, as a saved room keeps them: name to bytes. */
export type ZipFiles = Map<string, Buffer>;

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
/** A plain file name: no folders, no way out of the folder it is put in. */
const FLAT_NAME = /^[^/\\:*?"<>|]+$/;

/**
 * Reads the files at the top of a zip, as Udonarium saves a room (data.xml, config.xml and pictures
 * named by their SHA-256). Stored and deflated entries are read; files in folders are left out.
 * Zip64 and encrypted archives are refused. A file over maxFileBytes, or an archive whose files add
 * up to more than maxTotalBytes, is refused rather than read.
 */
export function readZip(bytes: Buffer, maxFileBytes: number, maxTotalBytes: number): ZipFiles {
  const end = findEnd(bytes);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new RangeError('Zip64 archives are not supported.');
  const files: ZipFiles = new Map();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== DIRECTORY_ENTRY)
      throw new RangeError('The zip directory is damaged.');
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const packed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
    at += 46 + nameLength + extraLength + commentLength;
    if (!FLAT_NAME.test(name) || name === '.' || name === '..') continue;
    if (flags & 0x1) throw new RangeError('Encrypted zips are not supported.');
    if (size > maxFileBytes) throw new RangeError(`${name} in the zip is too large.`);
    total += size;
    if (total > maxTotalBytes) throw new RangeError('The zip holds too much.');
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL_ENTRY)
      throw new RangeError('The zip is damaged.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + packed);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data, { maxOutputLength: maxFileBytes }));
    else throw new RangeError(`${name} in the zip uses a compression that is not supported.`);
  }
  return files;
}

function findEnd(bytes: Buffer): number {
  // The end record is at least 22 bytes and may be followed by a comment of up to 64 KB.
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (bytes.readUInt32LE(at) === END_OF_DIRECTORY) return at;
  }
  throw new RangeError('Not a zip file.');
}
