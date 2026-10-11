import browser from 'webextension-polyfill';
import { createIndexedDbCacheStore } from '../background/cache-store.ts';
import { loadSettings, type ExtensionSettingsStorage } from '../background/settings.ts';
import {
  PROVIDER_PRESETS,
  type ExtensionSettings,
  type ProviderPreset
} from '../shared/settings.ts';
import {
  authorizeProviderOrigin,
  getProviderPermissionStatus,
  saveOptionsSettings,
  type OptionalHostPermissions,
  type OptionsSettingsStorage
} from './settings-service.ts';
import { testProviderConnection } from './connection-test.ts';

const storage = browser.storage.local as unknown as ExtensionSettingsStorage & OptionsSettingsStorage;
const permissions = browser.permissions as unknown as OptionalHostPermissions & {
  onAdded: { addListener(listener: () => void): void };
  onRemoved: { addListener(listener: () => void): void };
};

const enabledInput = document.querySelector<HTMLInputElement>('#enabled')!;
const modeInput = document.querySelector<HTMLSelectElement>('#mode')!;
const presetInput = document.querySelector<HTMLSelectElement>('#provider-preset')!;
const baseURLInput = document.querySelector<HTMLInputElement>('#base-url')!;
const modelInput = document.querySelector<HTMLInputElement>('#model')!;
const translationStyleInput = document.querySelector<HTMLSelectElement>('#translation-style')!;
const apiKeyInput = document.querySelector<HTMLInputElement>('#api-key')!;
const jsonOutputInput = document.querySelector<HTMLInputElement>('#json-output')!;
const fallbackEnabledInput = document.querySelector<HTMLInputElement>('#fallback-enabled')!;
const fallbackBaseURLInput = document.querySelector<HTMLInputElement>('#fallback-base-url')!;
const fallbackModelInput = document.querySelector<HTMLInputElement>('#fallback-model')!;
const fallbackApiKeyInput = document.querySelector<HTMLInputElement>('#fallback-api-key')!;
const permissionStatus = document.querySelector<HTMLParagraphElement>('#permission-status')!;
const authorizeButton = document.querySelector<HTMLButtonElement>('#authorize')!;
const statusLine = document.querySelector<HTMLParagraphElement>('#status')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const testButton = document.querySelector<HTMLButtonElement>('#test-connection')!;
const clearButton = document.querySelector<HTMLButtonElement>('#clear-cache')!;
const toggleKeyButton = document.querySelector<HTMLButtonElement>('#toggle-key')!;
const settingsForm = document.querySelector<HTMLFormElement>('#settings-form')!;
const privacyNote = document.querySelector<HTMLElement>('#privacy-note')!;
const cacheStore = createIndexedDbCacheStore();

