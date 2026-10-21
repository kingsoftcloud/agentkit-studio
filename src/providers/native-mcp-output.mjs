import { canonical, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

/** Project a known MCP receipt without fetching resource URIs or exposing binary data as text. */
export function nativeMcpOutcome(result) {
  invariant(result && typeof result === 'object' && !Array.isArray(result) && Array.isArray(result.content)
    && (result.isError === undefined || typeof result.isError === 'boolean'), 'studio_native_mcp_result_invalid');
  canonical(result);
  const content = structuredClone(result), structured = result.structuredContent, blocks = result.content;
  const textOnly = blocks.length > 0 && blocks.every(block => block?.type === 'text' && typeof block.text === 'string');
  const empty = structured == null || Array.isArray(structured) && !structured.length
    || structured && typeof structured === 'object' && !Array.isArray(structured) && !Object.keys(structured).length;
  const mirror = textOnly && blocks.length === 1 && canonical(structured ?? null) === canonical({ result: blocks[0].text });
  if (textOnly && (empty || mirror)) return { status: result.isError ? 'error' : 'ok', content,
    context: { content: blocks.map(block => block.text).join('\n\n') } };

  const binary = new Set(), text = [], media = [], omissions = [];
  for (const [index, block] of blocks.entries()) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      omissions.push({ block: index, code: 'mcp_content_invalid' }); continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') { text.push(block.text); continue; }
    const resource = block.type === 'resource' && block.resource && typeof block.resource === 'object' ? block.resource : null;
    const data = resource ? resource.blob : block.data, mime = resource ? resource.mimeType : block.mimeType;
    if (typeof data === 'string' && data) binary.add(data);
    if (resource && typeof resource.text === 'string') { text.push(resource.text); continue; }
    const image = (block.type === 'image' || resource) && validImage(data, mime);
    if (image) {
      text.push(`MCP image block ${index} (when available to this profile).`);
      media.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
    } else omissions.push({ block: index, code: 'mcp_media_unobserved', ...(block.type ? { type: block.type } : {}) });
  }
  const withoutMedia = value => {
    if (typeof value === 'string') return binary.has(value) ? '[MCP binary data omitted from text]' : value;
    if (Array.isArray(value)) return value.map(withoutMedia);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutMedia(item)]));
    return value;
  };
  const observation = { kind: 'mcp_tool_result', metadata: withoutMedia(Object.fromEntries(Object.entries(result)
    .filter(([key]) => !['content', 'structuredContent', '_meta'].includes(key)))) };
  if (Object.hasOwn(result, 'structuredContent')) observation.structuredContent = withoutMedia(structured);
  if (omissions.length) {
    observation.unobserved_blocks = omissions;
    observation.instruction = 'Some MCP media could not be observed. Do not claim to have inspected it or repeat the operation solely for missing media; use a supported read-only observation.';
  }
  text.push(canonical(observation));
  return { status: result.isError ? 'error' : 'ok', content,
    context: { content: text.join('\n\n'), ...(media.length ? { media } : {}) } };
}

function validImage(data, mime) {
  // The pinned Python projection caps an encoded inline image at 64 MiB.
  if (typeof data !== 'string' || !data || data.length > 64 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) return false;
  return mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    || mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())
    || mime === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
}
