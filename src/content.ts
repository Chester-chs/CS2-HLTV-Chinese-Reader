import browser from 'webextension-polyfill';
import glossary from '../glossary.json';
import { createBackgroundTranslationService } from './content/background-translator.ts';
import { installDebugEventBridge } from './content/debug-bridge.ts';
import { createContentRuntime } from './content/runtime.ts';
import { loadContentSettings } from './content/settings.ts';
import { applyContentSettingsChanges } from './content/settings-sync.ts';
import type { TranslateRequest } from './background/protocol.ts';
import type { ContentSettingsStorage } from './content/settings.ts';
import { installSelectionMagnifier } from './content/selection-translation.ts';
import { DICTIONARY_FAVORITES_KEY, type DictionaryStorage } from './content/dictionary-store.ts';
import { createDictionaryClient } from './content/dictionary-client.ts';

browser.runtime.getManifest();

console.log(`[cs2-hltv-zh] content script injected at ${location.href}`);

async function startContentScript(): Promise<void> {
  const settings = await loadContentSettings(
    browser.storage.local as unknown as ContentSettingsStorage
  );
  const translator = createBackgroundTranslationService({
    sendMessage(message: TranslateRequest) {
      return browser.runtime.sendMessage(message) as Promise<unknown>;
    },
    sendCancel: (message) => browser.runtime.sendMessage(message),
    onIncomplete(texts) {
      showIncompleteNotice(texts.length);
    }
  });
  const dictionaryStore = createDictionaryClient((message) => browser.runtime.sendMessage(message));
  let currentTheme = settings.theme;
  let currentCardColor = settings.cardColor;
  let currentFontScale = settings.fontScale;
  let currentLearning = {
    nativeLanguage: settings.nativeLanguage,
    audienceMode: settings.audienceMode,
    uiLanguage: settings.uiLanguage,
    showOriginal: settings.showOriginal,
    showPinyin: settings.showPinyin,
    showDifficulty: settings.showDifficulty,
    showExamples: settings.showExamples
  };
  const runtime = createContentRuntime({
    document,
    translator,
    fixedUiGlossary: glossary,
    initialMode: settings.mode,
    initialEnabled: settings.enabled,
    onDiagnostic(diagnostic) {
      console.warn('[cs2-hltv-zh] content diagnostic', diagnostic);
    }
  });

  const magnifier = installSelectionMagnifier({
    document,
    translator,
    dictionaryStore,
    appearance: {
      theme: settings.theme,
      cardColor: settings.cardColor,
      fontScale: settings.fontScale
    },
    appearanceStore: browser.storage.local as unknown as DictionaryStorage,
    learning: currentLearning
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }
    if (Object.hasOwn(changes, DICTIONARY_FAVORITES_KEY)) magnifier?.refreshFavorites();
    if (magnifier !== undefined && (Object.hasOwn(changes, 'theme') || Object.hasOwn(changes, 'cardColor') || Object.hasOwn(changes, 'fontScale'))) {
      const theme = changes.theme?.newValue;
      const fontScale = changes.fontScale?.newValue;
      if (theme === 'light' || theme === 'dark' || theme === 'system') {
        currentTheme = theme;
      }
      const nextCardColor = changes.cardColor?.newValue;
      if (nextCardColor === 'neutral' || nextCardColor === 'blue' || nextCardColor === 'green' || nextCardColor === 'sand' || nextCardColor === 'rose') {
        currentCardColor = nextCardColor;
      }
      if (typeof fontScale === 'number' && Number.isFinite(fontScale)) {
        currentFontScale = fontScale;
      }
      magnifier.setAppearance({
        theme: currentTheme,
        cardColor: currentCardColor,
        fontScale: currentFontScale
      });
    }
    if (magnifier !== undefined && (Object.hasOwn(changes, 'nativeLanguage') || Object.hasOwn(changes, 'audienceMode') || Object.hasOwn(changes, 'uiLanguage') || Object.hasOwn(changes, 'showOriginal') || Object.hasOwn(changes, 'showPinyin') || Object.hasOwn(changes, 'showDifficulty') || Object.hasOwn(changes, 'showExamples'))) {
      if (Object.hasOwn(changes, 'nativeLanguage')) currentLearning.nativeLanguage = 'zh-CN';
      if (Object.hasOwn(changes, 'audienceMode')) currentLearning.audienceMode = 'reader';
      currentLearning.uiLanguage = 'zh-CN';
      if (typeof changes.showOriginal?.newValue === 'boolean') currentLearning.showOriginal = changes.showOriginal.newValue;
      if (Object.hasOwn(changes, 'showPinyin')) currentLearning.showPinyin = false;
      if (typeof changes.showDifficulty?.newValue === 'boolean') currentLearning.showDifficulty = changes.showDifficulty.newValue;
      if (typeof changes.showExamples?.newValue === 'boolean') currentLearning.showExamples = changes.showExamples.newValue;
      magnifier.setLearningOptions?.(currentLearning);
    }
    void applyContentSettingsChanges(runtime, changes).catch(() => {
      console.warn('[cs2-hltv-zh] content settings could not be applied');
    });
  });

  // Temporary B3a document-event bridge retained for runtime diagnostics.
  installDebugEventBridge(document, runtime);
  await runtime.start();
}

void startContentScript();

let incompleteNotice: HTMLElement | undefined;
let incompleteTimer: ReturnType<typeof setTimeout> | undefined;
function showIncompleteNotice(count: number): void {
  if (document.body === null) return;
  if (incompleteNotice === undefined) {
    incompleteNotice = document.createElement('div');
    incompleteNotice.setAttribute('role', 'status');
    incompleteNotice.setAttribute('data-hltv-zh-selection-ui', '1');
    Object.assign(incompleteNotice.style, { position: 'fixed', bottom: '16px', left: '16px', zIndex: '2147483646',
      padding: '12px 16px', borderRadius: '14px', background: '#202124', color: '#ffffff', maxWidth: 'min(360px, calc(100vw - 32px))',
      font: '14px/1.6 system-ui, sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,.2)' });
    document.body.appendChild(incompleteNotice);
  }
  incompleteNotice.textContent = `部分内容未完成翻译（本批 ${count} 项），已保留可用译文。请检查网络与服务设置后刷新页面。`;
  incompleteNotice.hidden = false;
  if (incompleteTimer !== undefined) clearTimeout(incompleteTimer);
  incompleteTimer = setTimeout(() => { if (incompleteNotice !== undefined) incompleteNotice.hidden = true; }, 8000);
}
