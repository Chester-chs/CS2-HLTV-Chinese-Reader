interface StrictAssert {
  equal(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  match(actual: string, expected: RegExp, message?: string): void;
}

const nodeAssertModuleName = 'node:assert/strict';
const { strict: assert } = (await import(nodeAssertModuleName)) as {
  strict: StrictAssert;
};

const nodeTestModuleName = 'node:test';
const { test } = (await import(nodeTestModuleName)) as {
  test(name: string, callback: () => void | Promise<void>): void;
};

import {
  decodeTranslateRequest,
  decodeTranslateResponse,
  encodeTranslateRequest,
  encodeTranslateResponse,
  type TranslateFailureResponse,
  type TranslateRequest,
  type TranslateResponse
} from '../src/background/protocol.ts';
import {
  createBackgroundMessageHandler,
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  type BackgroundTranslationRunner
} from '../src/background/translation-handler.ts';
import {
  createFakeProvider,
  type FakeProviderMode
} from '../src/background/fake-provider.ts';
import { createCoreBackgroundTranslationRunner } from '../src/background/translation-engine.ts';
import { loadPackagedGlossary } from '../src/background/glossary-loader.ts';
import {
  createCacheStoreFromBackend,
  type CacheBackend
} from '../src/background/cache-store.ts';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type ExtensionSettingsStorage
} from '../src/background/settings.ts';
import {
  loadContentSettings,
  type ContentSettingsStorage
} from '../src/content/settings.ts';
import { createBackgroundTranslationService, DEFAULT_CONTENT_TIMEOUT_MS } from '../src/content/background-translator.ts';
import { applyContentSettingsChanges } from '../src/content/settings-sync.ts';
import { DEFAULT_SETTINGS as SHARED_DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import { parseProviderBaseURL } from '../src/shared/provider-url.ts';
import {
  authorizeProviderOrigin,
  getProviderPermissionStatus,
  saveOptionsSettings
} from '../src/options/settings-service.ts';
import { testProviderConnection } from '../src/options/connection-test.ts';
import { createBackgroundProviderFactory } from '../src/background/provider.ts';
import { createProviderPermissionMonitor } from '../src/background/provider-permissions.ts';
import {
  hashText,
  type TranslationProvider
} from '../src/core/translate/index.ts';

function successfulResponse(
  request: TranslateRequest,
  translations: string[] = request.texts.map((text) => `【译】${text}`)
): TranslateResponse {
  return encodeTranslateResponse({
    type: 'hltv-zh-translate-response',
    requestId: request.requestId,
    purpose: request.purpose,
    ok: true,
    translations
  });
}

function createStorage(values: Record<string, unknown>): ExtensionSettingsStorage & ContentSettingsStorage {
  return {
    async get() {
      return { ...values };
    },
    async set(nextValues) {
      Object.assign(values, nextValues);
    }
  };
}

test('translation message protocol round-trips batches and failure fallback', () => {
  const request: TranslateRequest = {
    type: 'hltv-zh-translate-request',
    requestId: 'request-1',
    purpose: 'event-name',
    context: 'structured',
    texts: ['A long event title']
  };
  const decodedRequest = decodeTranslateRequest(encodeTranslateRequest(request));
  assert.deepEqual(decodedRequest, request);

  const failure: TranslateFailureResponse = {
    type: 'hltv-zh-translate-response',
    requestId: request.requestId,
    purpose: request.purpose,
    ok: false,
    translations: request.texts,
    error: {
      code: 'provider-failure',
      fallback: 'original',
      message: 'fake failure'
    }
  };
  const decodedFailure = decodeTranslateResponse(encodeTranslateResponse(failure));
  assert.deepEqual(decodedFailure, failure);
  assert.equal(decodeTranslateRequest({ type: 'unknown' }), undefined);
});

test('background handler forwards classification context and defaults missing context to comment', async () => {
  const receivedContexts: Array<string | undefined> = [];
  const handler = createBackgroundMessageHandler({
    storage: createStorage({ ...DEFAULT_SETTINGS }),
    runner: {
      async translate(texts, _purpose, _settings, context) {
        receivedContexts.push(context);
        return { ok: true, translations: [...texts] };
      }
    }
  });

  await handler({
    type: 'hltv-zh-translate-request',
    requestId: 'structured-context',
    purpose: 'plain',
    context: 'structured',
    texts: ['Grand Final']
  });
  await handler({
    type: 'hltv-zh-translate-request',
    requestId: 'default-context',
    purpose: 'plain',
    texts: ['Thank you']
  });

  assert.deepEqual(receivedContexts, ['structured', 'comment']);
});

test('background glossary loader consumes injected packaged text at runtime', async () => {
  let requestedUrl = '';
  const glossary = await loadPackagedGlossary(
    'extension://test/glossary.json',
    async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            version: 1,
            entries: [
              {
                term: 'Fall',
                target: '秋季',
                keep_as_is: false,
                category: 'season'
              }
            ]
          });
        }
      };
    }
  );

  assert.equal(requestedUrl, 'extension://test/glossary.json');
  assert.deepEqual(glossary.entries[0]?.target, '秋季');
});

