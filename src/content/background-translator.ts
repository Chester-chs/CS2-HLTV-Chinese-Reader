import type {
  TranslationContext,
  TranslationPurpose,
  TranslationService
} from '../core/translate/index.ts';
import {
  decodeTranslateResponse,
  encodeTranslateRequest,
  type TranslateRequest,
  type TranslateFailureCode,
  type TranslateCancelRequest,
  type TranslationPurpose as ProtocolTranslationPurpose
} from '../background/protocol.ts';

export interface ContentMessageSender {
  (message: TranslateRequest): Promise<unknown>;
}

export interface BackgroundTranslationServiceOptions {
  sendMessage: ContentMessageSender;
  timeoutMs?: number;
  requestId?: () => string;
  sendCancel?: (message: TranslateCancelRequest) => Promise<unknown>;
  onIncomplete?: (texts: string[], code: TranslateFailureCode) => void;
}

// Covers both 25-second providers and the background's processing margin.
export const DEFAULT_CONTENT_TIMEOUT_MS = 60000;

export interface ContextualTranslationAdapter {
  translateWithContext(
    texts: string[],
    context: TranslationContext,
    purpose: TranslationPurpose
  ): Promise<string[]>;
}

export interface DetailedTranslationResult {
  translations: string[];
  errorCode?: TranslateFailureCode;
  failedIndexes?: number[];
}

export interface DetailedContextualTranslationAdapter {
  translateWithContextDetailed(
    texts: string[],
    context: TranslationContext,
    purpose: TranslationPurpose,
    options?: { signal?: AbortSignal }
  ): Promise<DetailedTranslationResult>;
}

export interface RefreshableTranslationAdapter {
  clearSessionCache(): void;
}

class ContentTranslationTimeoutError extends Error {}
class ContentTranslationCancelledError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ContentTranslationTimeoutError('Content translation timed out.')),
      Math.max(1, timeoutMs)
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function defaultRequestIdFactory(): () => string {
  let nextId = 1;
  const sessionId = crypto.randomUUID();
  return () => `${sessionId}-${nextId++}`;
}

export function createBackgroundTranslationService(
  options: BackgroundTranslationServiceOptions
): TranslationService &
  ContextualTranslationAdapter &
  DetailedContextualTranslationAdapter &
  RefreshableTranslationAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTENT_TIMEOUT_MS;
  const requestId = options.requestId ?? defaultRequestIdFactory();
  const sessionResults = new Map<string, string>();
  let cacheGeneration = 0;

  async function translateBatchDetailed(
    texts: string[],
    purpose: ProtocolTranslationPurpose,
    context: TranslationContext,
    lookupOptions?: { signal?: AbortSignal }
  ): Promise<DetailedTranslationResult> {
    if (texts.length === 0) {
      return { translations: [] };
    }
    if (lookupOptions?.signal?.aborted) return { translations: [...texts], errorCode: 'cancelled' };

    const results = new Array<string>(texts.length);
    const generation = cacheGeneration;
    const missing = new Map<string, number[]>();
    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index] as string;
      const sessionKey = `${purpose}\u0000${context}\u0000${text}`;
      const cached = sessionResults.get(sessionKey);
      if (cached !== undefined) {
        results[index] = cached;
        continue;
      }
      const indexes = missing.get(sessionKey) ?? [];
      indexes.push(index);
      missing.set(sessionKey, indexes);
    }

    if (missing.size === 0) {
      return { translations: results };
    }

    const missingEntries = Array.from(missing.entries());
    const request: TranslateRequest = encodeTranslateRequest({
      type: 'hltv-zh-translate-request',
      requestId: requestId(),
      purpose,
      context,
      ...(lookupOptions?.signal === undefined ? {} : { cancellable: true }),
      texts: missingEntries.map(([, indexes]) => texts[indexes[0] as number] as string)
    });

    let translated: string[] | undefined;
    let cacheable = false;
    let errorCode: TranslateFailureCode | undefined;
    let failedRequestIndexes: number[] = [];
    const signal = lookupOptions?.signal;
    const cancelBackground = (): void => {
      if (request.cancellable) void options.sendCancel?.({ type: 'hltv-zh-translate-cancel', requestId: request.requestId }).catch(() => {});
    };
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => { cancelBackground(); reject(new ContentTranslationCancelledError()); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      const response = await withTimeout(Promise.race([options.sendMessage(request), cancelled]), timeoutMs);
      if (response === undefined) {
        errorCode = 'provider-timeout';
      } else {
        const decoded = decodeTranslateResponse(response);
        if (
          decoded !== undefined &&
          decoded.requestId === request.requestId &&
          decoded.purpose === request.purpose &&
          decoded.translations.length === request.texts.length
        ) {
          if (decoded.ok) {
            translated = decoded.translations;
            cacheable = true;
            if (decoded.warning !== undefined) {
              errorCode = decoded.warning.code;
              failedRequestIndexes = decoded.warning.failedIndexes;
            }
          } else {
            translated = [...request.texts];
            errorCode = decoded.error.code;
          }
        } else {
          errorCode = 'invalid-response';
        }
      }
    } catch (error) {
      errorCode = error instanceof ContentTranslationCancelledError ? 'cancelled' : error instanceof ContentTranslationTimeoutError
        ? 'provider-timeout'
        : 'provider-failure';
      cancelBackground();
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    }

    const resolved = translated ?? request.texts;
    if (!cacheable) failedRequestIndexes = missingEntries.map((_, index) => index);
    if (failedRequestIndexes.length > 0 && purpose !== 'dictionary' && purpose !== 'sentence' && errorCode !== 'cancelled') {
      options.onIncomplete?.(failedRequestIndexes.map((index) => request.texts[index]!), errorCode!);
    }
    for (let index = 0; index < missingEntries.length; index += 1) {
      const [sessionKey, indexes] = missingEntries[index] as [string, number[]];
      const value = resolved[index] as string;
      if (cacheable && generation === cacheGeneration && !failedRequestIndexes.includes(index)) {
        sessionResults.set(sessionKey, value);
      }
      for (const originalIndex of indexes) {
        results[originalIndex] = value;
      }
    }

    return {
      translations: results,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(failedRequestIndexes.length === 0 ? {} : {
        failedIndexes: failedRequestIndexes.flatMap((index) => missingEntries[index]![1])
      })
    };
  }

  async function translateBatch(
    texts: string[],
    purpose: ProtocolTranslationPurpose,
    context: TranslationContext
  ): Promise<string[]> {
    return (await translateBatchDetailed(texts, purpose, context)).translations;
  }

  return {
    translate(texts) {
      return translateBatch(texts, 'plain', 'comment');
    },
    translateEventNames(texts) {
      return translateBatch(texts, 'event-name', 'comment');
    },
    translateWithContext(texts, context, purpose) {
      return translateBatch(texts, purpose, context);
    },
    translateWithContextDetailed(texts, context, purpose, lookupOptions) {
      return translateBatchDetailed(texts, purpose, context, lookupOptions);
    },
    clearSessionCache() {
      cacheGeneration += 1;
      sessionResults.clear();
    }
  };
}
