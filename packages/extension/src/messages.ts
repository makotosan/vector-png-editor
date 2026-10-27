import { MAX_SVG_BYTES } from './profile.ts';

// Bounded, schema-checked messages from the webview to the extension host.
// Anything malformed, oversized or unexpected is rejected, never coerced.
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'sourceChanged'; revision: number; source: string };

export type MessageValidation = { ok: true; message: WebviewMessage } | { ok: false; reason: string };

const MAX_MESSAGE_CHARS = MAX_SVG_BYTES + 4096;

export function validateWebviewMessage(value: unknown, serializedSize?: number): MessageValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { ok: false, reason: 'Message must be an object' };
  if (serializedSize !== undefined && serializedSize > MAX_MESSAGE_CHARS)
    return { ok: false, reason: 'Message exceeds the size limit' };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.type === 'ready') {
    if (keys.length !== 1) return { ok: false, reason: 'ready takes no fields' };
    return { ok: true, message: { type: 'ready' } };
  }
  if (record.type === 'sourceChanged') {
    if (keys.join(',') !== 'revision,source,type') return { ok: false, reason: 'sourceChanged fields mismatch' };
    if (!Number.isInteger(record.revision) || (record.revision as number) < 0 || (record.revision as number) > Number.MAX_SAFE_INTEGER)
      return { ok: false, reason: 'revision must be a non-negative integer' };
    if (typeof record.source !== 'string') return { ok: false, reason: 'source must be a string' };
    if (new TextEncoder().encode(record.source).length > MAX_SVG_BYTES)
      return { ok: false, reason: 'source exceeds the SVG size limit' };
    return { ok: true, message: { type: 'sourceChanged', revision: record.revision as number, source: record.source } };
  }
  return { ok: false, reason: `Unknown message type: ${String(record.type)}` };
}
