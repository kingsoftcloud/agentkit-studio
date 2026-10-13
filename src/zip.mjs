/** Minimal stored-entry ZIP writer (no compression, valid archive).
 *
 * The legacy Studio Host bundled agents with Python's zipfile; the plugin
 * Node host only has node builtins, so this writes STORED entries with a
 * correct CRC-32, local headers, and central directory. Bundles are small
 * definition snapshots, so compression is unnecessary.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/** Read bounded regular files from a cloud Skill ZIP, validating paths, sizes and CRCs. */
export function readZipFiles(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 20 * 1024 * 1024) throw new Error('invalid archive size');
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length || end + 22 + buffer.readUInt16LE(end + 20) !== buffer.length) throw new Error('invalid archive directory');
  const count = buffer.readUInt16LE(end + 10), central = buffer.readUInt32LE(end + 16);
  if (count > 2000 || central + buffer.readUInt32LE(end + 12) !== end) throw new Error('invalid archive bounds');
  const files = [], names = new Set();
  let cursor = central, totalBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('invalid archive entry');
    const size = buffer.readUInt32LE(cursor + 24), compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28), offset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    if (next > end || offset + 30 > central || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('invalid archive entry bounds');
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16;
    if (!name || /[\\\0]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '..' || part === '.') || names.has(name) || (mode & 0xf000) === 0xa000) throw new Error('unsafe archive path');
    names.add(name);
    totalBytes += size;
    if (size > 8 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024 || (buffer.readUInt16LE(cursor + 8) & 1)) throw new Error('archive expansion limit or encryption');
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    if (start + compressedSize > central) throw new Error('invalid archive data bounds');
    const compression = buffer.readUInt16LE(cursor + 10), packed = buffer.subarray(start, start + compressedSize);
    const data = compression === 0 ? packed : compression === 8 ? inflateRawSync(packed, { maxOutputLength: 8 * 1024 * 1024 }) : null;
    if (!data || data.length !== size || crc32(data) !== buffer.readUInt32LE(cursor + 16)) throw new Error('archive checksum mismatch');
    if (!name.endsWith('/')) files.push({ name, data, executable: Boolean(mode & 0o111) });
    cursor = next;
  }
  if (cursor !== end) throw new Error('invalid archive entry count');
  return files;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1F);
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
  return { time, day };
}

/** Build a ZIP archive buffer from [{ name, data: Buffer|string }] entries. */
export function createZip(entries, { timestamp = new Date() } = {}) {
  const { time, day } = dosDateTime(timestamp);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    if (nameBuffer.length > 0xFFFF || data.length > 0xFFFFFFFF) throw new Error('zip entry too large');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix permissions preserve executable Skill scripts.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(((0o100000 | (entry.executable ? 0o700 : 0o600)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Stable short build id from canonical manifest content, matching the legacy `build_<digest[:20]>` shape. */
export function buildIdFor(manifest) {
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return `build_${digest.slice(0, 20)}`;
}

/** Read our STORED bundle entries in memory, with bounds and CRC validation. */
export function readZipEntry(buffer, name) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 20 * 1024 * 1024) throw new Error('invalid bundle size');
  const end = buffer.length - 22;
  if (end < 0 || buffer.readUInt32LE(end) !== 0x06054b50) throw new Error('invalid bundle directory');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  if (cursor + buffer.readUInt32LE(end + 12) !== end) throw new Error('invalid bundle directory bounds');
  let result;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('invalid bundle entry');
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    if (next > end) throw new Error('invalid bundle entry bounds');
    if (buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength) === name) {
      if (result || buffer.readUInt16LE(cursor + 10) !== 0 || buffer.readUInt32LE(cursor + 20) !== size) throw new Error('unsupported bundle entry');
      const offset = buffer.readUInt32LE(cursor + 42);
      if (offset + 30 > cursor || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('invalid bundle local header');
      const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
      if (start + size > cursor) throw new Error('invalid bundle content bounds');
      result = buffer.subarray(start, start + size);
      if (crc32(result) !== buffer.readUInt32LE(cursor + 16)) throw new Error('bundle checksum mismatch');
    }
    cursor = next;
  }
  if (cursor !== end || !result) throw new Error('bundle entry missing');
  return result;
}
