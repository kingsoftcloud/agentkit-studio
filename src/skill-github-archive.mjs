// In-memory codeload ZIP validation. No extraction to caller-selected paths.
import { inflateRawSync } from 'node:zlib';
import { crc32 } from './zip.mjs';
import { skillCandidateExcluded } from './skill-candidate-metadata.mjs';

const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const fail = code => Object.assign(new Error(code), { code });
const check = (value, code = 'skill_github_archive_invalid') => { if (!value) throw fail(code); };
const decodeName = (bytes, flags) => flags & 0x0800 ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  : Array.from(bytes, byte => byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128]).join('');

export function readGithubSkillArchive(buffer, { assertCurrent = () => {} } = {}) {
  assertCurrent();
  check(Buffer.isBuffer(buffer) && buffer.length <= 50 * 1024 * 1024, 'skill_github_archive_limit');
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  check(end >= 0 && end + 22 <= buffer.length && end + 22 + buffer.readUInt16LE(end + 20) === buffer.length);
  check(buffer.readUInt16LE(end + 4) === 0 && buffer.readUInt16LE(end + 6) === 0
    && buffer.readUInt16LE(end + 8) === buffer.readUInt16LE(end + 10));
  const count = buffer.readUInt16LE(end + 10), central = buffer.readUInt32LE(end + 16);
  check(central + buffer.readUInt32LE(end + 12) === end);
  let cursor = central, totalBytes = 0, fileCount = 0;
  const entries = [], paths = new Map(), roots = new Set(), ranges = [];
  for (let index = 0; index < count; index++) {
    assertCurrent();
    check(cursor + 46 <= end && buffer.readUInt32LE(cursor) === 0x02014b50);
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16), compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), next = cursor + 46 + nameLength
      + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16, offset = buffer.readUInt32LE(cursor + 42);
    check(next <= end && buffer.readUInt16LE(cursor + 34) === 0 && (flags & ~0x080e) === 0 && (method === 0 || method === 8));
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
    if (!(flags & 8)) check(buffer.readUInt32LE(offset + 14) === checksum
      && buffer.readUInt32LE(offset + 18) === compressed && buffer.readUInt32LE(offset + 22) === size);
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
  check(cursor === end && fileCount > 0); check(roots.size === 1, 'skill_github_archive_unsafe');
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
