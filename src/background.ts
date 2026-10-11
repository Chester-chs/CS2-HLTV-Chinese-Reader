import browser from 'webextension-polyfill';
import type { Runtime } from 'webextension-polyfill';
import { createIndexedDbCacheStore } from './background/cache-store.ts';
import { loadPackagedGlossary } from './background/glossary-loader.ts';
import {
  createBackgroundMessageHandler
} from './background/translation-handler.ts';
import { createCoreBackgroundTranslationRunner } from './background/translation-engine.ts';
import type { ExtensionSettingsStorage } from './background/settings.ts';
import { createProviderPermissionMonitor } from './background/provider-permissions.ts';
import { createBackgroundProviderFactory } from './background/provider.ts';
import { createDictionaryMessageHandler } from './background/dictionary-handler.ts';
import { DICTIONARY_MESSAGE_TYPE } from './shared/dictionary-messages.ts';
import { TRANSLATE_REQUEST_TYPE, TRANSLATE_CANCEL_TYPE } from './background/protocol.ts';
import { createCancellableTranslationHandler } from './background/cancellation.ts';
import type { DictionaryStorage } from './content/dictionary-store.ts';

const { version } = browser.runtime.getManifest();

console.log(`[cs2-hltv-zh] background started (version ${version})`);

const cacheStore = createIndexedDbCacheStore({
  onDiagnostic(diagnostic) {
    console.warn('[cs2-hltv-zh] cache diagnostic', diagnostic.code, diagnostic.key);
  }
});

const glossary = loadPackagedGlossary(
  browser.runtime.getURL('glossary.json'),
  undefined,
  (diagnostic) => {
    console.warn('[cs2-hltv-zh] glossary diagnostic', diagnostic.code);
  }
);

const runner = createCoreBackgroundTranslationRunner({
  glossary,
  cacheStore,
  providerFactory: createBackgroundProviderFactory()
});

const providerPermissionMonitor = createProviderPermissionMonitor({
  storage: browser.storage.local as unknown as ExtensionSettingsStorage,
  storageChanges: browser.storage.onChanged,
  permissions: browser.permissions,
  onDiagnostic(diagnostic) {
    if (diagnostic === undefined) {
      console.info('[cs2-hltv-zh] provider permission diagnostic cleared');
      return;
    }
    console.warn(
      '[cs2-hltv-zh] provider permission diagnostic',
      diagnostic.code,
      diagnostic.origin
    );
  }
});
providerPermissionMonitor.install();
void providerPermissionMonitor.checkSavedSettings();

const messageHandler = createBackgroundMessageHandler({
  storage: browser.storage.local as unknown as ExtensionSettingsStorage,
  runner,
  hasProviderPermission: providerPermissionMonitor.hasProviderPermission
});

const dictionaryHandler = createDictionaryMessageHandler(browser.storage.local as unknown as DictionaryStorage);
const cancellableHandler = createCancellableTranslationHandler(messageHandler);
browser.runtime.onMessage.addListener((message: unknown, sender: Runtime.MessageSender) => {
  if (sender.id !== browser.runtime.id || typeof message !== 'object' || message === null) return undefined;
  const type = (message as Record<string, unknown>).type;
  if (type === DICTIONARY_MESSAGE_TYPE) return dictionaryHandler(message);
  if (type === TRANSLATE_REQUEST_TYPE || type === TRANSLATE_CANCEL_TYPE) {
    const scope = JSON.stringify([sender.tab?.id ?? 'extension', sender.frameId ?? 0, sender.url ?? '']);
    return cancellableHandler(message, scope);
  }
  return undefined;
});
