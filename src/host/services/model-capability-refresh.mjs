/** Background refresh of the models.dev capability catalog. The bundled copy
 * in the client bundle is the offline fallback; a successful fetch replaces the
 * cached file, and any failure simply keeps the previous data. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCapabilityCatalog } from '../../model-catalog-data/build.mjs';
import { MODEL_CATALOG as BUNDLED_CATALOG } from '../../model-catalog-data/catalog.mjs';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;

export function createModelCapabilityRefresh({ storeDir, fetchImpl = fetch, url = MODELS_DEV_URL, intervalMs = DAY_MS }) {
  const file = join(storeDir, 'model-catalog.json');
  let timer;
  // `AbortSignal.timeout` would keep a live Timeout handle for the whole
  // timeout window, and the release gate disposes the plugin while the first
  // refresh is still in flight. Track every controller together with its
  // timeout so `stop()` can clear the handles synchronously and abort the
  // request, instead of leaking a timer past dispose.
  const inflight = new Map();
  /** The cached catalog, or the bundled copy when no refresh has landed yet. */
  const read = async () => {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return BUNDLED_CATALOG; }
  };
  const refresh = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    timeout.unref?.();
    inflight.set(controller, timeout);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) return;
      const catalog = buildCapabilityCatalog(await response.json());
      await mkdir(storeDir, { recursive: true });
      await writeFile(file, JSON.stringify(catalog));
    } catch { /* network or parse failure: keep the previous catalog */ }
    finally {
      clearTimeout(timeout);
      inflight.delete(controller);
    }
  };
  return {
    read,
    start() {
      // Refresh in the background without blocking Host startup.
      void refresh();
      timer = setInterval(() => { void refresh(); }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    stop() {
      if (timer) clearInterval(timer);
      for (const [controller, timeout] of inflight) { clearTimeout(timeout); controller.abort(); }
      inflight.clear();
    },
  };
}