test('translation defaults allow page requests more time than the old five-second cutoff', async () => {
  assert.equal(DEFAULT_BACKGROUND_TIMEOUT_MS, 30000);
  assert.equal(DEFAULT_CONTENT_TIMEOUT_MS, 60000);
  let providerTimeout = 0;
  const factory = createBackgroundProviderFactory({
    transport: {
      async send(request) {
        providerTimeout = request.timeoutMs;
        return { status: 200, json: async () => ({ choices: [{ message: { content: '{"translations":["测试译文"]}' } }] }) };
      }
    }
  });
  const result = await factory(DEFAULT_SETTINGS).translate({
    texts: ['A long English sentence'], protectedFragments: [[]], purposes: ['plain']
  });
  assert.equal(result.ok, true);
  assert.equal(providerTimeout, 25000);
});

test('content translator does not send a second message for a same-session hit', async () => {
  let messageCount = 0;
  const translator = createBackgroundTranslationService({
    timeoutMs: 20,
    sendMessage: async (message) => {
      messageCount += 1;
      return successfulResponse(message);
    }
  });

  const first = await translator.translate(['A long English sentence']);
  const second = await translator.translate(['A long English sentence']);

  assert.deepEqual(first, ['【译】A long English sentence']);
  assert.deepEqual(second, first);
  assert.equal(messageCount, 1);
});

test('content translator returns provider failures as originals and retries them later', async () => {
  let requests = 0;
  const translator = createBackgroundTranslationService({
    timeoutMs: 20,
    sendMessage: async (message) => {
      requests += 1;
      return encodeTranslateResponse(requests === 1 ? {
        type: 'hltv-zh-translate-response',
        requestId: message.requestId,
        purpose: message.purpose,
        ok: false,
        translations: message.texts,
        error: {
          code: 'provider-failure',
          fallback: 'original',
          message: 'fake provider failed'
        }
      } : successfulResponse(message));
    }
  });

  assert.deepEqual(await translator.translate(['A long English sentence']), [
    'A long English sentence'
  ]);
  assert.deepEqual(await translator.translate(['A long English sentence']), [
    '【译】A long English sentence'
  ]);
  assert.equal(requests, 2);
});

test('content translator falls back when background does not respond before timeout', async () => {
  const translator = createBackgroundTranslationService({
    timeoutMs: 5,
    sendMessage: () => new Promise<unknown>(() => {})
  });

  assert.deepEqual(await translator.translate(['A long English sentence']), [
    'A long English sentence'
  ]);
});

test('background handler returns original text for provider failure', async () => {
  const runner: BackgroundTranslationRunner = {
    async translate(texts) {
      return {
        ok: false,
        translations: [...texts],
        error: {
          code: 'provider-failure',
          message: 'fake provider failed'
        }
      };
    }
  };
  const handler = createBackgroundMessageHandler({
    storage: createStorage({ enabled: true, mode: 'A' }),
    runner,
    timeoutMs: 5
  });
  const request: TranslateRequest = {
    type: 'hltv-zh-translate-request',
    requestId: 'request-provider-failure',
    purpose: 'plain',
    texts: ['A long English sentence']
  };

  const response = decodeTranslateResponse(await handler(request));
  assert.equal(response?.ok, false);
  assert.deepEqual(response?.translations, request.texts);
});

test('dictionary and sentence selection remain available when page translation is disabled', async () => {
  const requests: TranslateRequest[] = [];
  const handler = createBackgroundMessageHandler({
    storage: createStorage({ enabled: false, mode: 'A' }),
    runner: {
      async translate(texts, purpose) {
        requests.push({
          type: 'hltv-zh-translate-request',
          requestId: purpose,
          purpose,
          texts
        });
        return { ok: true, translations: texts.map(() => '中文结果') };
      }
    },
    hasProviderPermission: async () => true
  });

  for (const purpose of ['dictionary', 'sentence'] as const) {
    const response = decodeTranslateResponse(await handler({
      type: 'hltv-zh-translate-request',
      requestId: purpose,
      purpose,
      context: purpose === 'dictionary' ? 'structured' : 'prose',
      texts: [purpose]
    }));
    assert.deepEqual(response?.ok, true);
  }
  assert.deepEqual(requests.map((request) => request.purpose), ['dictionary', 'sentence']);
});

test('background handler turns a sleeping runner into an explicit timeout fallback', async () => {
  const runner: BackgroundTranslationRunner = {
    translate: () => new Promise<never>(() => {})
  };
  const handler = createBackgroundMessageHandler({
    storage: createStorage({ enabled: true, mode: 'A' }),
    runner,
    timeoutMs: 5
  });
  const request: TranslateRequest = {
    type: 'hltv-zh-translate-request',
    requestId: 'request-timeout',
    purpose: 'plain',
    texts: ['A long English sentence']
  };

  const response = decodeTranslateResponse(await handler(request));
  assert.equal(response?.ok, false);
  if (response?.ok === false) {
    assert.equal(response.error.code, 'provider-timeout');
    assert.deepEqual(response.translations, request.texts);
  }
});

test('background handler converts a malformed runner result into an invalid-response fallback', async () => {
  const handler = createBackgroundMessageHandler({
    storage: createStorage({ enabled: true, mode: 'A' }),
    runner: {
      translate: async () => ({ bad: true } as never)
    }
  });
  const request: TranslateRequest = {
    type: 'hltv-zh-translate-request',
    requestId: 'request-malformed-runner',
    purpose: 'plain',
    texts: ['A long English sentence']
  };

  const response = decodeTranslateResponse(await handler(request));
  assert.equal(response?.ok, false);
  if (response?.ok === false) {
    assert.equal(response.error.code, 'invalid-response');
    assert.deepEqual(response.translations, request.texts);
  }
});

