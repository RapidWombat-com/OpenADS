/**
 * Workers fetch does not implement `redirect: 'error'`, so adapters request
 * `redirect: 'manual'` and accept only a direct 2xx response with a body. A 3xx
 * (returned unfollowed by Workers) or an opaque redirect (browsers/undici) is a
 * failure, never followed and never parsed.
 */
export const REDIRECT_MODE = 'manual' satisfies RequestRedirect;

export function successful(response: Response): response is Response & { body: ReadableStream<Uint8Array> } {
  return response.type !== 'opaqueredirect' && !response.redirected
    && response.status >= 200 && response.status <= 299 && response.body !== null;
}

/** Release an unwanted response body without surfacing its content. */
export function discard(response: Response): void {
  if (response.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
}

/**
 * Reads a successful response body as JSON, bounded by `maxBytes` (declared and
 * streamed) and cancelled with `signal`. Never surfaces the body in errors.
 */
export async function readJson(
  response: Response & { body: ReadableStream<Uint8Array> }, maxBytes: number, signal?: AbortSignal,
): Promise<unknown> {
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  let complete = false;
  try {
    signal?.throwIfAborted();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      throw new Error('Response limit');
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const chunks: string[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) { complete = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('Response limit');
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(''));
  } catch {
    throw new Error('Invalid response');
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
