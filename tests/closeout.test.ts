const { strict: assert } = await import('node:assert/strict' as string) as {
  strict: { equal(a: unknown, b: unknown): void; deepEqual(a: unknown, b: unknown): void };
};
const { test } = await import('node:test' as string) as {
  test(name: string, run: () => void | Promise<void>): void;
};
import { createCoreBackgroundTranslationRunner } from '../src/background/translation-engine.ts';
import { createBackgroundMessageHandler } from '../src/background/translation-handler.ts';
import { createBackgroundTranslationService } from '../src/content/background-translator.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import { createDictionaryMessageHandler } from '../src/background/dictionary-handler.ts';
import { parseReadingBackup, createReadingBackup, planReadingRestore } from '../src/shared/reading-backup.ts';
import { createDictionaryStore } from '../src/content/dictionary-store.ts';
import { decodeTranslateResponse } from '../src/background/protocol.ts';

test('clearing session cache prevents old provider settings from repopulating it', async () => {
  let finish!: (value: unknown) => void;
  let calls = 0;
  let oldId = '';
  const adapter = createBackgroundTranslationService({ sendMessage: async (request) => {
    calls += 1;
    if (calls === 1) { oldId = request.requestId; return new Promise((resolve) => { finish = resolve; }); }
    return { type: 'hltv-zh-translate-response', requestId: request.requestId, purpose: request.purpose, ok: true, translations: ['新版译文'] };
  } });
  const pending = adapter.translateWithContextDetailed(['word'], 'structured', 'dictionary');
  adapter.clearSessionCache();
  finish({ type: 'hltv-zh-translate-response', requestId: oldId, purpose: 'dictionary', ok: true, translations: ['旧版译文'] });
  await pending;
  assert.deepEqual(await adapter.translateWithContextDetailed(['word'], 'structured', 'dictionary'), { translations: ['新版译文'] });
  assert.equal(calls, 2);
});

test('provider cache separates styles and a healthy primary ignores invalid legacy fallback', async () => {
  const cache = new Map<string, string>();
  let calls = 0;
  let fallbackCalls = 0;
  const runner = createCoreBackgroundTranslationRunner({ glossary: { version: 1, entries: [] },
    cacheStore: { async get(key) { return cache.get(key); }, async set(key, value) { cache.set(key, value); } },
    providerFactory: (settings) => {
      if (settings.providerPreset === 'custom') { fallbackCalls += 1; throw new Error('Invalid fallback'); }
      return { async translate() { calls += 1; return { ok: true, translations: [settings.translationStyle === 'natural' ? '自然译文' : '直译译文'] }; } };
    }
  });
  const settings = { ...DEFAULT_SETTINGS, fallbackEnabled: true, fallbackBaseURL: 'bad', fallbackModel: 'model', fallbackApiKey: 'key' };
  assert.deepEqual(await runner.translate(['word'], 'dictionary', settings), { ok: true, translations: ['自然译文'] });
  assert.deepEqual(await runner.translate(['word'], 'dictionary', { ...settings, translationStyle: 'literal' }), { ok: true, translations: ['直译译文'] });
  assert.deepEqual(await runner.translate(['word'], 'dictionary', settings), { ok: true, translations: ['自然译文'] });
  assert.equal(calls, 2);
  assert.equal(fallbackCalls, 0);
});

test('merge keeps an existing favorite unreviewed instead of adopting imported progress', () => {
  const current = createReadingBackup({ dictionaryFavorites: [{ query: 'word', translated: '词', savedAt: 1 }] }, 1);
  const incoming = { ...current, review: { word: { dueAt: 999999, interval: 4 } } };
  assert.deepEqual(planReadingRestore(current, incoming, 'merge').values.dictionaryReviewState, {});
  assert.deepEqual(planReadingRestore(current, incoming, 'replace').values.dictionaryReviewState, { word: { dueAt: 999999, interval: 4 } });
});

test('session cache plus a failed miss marks the failed input and notifies page readers', async () => {
  let online = true;
  const notices: string[][] = [];
  const adapter = createBackgroundTranslationService({
    onIncomplete: (texts) => { notices.push(texts); },
    sendMessage: async (request) => online ? { type: 'hltv-zh-translate-response', requestId: request.requestId,
      purpose: request.purpose, ok: true, translations: ['译文'] } : { type: 'hltv-zh-translate-response', requestId: request.requestId,
      purpose: request.purpose, ok: false, translations: request.texts,
      error: { code: 'provider-failure', fallback: 'original', message: 'offline' } }
  });
  await adapter.translateWithContext(['Cached sentence'], 'prose', 'plain');
  online = false;
  const result = await adapter.translateWithContextDetailed(['Cached sentence', 'Missing sentence'], 'prose', 'plain');
  assert.deepEqual(result.translations, ['译文', 'Missing sentence']);
  assert.deepEqual(result.failedIndexes, [1]);
  assert.deepEqual(notices, [['Missing sentence']]);
});

test('backup validation rejects malformed data before a write and capacity merges report omissions', () => {
  const base = createReadingBackup({}, 100);
  assert.equal(parseReadingBackup({ ...base, appearance: { theme: 'light', cardColor: 'rose', fontScale: 100 } }), undefined);
  assert.equal(parseReadingBackup({ ...base, history: [{ query: 'x', translated: '词', savedAt: NaN }] }), undefined);
  assert.equal(parseReadingBackup({ ...base, review: { orphan: { dueAt: 10, interval: 1 } } }), undefined);
  const current = { ...base, favorites: Array.from({ length: 100 }, (_, i) => ({ query: `word${i}`, translated: '词', savedAt: 100 })) };
  const incoming = { ...base, favorites: [{ query: 'new', translated: '新', savedAt: 1 }], review: { new: { dueAt: 2, interval: 1 } } };
  const plan = planReadingRestore(current, incoming, 'merge');
  assert.deepEqual(plan.report, { history: 0, favorites: 100, omitted: 1 });
  assert.deepEqual(plan.values.dictionaryReviewState, {});
});

