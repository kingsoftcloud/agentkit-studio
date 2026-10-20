// Media validation and projection for the native model adapter.
//
// The host supplies image observations as message.media blocks. The adapter
// validates their shape and projects them onto each wire without reading files
// or fetching remote URLs: a bare path or file:// URL is rejected, only
// explicit http(s) URLs and supported image data URLs are admitted.
//
// The JS ModelRequest does not carry maxInlineImageBytes, so this module
// validates media shape, not byte size. Size enforcement is the host/kernel
// responsibility (see semantic-gap notes in the final report).

const IMAGE_KINDS = new Set(['png', 'jpeg', 'webp', 'gif']);

class MediaError extends Error {
  constructor(message) { super(message); this.name = 'MediaError'; }
}

// Validate one host media block and return it normalized to the OpenAI
// image_url shape: { type: 'image_url', image_url: { url, detail } }. Throws
// on a local path, file:// URL, unsupported data URL or unknown shape.
export function validateMediaBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new MediaError('media block must be an object');
  }
  if (block.type !== 'image_url') {
    throw new MediaError('unsupported media block type');
  }
  const image = block.image_url;
  if (!image || typeof image !== 'object' || Array.isArray(image)) {
    throw new MediaError('image_url block requires an image_url object');
  }
  const url = String(image.url ?? '');
  if (!url) throw new MediaError('image block requires a url');
  const detail = image.detail == null ? 'auto' : String(image.detail);
  if (!['auto', 'low', 'high'].includes(detail)) {
    throw new MediaError('image detail must be auto, low or high');
  }
  validateImageUrl(url);
  return { type: 'image_url', image_url: { url, detail } };
}

function validateImageUrl(url) {
  if (url.startsWith('data:')) {
    const [prefix, separator, payload] = partition(url, ',');
    const kind = matchDataImage(prefix);
    if (!kind || !separator || !payload) {
      throw new MediaError('image data URL requires a supported image and base64 content');
    }
    // Validate base64 without atob (which may be absent in some runtimes).
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
      throw new MediaError('invalid image base64 content');
    }
    return;
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new MediaError('image URL must be an explicit HTTP URL or image data URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MediaError('image URL must be an explicit HTTP URL or image data URL');
  }
}

function matchDataImage(prefix) {
  for (const kind of IMAGE_KINDS) {
    if (prefix === `data:image/${kind};base64`) return kind;
  }
  return null;
}

function partition(s, sep) {
  const i = s.indexOf(sep);
  if (i === -1) return [s, '', ''];
  return [s.slice(0, i), sep, s.slice(i + sep.length)];
}

// Project validated media blocks onto the OpenAI chat wire (unchanged shape).
export function projectMediaOpenAI(blocks) {
  return blocks.map((b) => ({ type: 'image_url', image_url: { url: b.image_url.url, detail: b.image_url.detail } }));
}

// Project validated media blocks onto the Anthropic messages wire. http(s)
// URLs become {type:'image', source:{type:'url', url}}; data URLs become a
// base64 source with the media type derived from the data URL prefix.
export function projectMediaAnthropic(blocks) {
  return blocks.map((b) => {
    const url = b.image_url.url;
    if (url.startsWith('data:')) {
      const [prefix, , payload] = partition(url, ',');
      const kind = matchDataImage(prefix);
      return { type: 'image', source: { type: 'base64', media_type: `image/${kind}`, data: payload } };
    }
    return { type: 'image', source: { type: 'url', url } };
  });
}

export { MediaError };
