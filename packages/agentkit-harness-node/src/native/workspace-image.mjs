import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const fail = code => { throw Object.assign(Error(code), { code }); };
function imageInfo(data) {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { mime_type: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length >= 10 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString()))
    return { mime_type: 'image/gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { mime_type: 'image/webp', width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from([157, 1, 42])))
      return { mime_type: 'image/webp', width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && data[20] === 0x2f) return { mime_type: 'image/webp',
      width: 1 + ((data[21] | data[22] << 8) & 0x3fff), height: 1 + ((data[22] >> 6 | data[23] << 2 | data[24] << 10) & 0x3fff) };
  }
  if (data[0] === 255 && data[1] === 216) {
    for (let i = 2; i + 4 <= data.length;) {
      if (data[i++] !== 255) return null;
      while (data[i] === 255) i++;
      const marker = data[i++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (i + 2 > data.length) break;
      const length = data.readUInt16BE(i);
      if (length < 2 || i + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7)
        return { mime_type: 'image/jpeg', height: data.readUInt16BE(i + 3), width: data.readUInt16BE(i + 5) };
      i += length;
    }
  }
  return null;
}

/** Read a bounded, stable image observation through the existing workspace authorization. No URL fetching or execution. */
export function readBoundedWorkspaceImage(target, path, checkCurrent) {
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    checkCurrent();
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) fail('workspace_image_not_regular');
    const header = Buffer.alloc(32), headerSize = readSync(fd, header, 0, 32, 0), bytes = header.subarray(0, headerSize);
    const candidate = /\.(png|jpe?g|gif|webp)$/i.test(path)
      || bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes[0] === 255 && bytes[1] === 216
      || ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())
      || bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!candidate) return null;
    if (before.size > BigInt(MAX_IMAGE_BYTES)) fail('workspace_image_too_large');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    checkCurrent();
    const after = fstatSync(fd, { bigint: true }), current = statSync(target, { bigint: true });
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || BigInt(length) !== before.size) fail('workspace_image_changed');
    const data = buffer.subarray(0, length), info = imageInfo(data);
    if (!info || info.width < 1 || info.height < 1) fail('workspace_image_invalid');
    if (info.width * info.height > MAX_PIXELS) fail('workspace_image_dimensions_exceeded');
    const content = { ok: true, path, observation_kind: 'image', ...info, size_bytes: length,
      sha256: createHash('sha256').update(data).digest('hex') };
    return { content, context: { content: JSON.stringify(content), media: [{ type: 'image_url',
      image_url: { url: `data:${info.mime_type};base64,${data.toString('base64')}` } }] } };
  } finally { closeSync(fd); }
}
