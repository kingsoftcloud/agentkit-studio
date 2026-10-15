/** JSON at the control boundary; domain DTOs remain owned by domain validators. */
export type JsonValue = null | boolean | number | string | JsonArray | JsonObject;
export interface JsonArray extends Array<JsonValue> {}
export interface JsonObject { [key: string]: JsonValue | undefined }
export type StudioEnvelope =
  | { ok: true; value?: unknown; requestId?: string }
  | { ok: false; error?: { code?: string; message?: string; details?: unknown; status?: number } };
export interface StudioConnection {
  rpc: { call(channel: string, endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> }
}
