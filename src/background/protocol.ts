import type { TranslationContext, TranslationPurpose } from '../core/translate/index.ts';

export type { TranslationContext, TranslationPurpose };

export const TRANSLATE_REQUEST_TYPE = 'hltv-zh-translate-request' as const;
export const TRANSLATE_RESPONSE_TYPE = 'hltv-zh-translate-response' as const;
export const TRANSLATE_CANCEL_TYPE = 'hltv-zh-translate-cancel' as const;
export interface TranslateCancelRequest { type: typeof TRANSLATE_CANCEL_TYPE; requestId: string }

export type TranslateFailureCode =
  | 'disabled'
  | 'settings-failure'
  | 'provider-failure'
  | 'provider-timeout'
  | 'cancelled'
  | 'invalid-response';

export interface TranslationWarning {
  code: TranslateFailureCode;
  message: string;
  failedIndexes: number[];
}

export function isTranslationWarning(value: unknown, length: number): value is TranslationWarning {
  return isRecord(value) && isFailureCode(value.code) && typeof value.message === 'string' &&
    Array.isArray(value.failedIndexes) && value.failedIndexes.length > 0 &&
    value.failedIndexes.every((index) => Number.isInteger(index) && index >= 0 && index < length) &&
    new Set(value.failedIndexes).size === value.failedIndexes.length;
}

export interface TranslateRequest {
  type: typeof TRANSLATE_REQUEST_TYPE;
  requestId: string;
  purpose: TranslationPurpose;
  context?: TranslationContext;
  texts: string[];
  cancellable?: boolean;
}

export interface TranslateSuccessResponse {
  type: typeof TRANSLATE_RESPONSE_TYPE;
  requestId: string;
  purpose: TranslationPurpose;
  ok: true;
  translations: string[];
  warning?: TranslationWarning;
}

export interface TranslateFailureResponse {
  type: typeof TRANSLATE_RESPONSE_TYPE;
  requestId: string;
  purpose: TranslationPurpose;
  ok: false;
  translations: string[];
  error: {
    code: TranslateFailureCode;
    fallback: 'original';
    message: string;
  };
}

export type TranslateResponse =
  | TranslateSuccessResponse
  | TranslateFailureResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPurpose(value: unknown): value is TranslationPurpose {
  return value === 'plain' || value === 'event-name' || value === 'dictionary' || value === 'sentence';
}

function isTranslationContext(value: unknown): value is TranslationContext {
  return value === 'structured' || value === 'prose' || value === 'comment';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFailureCode(value: unknown): value is TranslateFailureCode {
  return (
    value === 'disabled' ||
    value === 'settings-failure' ||
    value === 'provider-failure' ||
    value === 'provider-timeout' ||
    value === 'cancelled' ||
    value === 'invalid-response'
  );
}

export function encodeTranslateRequest(
  request: TranslateRequest
): TranslateRequest {
  return {
    type: TRANSLATE_REQUEST_TYPE,
    requestId: request.requestId,
    purpose: request.purpose,
    ...(request.context === undefined ? {} : { context: request.context }),
    texts: [...request.texts],
    ...(request.cancellable === true ? { cancellable: true } : {})
  };
}

export function decodeTranslateRequest(
  value: unknown
): TranslateRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    value.type !== TRANSLATE_REQUEST_TYPE ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    !isPurpose(value.purpose) ||
    (value.cancellable !== undefined && typeof value.cancellable !== 'boolean') ||
    (value.context !== undefined && !isTranslationContext(value.context)) ||
    !isStringArray(value.texts)
  ) {
    return undefined;
  }

  return {
    type: TRANSLATE_REQUEST_TYPE,
    requestId: value.requestId,
    purpose: value.purpose,
    ...(value.context === undefined
      ? {}
      : { context: value.context as TranslationContext }),
    texts: [...value.texts],
    ...(value.cancellable === true ? { cancellable: true } : {})
  };
}

export function encodeTranslateResponse(
  response: TranslateResponse
): TranslateResponse {
  if (response.ok) {
    return {
      type: TRANSLATE_RESPONSE_TYPE,
      requestId: response.requestId,
      purpose: response.purpose,
      ok: true,
      translations: [...response.translations],
      ...(response.warning === undefined ? {} : { warning: { ...response.warning, failedIndexes: [...response.warning.failedIndexes] } })
    };
  }

  return {
    type: TRANSLATE_RESPONSE_TYPE,
    requestId: response.requestId,
    purpose: response.purpose,
    ok: false,
    translations: [...response.translations],
    error: {
      code: response.error.code,
      fallback: 'original',
      message: response.error.message
    }
  };
}

export function decodeTranslateResponse(
  value: unknown
): TranslateResponse | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    value.type !== TRANSLATE_RESPONSE_TYPE ||
    typeof value.requestId !== 'string' ||
    !isPurpose(value.purpose) ||
    !isStringArray(value.translations)
  ) {
    return undefined;
  }

  if (value.ok === true) {
    if (value.warning !== undefined && !isTranslationWarning(value.warning, value.translations.length)) return undefined;
    return {
      type: TRANSLATE_RESPONSE_TYPE,
      requestId: value.requestId,
      purpose: value.purpose,
      ok: true,
      translations: [...value.translations],
      ...(value.warning === undefined ? {} : { warning: value.warning as TranslationWarning })
    };
  }

  if (value.ok !== false || !isRecord(value.error)) {
    return undefined;
  }

  if (
    value.error.fallback !== 'original' ||
    !isFailureCode(value.error.code) ||
    typeof value.error.message !== 'string'
  ) {
    return undefined;
  }

  return {
    type: TRANSLATE_RESPONSE_TYPE,
    requestId: value.requestId,
    purpose: value.purpose,
    ok: false,
    translations: [...value.translations],
    error: {
      code: value.error.code,
      fallback: 'original',
      message: value.error.message
    }
  };
}