test('review ratings persist increasing due dates and later resets to the next day', async () => {
  const values: Record<string, unknown> = {};
  const store = createDictionaryStore({ async get() { return { ...values }; }, async set(next) { Object.assign(values, next); } }, () => 1000);
  await store.recordReview('Word', true);
  assert.deepEqual((await store.listReview()).word, { interval: 1, dueAt: 86401000 });
  await store.recordReview('word', true);
  assert.deepEqual((await store.listReview()).word, { interval: 2, dueAt: 172801000 });
  await store.recordReview('word', false);
  assert.deepEqual((await store.listReview()).word, { interval: 1, dueAt: 86401000 });
});

test('partial warning decoder rejects out-of-range and duplicate failed indexes', () => {
  const response = { type: 'hltv-zh-translate-response', requestId: 'id', purpose: 'plain', ok: true,
    translations: ['译文', 'original'], warning: { code: 'provider-failure', message: 'offline', failedIndexes: [1] } };
  assert.equal(decodeTranslateResponse(response)?.ok, true);
  assert.equal(decodeTranslateResponse({ ...response, warning: { ...response.warning, failedIndexes: [2] } }), undefined);
  assert.equal(decodeTranslateResponse({ ...response, warning: { ...response.warning, failedIndexes: [1, 1] } }), undefined);
});

test('reading backups omit secrets, merge existing entries and restore appearance and review together', async () => {
  const values: Record<string, unknown> = { apiKey: 'secret', model: 'private-model',
    dictionaryHistory: [{ query: 'bench', translated: '原译文', savedAt: 20 }],
    dictionaryFavorites: [], dictionaryReviewState: {}, theme: 'dark', cardColor: 'rose', fontScale: 1.2 };
  const handler = createDictionaryMessageHandler({ async get() { return { ...values }; },
    async set(next) { Object.assign(values, next); } });
  const exported = await handler({ type: 'hltv-zh-dictionary', action: 'export-backup' });
  assert.equal(exported.ok, true);
  const backup = exported.ok ? exported.value as Record<string, unknown> : {};
  assert.equal(JSON.stringify(backup).includes('secret'), false);
  assert.equal(JSON.stringify(backup).includes('private-model'), false);
  const imported = { ...backup, history: [{ query: 'BENCH', translated: '导入译文', savedAt: 10 },
    { query: 'win', translated: '获胜', savedAt: 11 }],
    favorites: [{ query: 'win', translated: '获胜', savedAt: 11 }],
    review: { win: { dueAt: 100, interval: 1 } }, appearance: { theme: 'light', cardColor: 'blue', fontScale: 1 } };
  assert.equal((await handler({ type: 'hltv-zh-dictionary', action: 'import-backup', backup: imported, importMode: 'merge' })).ok, true);
  assert.deepEqual(values.dictionaryHistory, [{ query: 'bench', translated: '原译文', savedAt: 20 }, { query: 'win', translated: '获胜', savedAt: 11 }]);
  assert.deepEqual(values.dictionaryReviewState, { win: { dueAt: 100, interval: 1 } });
  assert.equal(values.theme, 'light');
  assert.equal(values.apiKey, 'secret');
  assert.equal((await handler({ type: 'hltv-zh-dictionary', action: 'import-backup', backup: imported, importMode: 'replace' })).ok, true);
  assert.deepEqual(values.dictionaryHistory, imported.history);
  const previous = JSON.stringify(values);
  assert.equal((await handler({ type: 'hltv-zh-dictionary', action: 'import-backup', backup: { ...imported, version: 99 }, importMode: 'replace' })).ok, false);
  assert.equal(JSON.stringify(values), previous);
});

test('a mixed cache batch keeps cached translations offline and retries only failed misses', async () => {
  const values = new Map<string, string>();
  let online = true;
  const calls: string[][] = [];
  const runner = createCoreBackgroundTranslationRunner({
    glossary: { version: 1, entries: [] },
    cacheStore: { async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); } },
    providerFactory: () => ({ async translate(request) {
      calls.push([...request.texts]);
      return online ? { ok: true, translations: request.texts.map(() => '中文译文') }
        : { ok: false, error: { code: 'transport-error', message: 'offline' } };
    } })
  });
  await runner.translate(['cached'], 'dictionary', DEFAULT_SETTINGS, 'structured');
  online = false;
  const handler = createBackgroundMessageHandler({ storage: { async get() { return { ...DEFAULT_SETTINGS }; }, async set() {} }, runner });
  const adapter = createBackgroundTranslationService({ sendMessage: handler });
  const result = await adapter.translateWithContextDetailed(['cached', 'missing', 'missing'], 'structured', 'dictionary');
  assert.deepEqual(result.translations, ['中文译文', 'missing', 'missing']);
  assert.deepEqual(result.failedIndexes, [1, 2]);
  assert.equal(result.errorCode, 'provider-failure');
  online = true;
  assert.deepEqual(await adapter.translateWithContextDetailed(['cached', 'missing'], 'structured', 'dictionary'),
    { translations: ['中文译文', '中文译文'] });
  assert.deepEqual(calls, [['cached'], ['missing'], ['missing']]);
});