test('settings loader uses shared defaults and content reads only non-secret settings', async () => {
  const values = {
    enabled: false,
    mode: 'B',
    baseURL: 'https://example.invalid',
    model: 'fake-model',
    apiKey: ''
  };
  const storage = createStorage(values);
  const full = await loadSettings(storage);
  let requestedKeys: readonly string[] | undefined;
  const content = await loadContentSettings({
    async get(keys) {
      requestedKeys = keys;
      return { enabled: values.enabled, mode: values.mode, nativeLanguage: 'en', interfaceLanguageSelected: false, audienceMode: 'learner', uiLanguage: keys.includes('uiLanguage') ? 'en' : 'zh-CN', theme: 'system', cardColor: 'rose', fontScale: 1, showOriginal: true, showPinyin: true, showDifficulty: false, showExamples: false };
    }
  });

  assert.deepEqual(full, {
    ...values,
    providerPreset: 'custom',
    useJsonOutputMode: true,
    translationStyle: 'natural'
  });
  assert.deepEqual(content, { enabled: false, mode: 'B', nativeLanguage: 'zh-CN', interfaceLanguageSelected: true, audienceMode: 'reader', uiLanguage: 'zh-CN', theme: 'system', cardColor: 'rose', fontScale: 1, showOriginal: false, showPinyin: false, showDifficulty: false, showExamples: false });
  assert.deepEqual(requestedKeys, ['enabled', 'mode', 'nativeLanguage', 'interfaceLanguageSelected', 'audienceMode', 'uiLanguage', 'theme', 'cardColor', 'fontScale', 'showOriginal', 'showPinyin', 'showDifficulty', 'showExamples']);
  assert.equal(DEFAULT_SETTINGS.mode, 'A');
});

test('content settings changes apply enabled and display mode without reloading the tab', async () => {
  const events: string[] = [];
  await applyContentSettingsChanges(
    {
      async setEnabled(value: boolean) { events.push(`enabled:${value}`); },
      async setMode(value: 'A' | 'B') { events.push(`mode:${value}`); },
      async requestScan() { events.push('scan'); }
    },
    {
      enabled: { newValue: false },
      mode: { newValue: 'B' }
    }
  );

  assert.deepEqual(events, ['enabled:false', 'mode:B']);
});

test('content background adapter transmits context and separates contextual session entries', async () => {
  const sent: TranslateRequest[] = [];
  const translator = createBackgroundTranslationService({
    sendMessage(message) {
      sent.push(message);
      return Promise.resolve(successfulResponse(message));
    }
  });

  assert.deepEqual(
    await translator.translateWithContext(['Thank you'], 'structured', 'plain'),
    ['【译】Thank you']
  );
  assert.deepEqual(
    await translator.translateWithContext(['Thank you'], 'comment', 'plain'),
    ['【译】Thank you']
  );
  assert.deepEqual(await translator.translate(['Thank you']), ['【译】Thank you']);

  assert.deepEqual(sent.map(({ context }) => context), ['structured', 'comment']);
});

test('core background runner classifies with the supplied context and defaults to comment', async () => {
  const values = new Map<string, string>();
  let providerCalls = 0;
  const runner = createCoreBackgroundTranslationRunner({
    glossary: { version: 1, entries: [] },
    cacheStore: {
      async get(key) { return values.get(key); },
      async set(key, value) { values.set(key, value); }
    },
    providerFactory: () => ({
      async translate(request) {
        providerCalls += 1;
        return { ok: true, translations: request.texts.map(() => '谢谢') };
      }
    })
  });

  const defaultContext = await runner.translate(
    ['Thank you'],
    'plain',
    DEFAULT_SETTINGS
  );
  const structured = await runner.translate(
    ['Thank you'],
    'plain',
    DEFAULT_SETTINGS,
    'structured'
  );

  assert.deepEqual(defaultContext, { ok: true, translations: ['Thank you'] });
  assert.deepEqual(structured, { ok: true, translations: ['谢谢'] });
  assert.equal(providerCalls, 1);
});

test('settings default to DeepSeek JSON mode and normalize saved preset options', async () => {
  const defaults = await loadSettings(createStorage({}));
  assert.deepEqual(DEFAULT_SETTINGS, {
    enabled: true,
    mode: 'A',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
    providerPreset: 'deepseek',
    useJsonOutputMode: true,
    translationStyle: 'natural'
  });
  assert.deepEqual(defaults, DEFAULT_SETTINGS);

  const openAI = await loadSettings(createStorage({
    baseURL: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    apiKey: ''
  }));
  assert.equal(openAI.providerPreset, 'openai');
  assert.equal(openAI.useJsonOutputMode, true);

  const custom = await loadSettings(createStorage({
    baseURL: 'https://local.example',
    model: 'local-model',
    apiKey: '',
    providerPreset: 'custom',
    useJsonOutputMode: false
  }));
  assert.equal(custom.providerPreset, 'custom');
  assert.equal(custom.useJsonOutputMode, false);
});

