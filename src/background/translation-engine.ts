import {
  createTranslationService,
  translateGlossaryCoveredText,
  type CacheStore,
  type GlossaryDocument,
  type ProviderError,
  type ProviderResult,
  type TranslationProvider,
  type TranslationContext,
  type TranslationPurpose
} from '../core/translate/index.ts';
import type { ExtensionSettings } from '../shared/settings.ts';
import type {
  BackgroundFailure,
  BackgroundTranslationResult
} from './translation-handler.ts';

export interface BackgroundProviderFactory {
  (settings: ExtensionSettings, signal?: AbortSignal): TranslationProvider;
}

export interface CoreTranslationRunnerOptions {
  glossary: GlossaryDocument | Promise<GlossaryDocument>;
  cacheStore: CacheStore;
  providerFactory: BackgroundProviderFactory;
}

function mapProviderError(error: ProviderError): BackgroundFailure {
  const message =
    error.code === 'timeout'
      ? 'Provider request timed out.'
      : error.code === 'invalid-response'
        ? 'Provider returned an invalid response.'
        : error.code === 'transport-error'
          ? 'Network request failed.'
          : error.message === 'Provider rejected response_format.'
            ? 'Provider rejected response_format.'
            : error.status !== undefined
              ? `Provider returned HTTP ${error.status}.`
              : 'Provider request failed.';
  return {
    code:
      error.code === 'timeout'
        ? 'provider-timeout'
        : error.code === 'invalid-response'
          ? 'invalid-response'
          : 'provider-failure',
    message
  };
}

function invalidResult(): BackgroundFailure {
  return {
    code: 'invalid-response',
    message: 'The translation service returned an invalid result.'
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function providerCacheNamespace(settings: ExtensionSettings): string {
  // Older entries mixed both styles, so neither style may reuse that namespace.
  return JSON.stringify([
    'style-v1',
    settings.providerPreset,
    settings.baseURL,
    settings.model,
    settings.useJsonOutputMode,
    settings.translationStyle
  ]);
}

export function createCoreBackgroundTranslationRunner(
  options: CoreTranslationRunnerOptions
): {
  translate(
    texts: string[],
    purpose: TranslationPurpose,
    settings: ExtensionSettings,
    context?: TranslationContext,
    signal?: AbortSignal
  ): Promise<BackgroundTranslationResult>;
  translateGlossaryCovered(
    texts: string[],
    purpose: TranslationPurpose
  ): Promise<Array<string | undefined>>;
} {
  const inFlight = new Map<string, Promise<BackgroundTranslationResult>>();

  return {
    async translateGlossaryCovered(texts, purpose) {
      const glossary = await options.glossary;
      return texts.map((text) =>
        translateGlossaryCoveredText(text, glossary, purpose)
      );
    },
    async translate(texts, purpose, settings, context = 'comment', signal) {
      const cacheNamespace = providerCacheNamespace(settings);
      const requestKey = JSON.stringify([cacheNamespace, context, purpose, texts]);
      const existing = signal === undefined ? inFlight.get(requestKey) : undefined;
      if (existing !== undefined) {
        return existing;
      }

      const operation = (async (): Promise<BackgroundTranslationResult> => {
      const observedFailures: ProviderError[] = [];
      const failedTexts = new Set<string>();
      const provider = options.providerFactory(settings, signal);
      const hasFallback = settings.fallbackEnabled === true &&
        settings.fallbackBaseURL !== undefined &&
        settings.fallbackBaseURL.trim().length > 0 &&
        settings.fallbackModel !== undefined &&
        settings.fallbackModel.trim().length > 0 &&
        settings.fallbackApiKey !== undefined &&
        settings.fallbackApiKey.trim().length > 0;
      const observingProvider: TranslationProvider = {
        async translate(request): Promise<ProviderResult> {
          if (signal?.aborted) return { ok: false, error: { code: 'transport-error', message: 'Cancelled.' } };
          let primary: ProviderResult;
          try {
            primary = await provider.translate(request);
          } catch {
            primary = { ok: false, error: { code: 'transport-error', message: 'The provider operation failed.' } };
          }
          if (primary.ok) return primary;
          if (hasFallback && !signal?.aborted) {
            try {
              // Construct only after primary failure. Legacy invalid fallback
              // settings must not prevent a healthy primary or a cache hit.
              const fallbackProvider = options.providerFactory({
                ...settings,
                providerPreset: 'custom',
                baseURL: settings.fallbackBaseURL!,
                model: settings.fallbackModel!,
                apiKey: settings.fallbackApiKey!,
                fallbackEnabled: false
              }, signal);
              const fallback = await fallbackProvider.translate(request);
              if (!fallback.ok) {
                observedFailures.push(fallback.error);
                request.texts.forEach((text) => failedTexts.add(text));
              }
              return fallback;
            } catch {
              // Keep the primary failure if fallback setup or transport fails.
            }
          }
          observedFailures.push(primary.error);
          request.texts.forEach((text) => failedTexts.add(text));
          return primary;
        }
      };

      const service = createTranslationService({
        glossary: await options.glossary,
        provider: observingProvider,
        cacheStore: options.cacheStore,
        context,
        cacheNamespace
      });

      let translations: string[];
      try {
        translations =
          purpose === 'event-name'
            ? await service.translateEventNames(texts)
            : purpose === 'dictionary' && service.translateDictionary !== undefined
              ? await service.translateDictionary(texts)
            : await service.translate(texts);
      } catch {
        return {
          ok: false,
          translations: [...texts],
          error: {
            code: 'provider-failure',
            message: 'The translation service failed.'
          }
        };
      }

      if (!isStringArray(translations) || translations.length !== texts.length) {
        return {
          ok: false,
          translations: [...texts],
          error: invalidResult()
        };
      }

      const providerFailure = observedFailures[0];
      if (signal?.aborted) return { ok: false, translations: [...texts], error: { code: 'cancelled', message: 'Lookup cancelled.' } };
      if (providerFailure !== undefined) {
        const failedIndexes = texts.flatMap((text, index) => failedTexts.has(text) ? [index] : []);
        if (failedIndexes.length < texts.length) {
          return { ok: true, translations, warning: { ...mapProviderError(providerFailure), failedIndexes } };
        }
        return {
          ok: false,
          translations: [...texts],
          error: mapProviderError(providerFailure)
        };
      }

      return { ok: true, translations };
      })();
      if (signal === undefined) inFlight.set(requestKey, operation);
      try {
        return await operation;
      } finally {
        if (signal === undefined && inFlight.get(requestKey) === operation) {
          inFlight.delete(requestKey);
        }
      }
    }
  };
}