let permissionCheckId = 0;
let enabledDirty = false;
let modeDirty = false;
const optionsCopy: Record<string, [string, string]> = {
  'options-title': ['Translation settings', '翻译设置'],
  'interface-language-title': ['Interface language', '界面语言'],
  'interface-language-help': ['Choose the extension language first.', '先选择插件界面语言，再继续设置。'],
  'privacy-note': ['Your API key stays in this browser\'s browser.storage.local. It is sent only to the provider you configure; the extension developer never receives it.', 'API Key 仅保存在此浏览器的 browser.storage.local，不会同步到云端或发送给扩展开发者。翻译或测试连接时，扩展会将它发送给你配置的服务商。扩展只申请你配置域名的访问权限。'],
  enabled: ['Enable translation', '启用翻译'],
  'mode-label': ['Page display mode', '显示模式'],
  'mode-a': ['Mode A: Full Chinese', '模式 A：完全翻译'],
  'mode-b': ['Mode B: Bilingual', '模式 B：双语对照'],
  'provider-preset-label': ['Provider preset', '服务商预设'],
  'custom-provider': ['Custom', '自定义'],
  'base-url-label': ['baseURL', 'baseURL'],
  'model-label': ['Model', '模型名'],
  'translation-style-label': ['Translation style', '翻译风格'],
  'translation-style-natural': ['Natural Chinese', '自然中文：更像中文网站'],
  'translation-style-literal': ['Literal translation', '直译：尽量贴近英文结构'],
  'api-key-label': ['API key', 'API Key'],
  'api-key-help': ['Fixed labels work offline. News titles and prose need an API key, provider permission, and network access.', '主导航和已收录的固定标签可离线翻译。新闻标题、正文等自由文本需要有效 API Key、服务商域名授权和网络连接。'],
  'show-key': ['Show', '显示'],
  'json-mode': ['Use JSON output mode (recommended)', '使用 JSON 输出模式（推荐）'],
  'json-help': ['If the provider rejects response_format, turn this off and retry. The model must still return JSON.', '若服务商不支持 response_format 并因此报错，可取消勾选。关闭后扩展仍要求模型只输出 JSON。'],
  'fallback-enabled': ['Enable fallback provider', '启用备用翻译服务'],
  'fallback-help': ['Try the fallback provider when the primary fails. It needs its own permission and API key.', '主服务商失败时自动尝试备用服务商；备用服务商需要单独授权和 API Key。'],
  'fallback-base-url-label': ['Fallback baseURL', '备用 baseURL'],
  'fallback-model-label': ['Fallback model', '备用模型名'],
  'fallback-api-key-label': ['Fallback API key', '备用 API Key'],
  'permission-title': ['Provider origin permission', '服务商域名权限'],
  authorize: ['Authorize', '授权'],
  save: ['Save', '保存'],
  'test-connection': ['Test connection', '测试连接'],
  'clear-cache': ['Clear translation cache', '清空翻译缓存']
};

function isEnglishUi(): boolean {
  return false;
}

function applyLanguage(): void {
  const english = isEnglishUi();
  document.documentElement.lang = english ? 'en' : 'zh-CN';
  document.title = english ? 'CS2 HLTV Translation Settings' : 'CS2 HLTV 翻译设置';
  for (const [id, [en, zh]] of Object.entries(optionsCopy)) {
    const node = document.querySelector<HTMLElement>(`[data-i18n="${id}"]`);
    if (node !== null) node.textContent = english ? en : zh;
  }
  toggleKeyButton.textContent = apiKeyInput.type === 'password' ? (english ? 'Show' : '显示') : (english ? 'Hide' : '隐藏');
}

function setConfigurationVisible(visible: boolean): void {
  settingsForm.hidden = !visible;
  privacyNote.hidden = !visible;
}

function readDraft(): ExtensionSettings {
  return {
    enabled: enabledInput.checked,
    mode: modeInput.value === 'B' ? 'B' : 'A',
    providerPreset: presetInput.value as ProviderPreset,
    baseURL: baseURLInput.value.trim(),
    model: modelInput.value.trim(),
    translationStyle: translationStyleInput.value === 'literal' ? 'literal' : 'natural',
    apiKey: apiKeyInput.value,
    useJsonOutputMode: jsonOutputInput.checked,
    fallbackEnabled: fallbackEnabledInput.checked,
    fallbackBaseURL: fallbackBaseURLInput.value.trim(),
    fallbackModel: fallbackModelInput.value.trim(),
    fallbackApiKey: fallbackApiKeyInput.value
  };
}

function renderSettings(settings: ExtensionSettings): void {
  enabledInput.checked = settings.enabled;
  modeInput.value = settings.mode;
  presetInput.value = settings.providerPreset;
  baseURLInput.value = settings.baseURL;
  baseURLInput.readOnly = settings.providerPreset !== 'custom';
  modelInput.value = settings.model;
  translationStyleInput.value = settings.translationStyle;
  apiKeyInput.value = settings.apiKey;
  jsonOutputInput.checked = settings.useJsonOutputMode;
  fallbackEnabledInput.checked = settings.fallbackEnabled === true;
  fallbackBaseURLInput.value = settings.fallbackBaseURL ?? '';
  fallbackModelInput.value = settings.fallbackModel ?? '';
  fallbackApiKeyInput.value = settings.fallbackApiKey ?? '';
}

function missingPermissionText(origin: string): string {
  return isEnglishUi()
    ? `Access to ${origin} is not authorized; translation will not work.`
    : `未授权访问 ${origin}，翻译将无法工作。`;
}