test('settings loader falls back to safe defaults for invalid values', async () => {
  const storage = createStorage({ enabled: 'yes', mode: 'C', apiKey: 42 });
  const settings = await loadSettings(storage);
  assert.deepEqual(settings, DEFAULT_SETTINGS);
});

test('background checks host permission before calling the translation runner', async () => {
  let runnerCalls = 0;
  let checkedBaseURL = '';
  const request: TranslateRequest = {
    type: 'hltv-zh-translate-request',
    requestId: 'request-host-permission',
    purpose: 'plain',
    texts: ['A long English sentence that needs translation']
  };
  const handlerOptions = {
    storage: createStorage({
      ...DEFAULT_SETTINGS,
      enabled: true,
      baseURL: 'https://provider.example/gateway'
    }),
    runner: {
      async translate(texts: string[]) {
        runnerCalls += 1;
        return { ok: true as const, translations: texts.map(() => '意外调用') };
      }
    },
    async hasProviderPermission(settings: { baseURL: string }) {
      checkedBaseURL = settings.baseURL;
      return false;
    }
  };
  const handler = createBackgroundMessageHandler(handlerOptions);

  const response = decodeTranslateResponse(await handler(request));

  assert.equal(checkedBaseURL, 'https://provider.example/gateway');
  assert.equal(runnerCalls, 0);
  assert.equal(response?.ok, false);
  assert.deepEqual(response?.translations, request.texts);
});

test('background keeps glossary-covered labels available without provider permission', async () => {
  let providerCalls = 0;
  const runner = createCoreBackgroundTranslationRunner({
    glossary: {
      version: 1,
      entries: [
        { term: 'News', target: '新闻', keep_as_is: false, category: 'ui' },
        { term: 'Matches', target: '比赛', keep_as_is: false, category: 'ui' }
      ]
    },
    cacheStore: {
      async get() { return undefined; },
      async set() {}
    },
    providerFactory: () => ({
      async translate(request) {
        providerCalls += 1;
        return { ok: true, translations: request.texts.map(() => '模型译文') };
      }
    })
  });
  const handler = createBackgroundMessageHandler({
    storage: createStorage({ ...DEFAULT_SETTINGS }),
    runner,
    async hasProviderPermission() {
      return false;
    }
  });
  const request: TranslateRequest = {
    type: 'hltv-zh-translate-request',
    requestId: 'offline-ui-without-permission',
    purpose: 'plain',
    context: 'structured',
    texts: ['News', 'Matches', 'A long article title needing a provider']
  };

  const response = decodeTranslateResponse(await handler(request));

  assert.equal(response?.ok, true);
  assert.deepEqual(response?.translations, [
    '新闻',
    '比赛',
    'A long article title needing a provider'
  ]);
  assert.equal(providerCalls, 0);
});

test('background preserves offline glossary labels when provider translation fails', async () => {
  let providerInput: string[] = [];
  const handler = createBackgroundMessageHandler({
    storage: createStorage({ ...DEFAULT_SETTINGS }),
    runner: {
      async translateGlossaryCovered(texts: string[]) {
        return texts.map((text) => text === 'News' ? '新闻' : undefined);
      },
      async translate(texts: string[]) {
        providerInput = [...texts];
        return {
          ok: false as const,
          translations: [...texts],
          error: { code: 'provider-failure' as const, message: 'Provider unavailable.' }
        };
      }
    },
    async hasProviderPermission() {
      return true;
    }
  });
  const request: TranslateRequest = {
    type: 'hltv-zh-translate-request',
    requestId: 'offline-ui-with-provider-failure',
    purpose: 'plain',
    context: 'structured',
    texts: ['News', 'A long article headline']
  };

  const response = decodeTranslateResponse(await handler(request));

  assert.equal(response?.ok, true);
  assert.deepEqual(response?.translations, ['新闻', 'A long article headline']);
  assert.deepEqual(providerInput, ['A long article headline']);
});

