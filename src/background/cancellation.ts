import { decodeTranslateRequest, TRANSLATE_CANCEL_TYPE, type TranslateResponse } from './protocol.ts';

export function createCancellableTranslationHandler(
  handler: (message: unknown, signal?: AbortSignal) => Promise<TranslateResponse | undefined>
): (message: unknown, scope: string) => Promise<TranslateResponse | undefined> {
  const active = new Map<string, AbortController>();
  return async (message, scope) => {
    if (typeof message !== 'object' || message === null) return undefined;
    const input = message as Record<string, unknown>;
    if (input.type === TRANSLATE_CANCEL_TYPE && typeof input.requestId === 'string') {
      active.get(JSON.stringify([scope, input.requestId]))?.abort();
      return undefined;
    }
    const request = decodeTranslateRequest(message);
    if (request === undefined) return undefined;
    if (request.cancellable !== true || (request.purpose !== 'dictionary' && request.purpose !== 'sentence')) return handler(message);
    const key = JSON.stringify([scope, request.requestId]);
    if (active.has(key)) return undefined;
    const controller = new AbortController();
    active.set(key, controller);
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<TranslateResponse>((resolve) => {
        onAbort = () => resolve({ type: 'hltv-zh-translate-response', requestId: request.requestId,
          purpose: request.purpose, ok: false, translations: [...request.texts],
          error: { code: 'cancelled', fallback: 'original', message: 'Lookup cancelled.' } });
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([handler(message, controller.signal), cancelled]);
    } finally {
      controller.abort();
      if (onAbort !== undefined) controller.signal.removeEventListener('abort', onAbort);
      if (active.get(key) === controller) active.delete(key);
    }
  };
}
