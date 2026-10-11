const { strict: assert } = await import('node:assert/strict' as string) as {
  strict: { equal(a: unknown, b: unknown): void; deepEqual(a: unknown, b: unknown): void };
};
const { test } = await import('node:test' as string) as { test(name: string, run: () => void | Promise<void>): void };
import { createCancellableTranslationHandler } from '../src/background/cancellation.ts';
import { createBackgroundProviderFactory } from '../src/background/provider.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import { createBackgroundTranslationService } from '../src/content/background-translator.ts';
import { createCoreBackgroundTranslationRunner } from '../src/background/translation-engine.ts';

test('cancelled lookup returns immediately, sends its ID and never caches a late response', async () => {
  let late: ((value: unknown) => void) | undefined;
  const ids: string[] = [];
  const cancelled: string[] = [];
  const adapter = createBackgroundTranslationService({
    sendMessage: async (message) => {
      ids.push(message.requestId);
      if (ids.length === 1) return new Promise((resolve) => { late = resolve; });
      return { type: 'hltv-zh-translate-response', requestId: message.requestId, purpose: message.purpose, ok: true, translations: ['新译文'] };
    },
    sendCancel: async (message) => { cancelled.push(message.requestId); }
  });
  const abort = new AbortController();
  const pending = adapter.translateWithContextDetailed(['word'], 'structured', 'dictionary', { signal: abort.signal });
  abort.abort();
  assert.equal((await pending).errorCode, 'cancelled');
  assert.equal(cancelled.includes(ids[0]!), true);
  late!({ type: 'hltv-zh-translate-response', requestId: ids[0], purpose: 'dictionary', ok: true, translations: ['旧译文'] });
  assert.deepEqual(await adapter.translateWithContextDetailed(['word'], 'structured', 'dictionary'), { translations: ['新译文'] });
  assert.equal(ids.length, 2);
});

test('cancelling a selection prevents fallback and leaves an identical independent request running', async () => {
  const started: AbortSignal[] = [];
  let start!: () => void;
  const ready = new Promise<void>((resolve) => { start = resolve; });
  let fallbackCalls = 0;
  const runner = createCoreBackgroundTranslationRunner({
    glossary: { version: 1, entries: [] }, cacheStore: { async get() { return undefined; }, async set() {} },
    providerFactory: (settings, signal) => ({ async translate() {
      if (settings.providerPreset === 'custom') { fallbackCalls += 1; return { ok: true, translations: ['备用'] }; }
      if (signal === undefined) return { ok: true, translations: ['独立查询'] };
      started.push(signal); start();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { ok: false, error: { code: 'transport-error', message: 'aborted' } };
    } })
  });
  const settings = { ...DEFAULT_SETTINGS, fallbackEnabled: true, fallbackBaseURL: 'https://fallback.invalid', fallbackModel: 'model', fallbackApiKey: 'key' };
  const controller = new AbortController();
  const pending = runner.translate(['word'], 'dictionary', settings, 'structured', controller.signal);
  await ready;
  const independent = runner.translate(['word'], 'dictionary', settings, 'structured');
  controller.abort();
  assert.equal((await pending).ok, false);
  assert.deepEqual(await independent, { ok: true, translations: ['独立查询'] });
  assert.equal(started.length, 1);
  assert.equal(fallbackCalls, 0);
});

test('cancel scopes a request to its own document even with identical request IDs', async () => {
  const signals: AbortSignal[] = [];
  const finish: Array<() => void> = [];
  const handler = createCancellableTranslationHandler(async (message, signal) => {
    signals.push(signal!);
    await new Promise<void>((resolve) => finish.push(resolve));
    return { type: 'hltv-zh-translate-response', requestId: (message as { requestId: string }).requestId,
      purpose: 'dictionary', ok: true, translations: ['中文'] };
  });
  const message = { type: 'hltv-zh-translate-request', requestId: 'same', purpose: 'dictionary', texts: ['word'], cancellable: true };
  const a = handler(message, 'document-a');
  const b = handler(message, 'document-b');
  await handler({ type: 'hltv-zh-translate-cancel', requestId: 'same' }, 'document-a');
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[1]!.aborted, false);
  assert.equal((await a)?.ok, false);
  finish[0]!(); finish[1]!();
  assert.equal((await b)?.ok, true);
});

test('provider cancellation aborts the actual fetch and does not expose transport errors', async () => {
  const abort = new AbortController();
  let observed: AbortSignal | null | undefined;
  const factory = createBackgroundProviderFactory({ fetcher: async (_input, init) => {
    observed = init?.signal;
    await new Promise<void>((_resolve, reject) => observed!.addEventListener('abort', () => reject(new Error('sensitive transport detail')), { once: true }));
    throw new Error('unreachable');
  } });
  const pending = factory(DEFAULT_SETTINGS, abort.signal).translate({ texts: ['word'], protectedFragments: [[]], purposes: ['dictionary'] });
  abort.abort();
  assert.equal((await pending).ok, false);
  assert.equal(observed?.aborted, true);
});