test('provider permission diagnostics follow startup, settings, grant, and revocation state', async () => {
  const diagnostics: Array<{ code: string; origin?: string } | undefined> = [];
  const permissionChecks: string[] = [];
  const grantedOrigins = new Set<string>();
  let addedListener:
    | ((details: { origins?: string[] }) => void | Promise<void>)
    | undefined;
  let removedListener:
    | ((details: { origins?: string[] }) => void | Promise<void>)
    | undefined;
  let storageListener:
    | ((changes: Record<string, unknown>, areaName: string) => void | Promise<void>)
    | undefined;
  let permissionPrompts = 0;
  const values: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const storage = createStorage(values);
  const permissions = {
    async contains({ origins }: { origins: string[] }) {
      permissionChecks.push(origins[0] ?? '');
      return grantedOrigins.has(origins[0] ?? '');
    },
    async request() {
      permissionPrompts += 1;
      return false;
    },
    onAdded: {
      addListener(listener: (details: { origins?: string[] }) => void | Promise<void>) {
        addedListener = listener;
      }
    },
    onRemoved: {
      addListener(listener: (details: { origins?: string[] }) => void | Promise<void>) {
        removedListener = listener;
      }
    }
  };
  const monitor = createProviderPermissionMonitor({
    storage,
    storageChanges: {
      addListener(listener) {
        storageListener = listener;
      }
    },
    permissions,
    onDiagnostic(diagnostic: { code: string; origin?: string } | undefined) {
      diagnostics.push(diagnostic);
    }
  });
  monitor.install();

  assert.equal(await monitor.checkSavedSettings(), false);
  assert.equal(await monitor.checkSavedSettings(), false);
  assert.deepEqual(diagnostics, [{
    code: 'provider-permission-missing',
    origin: 'https://api.deepseek.com'
  }]);
  assert.deepEqual(permissionChecks, [
    'https://api.deepseek.com/*',
    'https://api.deepseek.com/*'
  ]);

  let runnerCalls = 0;
  const handler = createBackgroundMessageHandler({
    storage,
    hasProviderPermission: monitor.hasProviderPermission,
    runner: {
      async translate(texts) {
        runnerCalls += 1;
        return { ok: true, translations: texts.map((text) => `译:${text}`) };
      }
    }
  });
  const request: TranslateRequest = {
    type: 'hltv-zh-translate-request',
    requestId: 'permission-lifecycle',
    purpose: 'plain',
    texts: ['A long sentence']
  };
  let response = decodeTranslateResponse(await handler(request));
  assert.equal(response?.ok, false);
  assert.equal(runnerCalls, 0);

  const configuredOrigin = 'https://provider.example/*';
  grantedOrigins.add(configuredOrigin);
  await addedListener?.({ origins: [configuredOrigin] });
  await storage.set({
    ...DEFAULT_SETTINGS,
    providerPreset: 'custom',
    baseURL: 'https://provider.example/v1'
  });
  await storageListener?.({
    baseURL: { oldValue: 'https://api.deepseek.com', newValue: 'https://provider.example/v1' }
  }, 'local');

  assert.equal(diagnostics.length, 2);
  assert.deepEqual(diagnostics[0], {
    code: 'provider-permission-missing',
    origin: 'https://api.deepseek.com'
  });
  assert.equal(diagnostics[1], undefined);
  response = decodeTranslateResponse(await handler(request));
  assert.equal(response?.ok, true);
  assert.equal(runnerCalls, 1);

  grantedOrigins.delete(configuredOrigin);
  await removedListener?.({ origins: [configuredOrigin] });
  await removedListener?.({ origins: [configuredOrigin] });

  assert.equal(diagnostics.length, 3);
  assert.deepEqual(diagnostics[0], {
    code: 'provider-permission-missing',
    origin: 'https://api.deepseek.com'
  });
  assert.equal(diagnostics[1], undefined);
  assert.deepEqual(diagnostics[2], {
    code: 'provider-permission-missing',
    origin: 'https://provider.example'
  });
  assert.equal(permissionPrompts, 0);
});

test('background provider factory forwards saved provider settings and injected timeout', async () => {
  let receivedURL = '';
  let receivedTimeout = 0;
  let receivedBody: Record<string, unknown> | undefined;
  const factory = createBackgroundProviderFactory({
    timeoutMs: 4321,
    transport: {
      async send(request: { url: string; timeoutMs: number; body: string }) {
        receivedURL = request.url;
        receivedTimeout = request.timeoutMs;
        receivedBody = JSON.parse(request.body) as Record<string, unknown>;
        return {
          status: 200,
          async json() {
            return { choices: [{ message: { content: '{"translations":["译文"]}' } }] };
          }
        };
      }
    }
  });
  const provider = factory({
    ...SHARED_DEFAULT_SETTINGS,
    providerPreset: 'custom',
    baseURL: 'https://gateway.example/proxy/v1/',
    model: 'gateway-model',
    apiKey: '',
    useJsonOutputMode: false
  });
  const result = await provider.translate({
    texts: ['A full English sentence'],
    purposes: ['plain'],
    protectedFragments: [[]]
  });

  assert.deepEqual(result, { ok: true, translations: ['译文'] });
  assert.equal(receivedURL, 'https://gateway.example/proxy/v1/chat/completions');
  assert.equal(receivedTimeout, 4321);
  assert.equal(receivedBody?.model, 'gateway-model');
  assert.equal(Object.hasOwn(receivedBody ?? {}, 'response_format'), false);
});

test('options save requests one exact origin before writing settings', async () => {
  const events: string[] = [];
  let stored: Record<string, unknown> = { enabled: false };
  const storage = {
    async get() {
      return { ...stored };
    },
    async set(values: Record<string, unknown>) {
      events.push('storage.set');
      stored = { ...values };
    }
  };
  const permissions = {
    async contains({ origins }: { origins: string[] }) {
      events.push('permissions.contains');
      assert.deepEqual(origins, ['https://provider.example/*']);
      return false;
    },
    async request({ origins }: { origins: string[] }) {
      events.push('permissions.request');
      assert.deepEqual(origins, ['https://provider.example/*']);
      return true;
    }
  };

  const result = await saveOptionsSettings(
    {
      ...SHARED_DEFAULT_SETTINGS,
      providerPreset: 'custom',
      baseURL: 'https://provider.example/gateway/',
      model: 'custom-model'
    },
    storage,
    permissions
  );

  assert.deepEqual(events, [
    'permissions.contains',
    'permissions.request',
    'storage.set'
  ]);
  assert.deepEqual(result, { ok: true, origin: 'https://provider.example' });
  assert.equal(stored.baseURL, 'https://provider.example/gateway');
});

