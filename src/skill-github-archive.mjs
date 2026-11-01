// In-memory codeload ZIP validation. No extraction to caller-selected paths.
import { inflateRawSync } from 'node:zlib';
import { crc32 } from './zip.mjs';
import { skillCandidateExcluded } from './skill-candidate-metadata.mjs';

const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const fail = code => Object.assign(new Error(code), { code });
const check = (value, code = 'skill_github_archive_invalid') => { if (!value) throw fail(code); };
const decodeName = (bytes, flags) => flags & 0x0800 ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  : Array.from(bytes, byte => byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128]).join('');

// PKWARE APPNOTE 4.3.14–16 / 4.5.3. ZIP64 can be used for small files too;
// decode exact integers before applying the existing in-memory archive limits.
function uint64(bytes, offset) {
  check(offset >= 0 && offset + 8 <= bytes.length);
  const value = bytes.readBigUInt64LE(offset);
  check(value <= BigInt(Number.MAX_SAFE_INTEGER), 'skill_github_archive_limit');
  return Number(value);
}
function extendedFields(bytes, start, length, fields) {
  const end = start + length; check(end <= bytes.length);
  let extra, cursor = start;
  while (cursor < end) {
    check(cursor + 4 <= end);
    const tag = bytes.readUInt16LE(cursor), size = bytes.readUInt16LE(cursor + 2);
    check(cursor + 4 + size <= end);
    if (tag === 1) { check(extra === undefined); extra = bytes.subarray(cursor + 4, cursor + 4 + size); }
    cursor += 4 + size;
  }
  let offset = 0;
  return fields.map(([value, width = 8]) => {
    if (value !== (width === 4 ? 0xffff : 0xffffffff)) return value;
    check(extra !== undefined && offset + width <= extra.length);
    const resolved = width === 8 ? uint64(extra, offset) : extra.readUInt32LE(offset);
    offset += width; return resolved;
  });
}
function directoryLocation(bytes, end) {
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  const locator = end - 20;
  if (locator < 0 || bytes.readUInt32LE(locator) !== 0x07064b50) {
    // CPython emits an ordinary EOCD for exactly 65,535 entries; absent a
    // locator, the count is still bounded by the actual central directory.
    check(size !== 0xffffffff && start !== 0xffffffff && start + size === end);
    return { count, start, end };
  }
  check(bytes.readUInt32LE(locator + 4) === 0 && bytes.readUInt32LE(locator + 16) === 1);
  const record = uint64(bytes, locator + 8);
  check(record + 56 <= locator && bytes.readUInt32LE(record) === 0x06064b50);
  const recordSize = uint64(bytes, record + 4);
  check(recordSize >= 44 && record + 12 + recordSize === locator
    && bytes.readUInt32LE(record + 16) === 0 && bytes.readUInt32LE(record + 20) === 0);
  const fullCount = uint64(bytes, record + 32), fullSize = uint64(bytes, record + 40), fullStart = uint64(bytes, record + 48);
  check(uint64(bytes, record + 24) === fullCount && (count === 0xffff || count === fullCount)
    && (size === 0xffffffff || size === fullSize) && (start === 0xffffffff || start === fullStart)
    && fullStart + fullSize === record);
  return { count: fullCount, start: fullStart, end: record };
}

