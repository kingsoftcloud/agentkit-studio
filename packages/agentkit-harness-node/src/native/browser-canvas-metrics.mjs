/** Host-side pixels, not page canvas APIs, supply diagnostic colour evidence.
 * Python uses Pillow thumbnail/quantize. Node samples at most 64x64 pixels and
 * uses a deterministic weighted median cut with at most 16 RGB buckets.
 * Numeric values may differ; uniformity is diagnostic, never a pass verdict. */
import { PNG } from 'pngjs';
import { invariant } from '@kingsoftcloud/agentkit-harness-core';

// JSON persists -0 as 0. Emit canonical numbers before the first receipt so
// an in-memory result and its cold-restored durable receipt stay identical.
const round = n => Math.round(n * 10000) / 10000 || 0;
export function browserImageVariation(bytes) {
  invariant(Buffer.isBuffer(bytes) && bytes.length >= 24 && bytes.length <= 16 * 1024 * 1024
    && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) <= 16 * 1024 * 1024, 'browser_canvas_image_limit');
  const image = PNG.sync.read(bytes), histogram = new Map();
  const width = Math.min(64, image.width), height = Math.min(64, image.height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (Math.floor((y + .5) * image.height / height) * image.width + Math.floor((x + .5) * image.width / width)) * 4;
    const color = [...image.data.subarray(offset, offset + 3)], key = color.join(',');
    const previous = histogram.get(key); if (previous) previous.count++; else histogram.set(key, { color, count: 1 });
  }
  const ranges = values => [0, 1, 2].map(channel => Math.max(...values.map(v => v.color[channel])) - Math.min(...values.map(v => v.color[channel])));
  const buckets = [[...histogram.values()]];
  while (buckets.length < 16) {
    let selected = -1, range = 0, channel = 0;
    buckets.forEach((values, i) => ranges(values).forEach((value, c) => { if (value > range) { selected = i; range = value; channel = c; } }));
    if (selected === -1) break;
    const values = buckets[selected].sort((a, b) => a.color[channel] - b.color[channel]);
    const half = values.reduce((sum, value) => sum + value.count, 0) / 2;
    let count = 0, index = 0;
    do { count += values[index++].count; } while (count < half && index < values.length - 1);
    buckets.splice(selected, 1, values.slice(0, index), values.slice(index));
  }
  const counts = buckets.map(values => values.reduce((sum, value) => sum + value.count, 0)), total = width * height;
  const dominant = Math.max(...counts) / total;
  return { colour_buckets: counts.length, dominant_ratio: round(dominant),
    entropy_bits: round(-counts.reduce((sum, count) => { const p = count / total; return sum + p * Math.log2(p); }, 0)),
    visually_uniform: counts.length <= 2 || dominant >= .995 };
}

export async function browserCanvasMetrics(page, step) {
  const result = [], canvases = page.locator('canvas'), count = Math.min(await step(() => canvases.count()), 3);
  for (let index = 0; index < count; index++) {
    const canvas = canvases.nth(index), box = await step(() => canvas.boundingBox());
    if (!box || box.width < 8 || box.height < 8) continue;
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    let handle, hidden;
    try {
      handle = await step(() => canvas.elementHandle());
      // The handle owns the exact nodes/styles. No page-controlled dataset or
      // selector is used to recover the original visibility after capture.
      hidden = await step(() => page.evaluateHandle(element => {
        const saved = [];
        for (const node of document.body.querySelectorAll('*')) {
          if (node === element || node.contains(element)) continue;
          saved.push([node, node.style.getPropertyValue('visibility'), node.style.getPropertyPriority('visibility')]);
          node.style.setProperty('visibility', 'hidden', 'important');
        }
        return saved;
      }, handle));
      const bytes = await step(() => canvas.screenshot({ timeout: 5000 }));
      result.push({ index, width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10,
        viewport_coverage: round(box.width * box.height / (viewport.width * viewport.height)), ...browserImageVariation(bytes) });
    } catch (error) {
      result.push({ index, error: String(error.code ?? error.name ?? 'canvas_capture_failed').slice(0, 500) });
    } finally {
      try { if (hidden) await step(() => hidden.evaluate(saved => { for (const [node, value, priority] of saved) node.style.setProperty('visibility', value, priority); })); }
      finally { await hidden?.dispose().catch(() => {}); await handle?.dispose().catch(() => {}); }
    }
  }
  return result;
}