test('rejected host permission leaves existing settings untouched', async () => {
  const previous = { enabled: false, apiKey: '' };
  let stored: Record<string, unknown> = { ...previous };
  let writes = 0;
  const result = await saveOptionsSettings(
    {
      ...SHARED_DEFAULT_SETTINGS,
      providerPreset: 'custom',
      baseURL: 'https://provider.example',
      model: 'custom-model'
    },
    {
      async set(values: Record<string, unknown>) {
        writes += 1;
        stored = { ...values };
      }
    },
    {
      async contains() {
        return false;
      },
      async request() {
        return false;
      }
    }
  );

  assert.deepEqual(result, {
    ok: false,
    reason: 'permission-denied',
    origin: 'https://provider.example'
  });
  assert.equal(writes, 0);
  assert.deepEqual(stored, previous);
});

test('provider URL accepts loopback HTTP and preserves HTTPS behavior', () => {
  assert.deepEqual(parseProviderBaseURL('http://localhost:11434'), {
    origin: 'http://localhost:11434',
    normalizedBaseURL: 'http://localhost:11434',
    permissionPattern: 'http://localhost:11434/*',
    endpoint: 'http://localhost:11434/v1/chat/completions'
  });
  assert.deepEqual(parseProviderBaseURL('http://127.0.0.1:1234'), {
    origin: 'http://127.0.0.1:1234',
    normalizedBaseURL: 'http://127.0.0.1:1234',
    permissionPattern: 'http://127.0.0.1:1234/*',
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions'
  });
  assert.deepEqual(parseProviderBaseURL('http://[::1]:11434'), {
    origin: 'http://[::1]:11434',
    normalizedBaseURL: 'http://[::1]:11434',
    permissionPattern: 'http://[::1]:11434/*',
    endpoint: 'http://[::1]:11434/v1/chat/completions'
  });
  assert.equal(parseProviderBaseURL('http://evil.example.com'), undefined);
  assert.deepEqual(parseProviderBaseURL('https://gateway.example/openai/v1/'), {
    origin: 'https://gateway.example',
    normalizedBaseURL: 'https://gateway.example/openai/v1',
    permissionPattern: 'https://gateway.example/*',
    endpoint: 'https://gateway.example/openai/v1/chat/completions'
  });
});

test('invalid base URLs are rejected before permission request or save', async () => {
  const invalidURLs = [
    'http://provider.example',
    'https://@provider.example',
    'https://user@provider.example',
    'https://provider.example/path?mode=test',
    'https://provider.example/path#section'
  ];
  let permissionCalls = 0;
  let writes = 0;
  for (const baseURL of invalidURLs) {
    const result = await saveOptionsSettings(
      {
        ...SHARED_DEFAULT_SETTINGS,
        providerPreset: 'custom',
        baseURL,
        model: 'custom-model'
      },
      {
        async set() {
          writes += 1;
        }
      },
      {
        async contains() {
          permissionCalls += 1;
          return false;
        },
        async request() {
          permissionCalls += 1;
          return true;
        }
      }
    );

    assert.deepEqual(result, { ok: false, reason: 'invalid-base-url' });
  }
  assert.equal(permissionCalls, 0);
  assert.equal(writes, 0);
});

test('permission status and repair request use only the parsed current origin', async () => {
  const requestedOrigins: string[][] = [];
  const permissions = {
    async contains({ origins }: { origins: string[] }) {
      assert.deepEqual(origins, ['https://gateway.example/*']);
      return false;
    },
    async request({ origins }: { origins: string[] }) {
      requestedOrigins.push(origins);
      return true;
    }
  };

  assert.deepEqual(
    await getProviderPermissionStatus(
      'https://gateway.example/proxy/v1/',
      permissions
    ),
    { state: 'missing', origin: 'https://gateway.example' }
  );
  assert.deepEqual(
    await authorizeProviderOrigin(
      'https://gateway.example/proxy/v1/',
      permissions
    ),
    { state: 'granted', origin: 'https://gateway.example' }
  );
  assert.deepEqual(requestedOrigins, [['https://gateway.example/*']]);
});