async function refreshPermissionStatus(): Promise<void> {
  const currentCheckId = ++permissionCheckId;
  const status = await getProviderPermissionStatus(baseURLInput.value, permissions);
  if (currentCheckId !== permissionCheckId) {
    return;
  }

  if (status.state === 'granted') {
    permissionStatus.textContent = isEnglishUi() ? `Authorized: ${status.origin}` : `已授权：${status.origin}`;
    authorizeButton.hidden = true;
  } else if (status.state === 'missing') {
    permissionStatus.textContent = isEnglishUi() ? `Permission required: ${status.origin}` : `当前配置缺少权限：${status.origin}`;
    authorizeButton.hidden = false;
  } else if (status.state === 'invalid') {
    permissionStatus.textContent = isEnglishUi() ? 'Enter a valid HTTPS or loopback HTTP baseURL.' : '请输入有效的 HTTPS 或回环 HTTP baseURL。';
    authorizeButton.hidden = true;
  } else {
    permissionStatus.textContent = isEnglishUi() ? 'Unable to read the current origin permission.' : '无法读取当前域名权限状态。';
    authorizeButton.hidden = true;
  }
}

function connectionFailureMessage(reason: string, status?: number): string {
  if (isEnglishUi()) {
    switch (reason) {
      case 'permission': return 'Permission is missing. Click Authorize first.';
      case 'timeout': return 'Connection timed out. Check the provider response time.';
      case 'unauthorized': return `Connection failed: HTTP ${status ?? 401}. Authentication was rejected.`;
      case 'network': return 'Network is unreachable. Check your connection and provider address.';
      case 'response-format-unsupported': return 'The provider rejected response_format. Turn off JSON output mode and retry.';
      case 'http-error': return `Connection failed: provider returned HTTP ${status ?? 'error'}.`;
      case 'invalid-response': return 'The provider returned an unrecognized response.';
      default: return 'Enter a valid HTTPS or loopback HTTP baseURL.';
    }
  }
  switch (reason) {
    case 'permission':
      return '当前配置缺少权限，请先点击“授权”。';
    case 'timeout':
      return '连接测试超时，请检查服务商响应时间。';
    case 'unauthorized':
      return `连接失败：HTTP ${status ?? 401}，身份验证未通过。`;
    case 'network':
      return '网络不可达，请检查网络和服务商地址。';
    case 'response-format-unsupported':
      return '服务商不支持 response_format。请取消勾选“使用 JSON 输出模式”后重试。';
    case 'http-error':
      return `连接失败：服务商返回 HTTP ${status ?? '错误'}。`;
    case 'invalid-response':
      return '服务商返回了无法识别的响应。';
    default:
      return '请填写有效的 HTTPS 或回环 HTTP baseURL。';
  }
}

function applyPreset(): void {
  const preset = presetInput.value as ProviderPreset;
  baseURLInput.readOnly = preset !== 'custom';
  if (preset === 'deepseek' || preset === 'openai') {
    baseURLInput.value = PROVIDER_PRESETS[preset].baseURL;
    modelInput.value = PROVIDER_PRESETS[preset].model;
  }
  void refreshPermissionStatus();
}

presetInput.addEventListener('change', applyPreset);
baseURLInput.addEventListener('input', () => void refreshPermissionStatus());
enabledInput.addEventListener('change', () => {
  enabledDirty = true;
});
modeInput.addEventListener('change', () => {
  modeDirty = true;
});

toggleKeyButton.addEventListener('click', () => {
  const show = apiKeyInput.type === 'password';
  apiKeyInput.type = show ? 'text' : 'password';
  toggleKeyButton.textContent = show ? '隐藏' : '显示';
});

authorizeButton.addEventListener('click', async () => {
  authorizeButton.disabled = true;
  const result = await authorizeProviderOrigin(baseURLInput.value, permissions);
  authorizeButton.disabled = false;
  if (result.state === 'granted') {
    statusLine.textContent = isEnglishUi() ? `Authorized ${result.origin}.` : `已授权 ${result.origin}。`;
    try {
      await storage.set({ permissionRevision: Date.now() });
    } catch {
      statusLine.textContent = '域名已授权，但权限状态标记保存失败，请重试。';
    }
  } else if (result.state === 'denied' && result.origin !== undefined) {
    statusLine.textContent = missingPermissionText(result.origin);
  } else {
    statusLine.textContent = isEnglishUi() ? 'Authorization did not finish. Check the baseURL and retry.' : '授权未完成，请检查 baseURL 后重试。';
  }
  await refreshPermissionStatus();
});