export function readGithubSkillArchive(buffer, { assertCurrent = () => {} } = {}) {
  assertCurrent();
  check(Buffer.isBuffer(buffer) && buffer.length <= 50 * 1024 * 1024, 'skill_github_archive_limit');
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  check(end >= 0 && end + 22 <= buffer.length && end + 22 + buffer.readUInt16LE(end + 20) === buffer.length);
  check(buffer.readUInt16LE(end + 4) === 0 && buffer.readUInt16LE(end + 6) === 0
    && buffer.readUInt16LE(end + 8) === buffer.readUInt16LE(end + 10));
  const directory = directoryLocation(buffer, end), count = directory.count, central = directory.start, centralEnd = directory.end;
  check(central >= 0 && central <= centralEnd && count <= Math.floor((centralEnd - central) / 46));
  let cursor = central, totalBytes = 0, fileCount = 0;
  const entries = [], paths = new Map(), roots = new Set(), ranges = [];
  for (let index = 0; index < count; index++) {
    assertCurrent();
    check(cursor + 46 <= centralEnd && buffer.readUInt32LE(cursor) === 0x02014b50);
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const nameLength = buffer.readUInt16LE(cursor + 28), next = cursor + 46 + nameLength
      + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16;
    check(next <= centralEnd && (flags & ~0x080e) === 0 && (method === 0 || method === 8));
    const [size, compressed, offset, disk] = extendedFields(buffer, cursor + 46 + nameLength, buffer.readUInt16LE(cursor + 30),
      [[buffer.readUInt32LE(cursor + 24)], [buffer.readUInt32LE(cursor + 20)],
        [buffer.readUInt32LE(cursor + 42)], [buffer.readUInt16LE(cursor + 34), 4]]);
    check(disk === 0);
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    let name;
    try { name = decodeName(nameBytes, flags); } catch { throw fail('skill_github_archive_unsafe'); }
    const directory = name.endsWith('/'), path = directory ? name.slice(0, -1) : name, parts = path.split('/');
    check(name && !/[\\\x00-\x1f\x7f]/u.test(name) && !name.startsWith('/')
      && parts.every(part => part && part !== '.' && part !== '..' && !part.includes(':'))
      && !paths.has(path) && (mode & 0xf000) !== 0xa000, 'skill_github_archive_unsafe');
    check(directory || (mode & 0xf000) === 0 || (mode & 0xf000) === 0x8000, 'skill_github_archive_unsafe');
    paths.set(path, directory);
    check(offset + 30 <= central && buffer.readUInt32LE(offset) === 0x04034b50);
    const localNameLength = buffer.readUInt16LE(offset + 26), start = offset + 30 + localNameLength + buffer.readUInt16LE(offset + 28);
    check(start + compressed <= central && buffer.readUInt16LE(offset + 6) === flags && buffer.readUInt16LE(offset + 8) === method
      && nameBytes.equals(buffer.subarray(offset + 30, offset + 30 + localNameLength)));
    const [localSize, localCompressed] = extendedFields(buffer, offset + 30 + localNameLength, buffer.readUInt16LE(offset + 28),
      [[buffer.readUInt32LE(offset + 22)], [buffer.readUInt32LE(offset + 18)]]);
    if (!(flags & 8)) check(buffer.readUInt32LE(offset + 14) === checksum && localCompressed === compressed && localSize === size);
    ranges.push([offset, start + compressed]);
    if (directory) check(size === 0);
    else {
      check(parts.length >= 2, 'skill_github_archive_unsafe'); roots.add(parts[0]);
      fileCount++; totalBytes += size;
      check(fileCount <= 5000 && totalBytes <= 200 * 1024 * 1024, 'skill_github_archive_limit');
      check((compressed > 0 || size === 0) && (compressed === 0 || size / compressed <= 200), 'skill_github_archive_unsafe');
    }
    entries.push({ path, relative: parts.slice(1).join('/'), directory, start, compressed, size, checksum, method });
    cursor = next;
  }
  check(cursor === centralEnd && fileCount > 0); check(roots.size === 1, 'skill_github_archive_unsafe');
  ranges.sort((a, b) => a[0] - b[0]);
  check(ranges.every(([start], index) => index === 0 || start >= ranges[index - 1][1]), 'skill_github_archive_unsafe');
  for (const path of paths.keys()) {
    const parts = path.split('/');
    check(parts.slice(0, -1).every((_, index) => paths.get(parts.slice(0, index + 1).join('/')) !== false), 'skill_github_archive_unsafe');
  }
  // Bounds and all paths (including excluded content) are checked before any
  // decompression. CRCs cover the whole archive, so exclusions cannot hide bad data.
  const files = [];
  for (const entry of entries) {
    assertCurrent(); const packed = buffer.subarray(entry.start, entry.start + entry.compressed);
    let bytes;
    try { bytes = entry.method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) }); }
    catch { throw fail('skill_github_archive_invalid'); }
    check(bytes.length === entry.size && crc32(bytes) === entry.checksum);
    if (!entry.directory && !skillCandidateExcluded(entry.relative)) files.push({ path: entry.relative,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  }
  assertCurrent(); return files;
}