test('connection test makes one minimal request and reports only a safe result', async () => {
  const requests: Array<{ url: string; body: string }> = [];
  let permissionChecks = 0;
  const result = await testProviderConnection(
    { ...SHARED_DEFAULT_SETTINGS, apiKey: '' },
    {
      async contains({ origins }: { origins: string[] }) {
        permissionChecks += 1;
        assert.deepEqual(origins, ['https://api.deepseek.com/*']);
        return true;
      }
    },
    {
      async send(request: { url: string; body: string }) {
        requests.push({ url: request.url, body: request.body });
        return {
          status: 200,
          async json() {
            return { choices: [{ message: { content: '{"translations":["你好"]}' } }] };
          }
        };
      }
    }
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(permissionChecks, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.match(requests[0]?.body ?? '', /Hello\./);
});

test('connection test guides response_format failures to the JSON output setting', async () => {
  let requests = 0;
  const result = await testProviderConnection(
    { ...SHARED_DEFAULT_SETTINGS, apiKey: '' },
    { async contains() { return true; } },
    {
      async send() {
        requests += 1;
        return {
          status: 400,
          async json() { return { error: { message: 'response_format rejected' } }; }
        };
      }
    }
  );

  assert.deepEqual(result, { ok: false, reason: 'response-format-unsupported' });
  assert.equal(requests, 1);
});

test('connection test distinguishes missing permission, timeout, unauthorized, and network failure', async () => {
  let requests = 0;
  const settings = { ...SHARED_DEFAULT_SETTINGS, apiKey: '' };
  const denied = await testProviderConnection(
    settings,
    { async contains() { return false; } },
    { async send() { requests += 1; throw new Error('unreachable'); } },
    2
  );
  const timedOut = await testProviderConnection(
    settings,
    { async contains() { return true; } },
    { async send() { requests += 1; return new Promise(() => {}); } },
    2
  );
  const unauthorized = await testProviderConnection(
    settings,
    { async contains() { return true; } },
    { async send() {
      requests += 1;
      return { status: 401, async json() { return { error: { message: 'unauthorized' } }; } };
    } },
    2
  );
  const network = await testProviderConnection(
    settings,
    { async contains() { return true; } },
    { async send() { requests += 1; throw new Error('network unavailable'); } },
    2
  );

  assert.deepEqual(denied, { ok: false, reason: 'permission' });
  assert.deepEqual(timedOut, { ok: false, reason: 'timeout' });
  assert.deepEqual(unauthorized, { ok: false, reason: 'unauthorized', status: 401 });
  assert.deepEqual(network, { ok: false, reason: 'network' });
  assert.equal(requests, 3);
});

test('cache clearing reports the number of removed IndexedDB entries', async () => {
  const cacheStoreModule = await import('../src/background/cache-store.ts');
  const cache = cacheStoreModule.createCacheStoreFromBackend({
    async get() { return undefined; },
    async set() {},
    async clear() { return 7; }
  });

  assert.equal(
    typeof (cache as unknown as { clear?: () => Promise<number> }).clear,
    'function',
    'the IndexedDB cache adapter must expose a counted clear operation'
  );
  assert.equal(
    await (cache as unknown as { clear: () => Promise<number> }).clear(),
    7
  );
});

test('background handler reports settings read failure as an original-text fallback', async () => {
  const handler = createBackgroundMessageHandler({
    storage: {
      get: async () => {
        throw new Error('storage unavailable');
      },
      set: async () => {}
    },
    runner: {
      translate: async () => ({ ok: true, translations: ['unexpected'] })
    }
  });
  const request: TranslateRequest = {
    type: 'hltv-zh-translate-request',
    requestId: 'request-settings-failure',
    purpose: 'plain',
    texts: ['A long English sentence']
  };

  const response = decodeTranslateResponse(await handler(request));
  assert.equal(response?.ok, false);
  if (response?.ok === false) {
    assert.equal(response.error.code, 'settings-failure');
    assert.deepEqual(response.translations, request.texts);
  }
});

test('cache adapter treats read failure as a miss and records write failure', async () => {
  const diagnostics: string[] = [];
  const backend: CacheBackend = {
    async get() {
      throw new Error('read failed');
    },
    async set() {
      throw new Error('write failed');
    }
  };
  const cache = createCacheStoreFromBackend(backend, (diagnostic) => {
    diagnostics.push(diagnostic.code);
  });

  assert.equal(await cache.get('hash'), undefined);
  await cache.set('hash', 'translated');
  assert.deepEqual(diagnostics, ['cache-read-failed', 'cache-write-failed']);
});

test('background cache hit still receives one message but does not call the provider', async () => {
  const original = 'A long English sentence for a cached translation';
  const cached = '已缓存的译文';
  let providerCalls = 0;
  const saved = new Map<string, string>();
  const cache = {
    async get(key: string) {
      return saved.get(key);
    },
    async set(key: string, value: string) {
      saved.set(key, value);
    }
  };
  const providerFactory = (): TranslationProvider => ({
    async translate() {
      providerCalls += 1;
      return { ok: true, translations: [cached] };
    }
  });
  const runner = createCoreBackgroundTranslationRunner({
    glossary: { version: 1, entries: [] },
    cacheStore: cache,
    providerFactory
  });

  await runner.translate([original], 'plain', DEFAULT_SETTINGS);
  providerCalls = 0;
  const result = await runner.translate(
    [original],
    'plain',
    DEFAULT_SETTINGS
  );
  assert.deepEqual(result, { ok: true, translations: [cached] });
  assert.equal(providerCalls, 0);
});

test('background runner deduplicates concurrent identical requests', async () => {
  let providerCalls = 0;
  const runner = createCoreBackgroundTranslationRunner({
    glossary: { version: 1, entries: [] },
    cacheStore: {
      async get() { return undefined; },
      async set() {}
    },
    providerFactory: () => ({
      async translate(request) {
        providerCalls += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        return { ok: true as const, translations: request.texts.map((text) => `译文:${text}`) };
      }
    })
  });
  const original = 'A long English sentence for concurrent runner deduplication';

  const [first, second] = await Promise.all([
    runner.translate([original], 'plain', DEFAULT_SETTINGS),
    runner.translate([original], 'plain', DEFAULT_SETTINGS)
  ]);

  assert.deepEqual(first, { ok: true, translations: [`译文:${original}`] });
  assert.deepEqual(second, first);
  assert.equal(providerCalls, 1);
});

test('background runner retries a failed primary provider with the configured fallback', async () => {
  const calls: string[] = [];
  const runner = createCoreBackgroundTranslationRunner({
    glossary: { version: 1, entries: [] },
    cacheStore: {
      async get() { return undefined; },
      async set() {}
    },
    providerFactory: (settings) => ({
      async translate(request) {
        calls.push(settings.baseURL);
        if (settings.baseURL === 'https://primary.example') {
          return { ok: false, error: { code: 'transport-error', message: 'primary down' } };
        }
        return { ok: true, translations: request.texts.map(() => '备用译文') };
      }
    })
  });

  const result = await runner.translate([
    'A sentence needs translation.'
  ], 'sentence', {
    ...SHARED_DEFAULT_SETTINGS,
    baseURL: 'https://primary.example',
    fallbackEnabled: true,
    fallbackBaseURL: 'https://fallback.example',
    fallbackModel: 'fallback-model',
    fallbackApiKey: 'fallback-key'
  }, 'prose');

  assert.deepEqual(result, { ok: true, translations: ['备用译文'] });
  assert.deepEqual(calls, ['https://primary.example', 'https://fallback.example']);
});

test('background runner isolates cached translations when the model changes', async () => {
  const cache = new Map<string, string>();
  let providerCalls = 0;
  const runner = createCoreBackgroundTranslationRunner({
    glossary: { version: 1, entries: [] },
    cacheStore: {
      async get(key) { return cache.get(key); },
      async set(key, value) { cache.set(key, value); }
    },
    providerFactory: (settings) => ({
      async translate() {
        providerCalls += 1;
        return { ok: true as const, translations: [`${settings.model}:译文`] };
      }
    })
  });
  const original = 'A long English sentence for model cache isolation';

  const first = await runner.translate([original], 'plain', { ...DEFAULT_SETTINGS, model: 'model-one' });
  const second = await runner.translate([original], 'plain', { ...DEFAULT_SETTINGS, model: 'model-two' });

  assert.deepEqual(first, { ok: true, translations: ['model-one:译文'] });
  assert.deepEqual(second, { ok: true, translations: ['model-two:译文'] });
  assert.equal(providerCalls, 2);
});

test('fake provider covers success, provider failure, invalid response, and never-resolve modes', async () => {
  const request = {
    texts: ['A long English sentence'],
    protectedFragments: [[]],
    purposes: ['plain' as const]
  };
  const modes: FakeProviderMode[] = [
    'success',
    'provider-failure',
    'invalid-response',
    'never-resolve'
  ];
  const providers: TranslationProvider[] = modes.map((mode) =>
    createFakeProvider({ mode })
  );

  const successful = await providers[0].translate(request);
  assert.deepEqual(successful, {
    ok: true,
    translations: ['【译】A long English sentence']
  });
  const providerFailure = await providers[1].translate(request);
  assert.deepEqual(providerFailure.ok, false);
  if (!providerFailure.ok) {
    assert.equal(providerFailure.error.code, 'transport-error');
  }
  const invalidResponse = await providers[2].translate(request);
  assert.deepEqual(invalidResponse.ok, false);
  if (!invalidResponse.ok) {
    assert.equal(invalidResponse.error.code, 'invalid-response');
  }
  const unresolved = providers[3].translate(request);
  const timed = await Promise.race([
    unresolved.then(() => 'resolved'),
    new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 5))
  ]);
  assert.equal(timed, 'timed-out');
});

