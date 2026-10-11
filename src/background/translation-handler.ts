import type { ExtensionSettingsStorage } from './settings.ts';
import { loadSettings } from './settings.ts';
import {
  decodeTranslateRequest,
  encodeTranslateResponse,
  isTranslationWarning,
  type TranslationWarning,
  type TranslateFailureCode,
  type TranslateResponse,
  type TranslationContext,
  type TranslationPurpose
} from './protocol.ts';
import type { ExtensionSettings } from '../shared/settings.ts';

export interface BackgroundFailure {
  code: TranslateFailureCode;
  message: string;
}

export type BackgroundTranslationResult =
  | { ok: true; translations: string[]; warning?: TranslationWarning }
  | { ok: false; translations: string[]; error: BackgroundFailure };

export interface BackgroundTranslationRunner {
  translate(
    texts: string[],
    purpose: TranslationPurpose,
    settings: ExtensionSettings,
    context?: TranslationContext,
    signal?: AbortSignal
  ): Promise<BackgroundTranslationResult>;
  translateGlossaryCovered?(
    texts: string[],
    purpose: TranslationPurpose
  ): Promise<Array<string | undefined>>;
}

export interface BackgroundMessageHandlerOptions {
  storage: ExtensionSettingsStorage;
  runner: BackgroundTranslationRunner;
  timeoutMs?: number;
  hasProviderPermission?: (settings: ExtensionSettings) => Promise<boolean>;
}

export interface RuntimeMessageEvent {
  addListener(
    listener: (message: unknown) => Promise<TranslateResponse | undefined>
  ): void;
}

export const DEFAULT_BACKGROUND_TIMEOUT_MS = 30000;
export const FALLBACK_BACKGROUND_TIMEOUT_MS = 55000;

class OperationTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new OperationTimeoutError('Background translation timed out.')),
        Math.max(1, timeoutMs)
      );
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isBackgroundFailureCode(value: unknown): value is BackgroundFailure['code'] {
  return (
    value === 'disabled' ||
    value === 'settings-failure' ||
    value === 'provider-failure' ||
    value === 'provider-timeout' ||
    value === 'cancelled' ||
    value === 'invalid-response'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBackgroundTranslationResult(
  value: unknown
): value is BackgroundTranslationResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || !isStringArray(value.translations)) {
    return false;
  }
  if (value.ok) {
    return value.warning === undefined || isTranslationWarning(value.warning, value.translations.length);
  }
  return (
    isRecord(value.error) &&
    isBackgroundFailureCode(value.error.code) &&
    typeof value.error.message === 'string'
  );
}

function createFailure(
  request: {
    requestId: string;
    purpose: TranslationPurpose;
    texts: string[];
  },
  code: TranslateFailureCode,
  message: string
): TranslateResponse {
  return encodeTranslateResponse({
    type: 'hltv-zh-translate-response',
    requestId: request.requestId,
    purpose: request.purpose,
    ok: false,
    translations: [...request.texts],
    error: {
      code,
      fallback: 'original',
      message
    }
  });
}

function createSuccess(
  request: {
    requestId: string;
    purpose: TranslationPurpose;
  },
  translations: string[],
  warning?: TranslationWarning
): TranslateResponse {
  return encodeTranslateResponse({
    type: 'hltv-zh-translate-response',
    requestId: request.requestId,
    purpose: request.purpose,
    ok: true,
    translations,
    ...(warning === undefined ? {} : { warning })
  });
}

export function createBackgroundMessageHandler(
  options: BackgroundMessageHandlerOptions
): (message: unknown, signal?: AbortSignal) => Promise<TranslateResponse | undefined> {
  return async (message, signal) => {
    const request = decodeTranslateRequest(message);
    if (request === undefined) {
      return undefined;
    }

    let settings: ExtensionSettings;
    try {
      settings = await loadSettings(options.storage);
    } catch {
      return createFailure(
        request,
        'settings-failure',
        'Settings could not be loaded.'
      );
    }

    if (!settings.enabled && request.purpose !== 'dictionary' && request.purpose !== 'sentence') {
      return createFailure(request, 'disabled', 'Translation is disabled.');
    }

    let glossaryTranslations: Array<string | undefined> | undefined;
    if (request.purpose !== 'dictionary' && options.runner.translateGlossaryCovered !== undefined) {
      try {
        const candidate = await options.runner.translateGlossaryCovered(
          request.texts,
          request.purpose
        );
        if (
          candidate.length === request.texts.length &&
          candidate.every(
            (translation) =>
              translation === undefined || typeof translation === 'string'
          )
        ) {
          glossaryTranslations = candidate;
        }
      } catch {
        glossaryTranslations = undefined;
      }
    }

    const offlineTranslations = glossaryTranslations ?? request.texts.map(() => undefined);
    const untranslatedIndexes = request.texts.flatMap((_, index) =>
      offlineTranslations[index] === undefined ? [index] : []
    );
    const mergedTranslations = request.texts.map(
      (text, index) => offlineTranslations[index] ?? text
    );
    const partialFailure = (code: TranslateFailureCode, message: string): TranslateResponse =>
      untranslatedIndexes.length < request.texts.length
        ? createSuccess(request, mergedTranslations, { code, message, failedIndexes: untranslatedIndexes })
        : createFailure(request, code, message);
    if (untranslatedIndexes.length === 0) {
      return createSuccess(request, mergedTranslations);
    }

    if (options.hasProviderPermission !== undefined) {
      let hasPermission = false;
      try {
        hasPermission = await options.hasProviderPermission(settings);
      } catch {
        hasPermission = false;
      }
      if (!hasPermission) {
        return partialFailure(
          'provider-failure',
          'The configured provider host permission is missing.'
        );
      }
    }

    let result: BackgroundTranslationResult;
    try {
      result = await withTimeout(
        options.runner.translate(
          untranslatedIndexes.map((index) => request.texts[index] as string),
          request.purpose,
          settings,
          request.context ?? 'comment',
          signal
        ),
        options.timeoutMs ?? (settings.fallbackEnabled === true
          ? FALLBACK_BACKGROUND_TIMEOUT_MS : DEFAULT_BACKGROUND_TIMEOUT_MS)
      );
    } catch (error) {
      return partialFailure(
        error instanceof OperationTimeoutError
          ? 'provider-timeout'
          : 'provider-failure',
        error instanceof OperationTimeoutError
          ? 'Background translation timed out.'
          : 'The translation request failed.'
      );
    }

    if (
      !isBackgroundTranslationResult(result) ||
      result.translations.length !== untranslatedIndexes.length
    ) {
      return partialFailure(
        'invalid-response',
        'The background runner returned the wrong number or type of translations.'
      );
    }

    if (!result.ok) {
      return partialFailure(result.error.code, result.error.message);
    }

    for (let index = 0; index < untranslatedIndexes.length; index += 1) {
      const requestIndex = untranslatedIndexes[index] as number;
      mergedTranslations[requestIndex] = result.translations[index] as string;
    }
    return createSuccess(request, mergedTranslations, result.warning === undefined ? undefined : {
      ...result.warning, failedIndexes: result.warning.failedIndexes.map((index) => untranslatedIndexes[index]!)
    });
  };
}

export function installBackgroundMessageHandler(
  event: RuntimeMessageEvent,
  handler: (message: unknown) => Promise<TranslateResponse | undefined>
): void {
  event.addListener((message) => handler(message));
}