document.querySelector<HTMLFormElement>('#settings-form')!.addEventListener(
  'submit',
  async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    const draft = readDraft();
    let latest: ExtensionSettings;
    try {
      latest = await loadSettings(storage);
    } catch {
      saveButton.disabled = false;
      statusLine.textContent = '无法读取最新设置，本次未保存；请重试，避免覆盖另一页面的修改。';
      return;
    }
    const result = await saveOptionsSettings({
      ...draft,
      enabled: enabledDirty ? draft.enabled : latest.enabled,
      mode: modeDirty ? draft.mode : latest.mode
    }, storage, permissions);
    saveButton.disabled = false;

    if (result.ok) {
      statusLine.textContent = isEnglishUi() ? 'Settings saved.' : '设置已保存。';
      enabledDirty = false;
      modeDirty = false;
      try {
        await storage.set({ permissionRevision: Date.now() });
      } catch {
        statusLine.textContent = '设置已保存，但权限状态标记保存失败；请刷新 HLTV 后检查连接。';
      }
      if (fallbackEnabledInput.checked && fallbackBaseURLInput.value.trim().length > 0) {
        const fallbackPermission = await authorizeProviderOrigin(fallbackBaseURLInput.value, permissions);
        if (fallbackPermission.state !== 'granted') {
          statusLine.textContent = isEnglishUi() ? 'Primary service saved, but the fallback origin is not authorized.' : '主服务已保存，但备用服务商域名尚未授权。';
        }
      }
      await refreshPermissionStatus();
      return;
    }

    if (result.reason === 'permission-denied' && result.origin !== undefined) {
      statusLine.textContent = missingPermissionText(result.origin);
    } else if (result.reason === 'invalid-fallback') {
      statusLine.textContent = '备用服务未保存：请填写有效的 HTTPS 或回环 HTTP baseURL、模型名和 API Key，或关闭备用服务。';
    } else if (result.reason === 'invalid-base-url') {
      statusLine.textContent = isEnglishUi() ? 'Enter a valid HTTPS or loopback HTTP baseURL.' : '请填写有效的 HTTPS 或回环 HTTP baseURL。';
    } else {
      statusLine.textContent = isEnglishUi() ? 'Settings were not saved. Check permissions and retry.' : '设置未保存，请检查权限状态后重试。';
    }
    await refreshPermissionStatus();
  }
);

testButton.addEventListener('click', async () => {
  testButton.disabled = true;
  statusLine.textContent = isEnglishUi() ? 'Testing connection…' : '正在测试连接…';
  const result = await testProviderConnection(readDraft(), permissions);
  testButton.disabled = false;
  statusLine.textContent = result.ok
    ? (isEnglishUi() ? 'Connection succeeded.' : '连接成功。')
    : connectionFailureMessage(result.reason, result.status);
});

clearButton.addEventListener('click', async () => {
  clearButton.disabled = true;
  try {
    const deletedCount = await cacheStore.clear();
    statusLine.textContent = isEnglishUi() ? `Cleared ${deletedCount} translation cache entries.` : `已清除 ${deletedCount} 条翻译缓存。`;
  } catch {
    statusLine.textContent = isEnglishUi() ? 'Could not clear the translation cache. Try again later.' : '清空翻译缓存失败，请稍后重试。';
  } finally {
    clearButton.disabled = false;
  }
});

permissions.onAdded.addListener(() => void refreshPermissionStatus());
permissions.onRemoved.addListener(() => void refreshPermissionStatus());

void (async () => {
  try {
    const settings = await loadSettings(storage);
    applyLanguage();
    setConfigurationVisible(true);
    renderSettings(settings);
    await refreshPermissionStatus();
  } catch {
    applyLanguage();
    setConfigurationVisible(false);
    statusLine.textContent = '设置读取失败，请重试。';
    return;
  }
})();