test('core background runner exposes fake provider failures as original-text results', async () => {
  const original = 'A long English sentence for the runner';
  const failureRunner = createCoreBackgroundTranslationRunner({
    glossary: { version: 1, entries: [] },
    cacheStore: {
      async get() {
        return undefined;
      },
      async set() {}
    },
    providerFactory: () => createFakeProvider({ mode: 'provider-failure' })
  });
  const invalidRunner = createCoreBackgroundTranslationRunner({
    glossary: { version: 1, entries: [] },
    cacheStore: {
      async get() {
        return undefined;
      },
      async set() {}
    },
    providerFactory: () => createFakeProvider({ mode: 'invalid-response' })
  });

  const failure = await failureRunner.translate(
    [original],
    'plain',
    DEFAULT_SETTINGS
  );
  const invalid = await invalidRunner.translate(
    [original],
    'plain',
    DEFAULT_SETTINGS
  );
  assert.deepEqual(failure, {
    ok: false,
    translations: [original],
    error: {
      code: 'provider-failure',
      message: 'Network request failed.'
    }
  });
  assert.deepEqual(invalid, {
    ok: false,
    translations: [original],
    error: {
      code: 'invalid-response',
      message: 'Provider returned an invalid response.'
    }
  });
});

test('core background runner replaces raw provider error detail with a safe description', async () => {
  const runner = createCoreBackgroundTranslationRunner({
    glossary: { version: 1, entries: [] },
    cacheStore: {
      async get() { return undefined; },
      async set() {}
    },
    providerFactory: () => ({
      async translate() {
        return {
          ok: false as const,
          error: {
            code: 'transport-error' as const,
            message: 'private provider response detail'
          }
        };
      }
    })
  });
  const result = await runner.translate(
    ['A long English sentence'],
    'plain',
    DEFAULT_SETTINGS
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.message, 'Network request failed.');
    assert.equal(result.error.message.includes('private provider response detail'), false);
  }
});
