import browser from 'webextension-polyfill';
import { createReleaseChecker, UPDATE_ORIGIN, type ReleaseCheckResult } from '../shared/release-check.ts';
import type { ExtensionSettingsStorage } from '../background/settings.ts';
import type { DisplayMode } from '../shared/settings.ts';
import {
  loadPopupState,
  setPopupEnabled,
  setPopupMode,
  type PopupReadiness,
  type PopupState
} from './controller.ts';

const storage = browser.storage.local as unknown as ExtensionSettingsStorage;
const permissions = browser.permissions as unknown as {
  contains(details: { origins: string[] }): Promise<boolean>;
};

const enabledInput = document.querySelector<HTMLInputElement>('#enabled')!;
const modeOptions = document.querySelector<HTMLFieldSetElement>('#mode-options')!;
const readinessPanel = document.querySelector<HTMLElement>('#readiness')!;
const readinessTitle = document.querySelector<HTMLElement>('#readiness-title')!;
const readinessDescription = document.querySelector<HTMLElement>(
  '#readiness-description'
)!;
const settingsButton = document.querySelector<HTMLButtonElement>('#open-settings')!;
const actionStatus = document.querySelector<HTMLParagraphElement>('#action-status')!;
const historyButton = document.querySelector<HTMLButtonElement>('#open-history')!;
const modeInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]')
);

let currentState: PopupState | undefined;

function renderReadiness(
  readiness: PopupReadiness,
  enabled: boolean,
  mode: DisplayMode
): void {
  readinessPanel.dataset.state = 'needs-setup';

  switch (readiness.kind) {
    case 'api-key-missing':
      readinessTitle.textContent = '固定界面词条可离线翻译';
      readinessDescription.textContent = '新闻标题、正文等自由文本需要配置 API Key 并授权服务商域名。';
      return;
    case 'permission-missing':
      readinessTitle.textContent = '请授权服务商域名';
      readinessDescription.textContent = `固定界面词条可离线翻译；新闻标题和正文需允许访问 ${readiness.origin}。`;
      return;
    case 'invalid-base-url':
      readinessTitle.textContent = '请检查服务商地址';
      readinessDescription.textContent = '设置页中的服务商地址无效，请修正后保存。';
      return;
    case 'permission-unavailable':
      readinessPanel.dataset.state = 'error';
      readinessTitle.textContent = '无法检查服务商权限';
      readinessDescription.textContent = '请打开设置页检查服务商权限状态。';
      return;
    case 'ready':
      readinessPanel.dataset.state = 'ready';
      readinessTitle.textContent = enabled ? '翻译已开启' : '翻译已关闭';
      readinessDescription.textContent = enabled
        ? `HLTV 使用${mode === 'A' ? '完全中文' : '双语对照'}模式；文章标题和正文通过已配置的服务商翻译。如仍为英文，请在设置页测试连接。`
        : '开启后固定界面词条可离线翻译；文章标题和正文需要有效的服务商配置。';
  }
}

function renderState(state: PopupState): void {
  currentState = state;
  enabledInput.checked = state.enabled;
  enabledInput.disabled = false;
  for (const input of modeInputs) {
    input.checked = input.value === state.mode;
    input.disabled = false;
  }
  modeOptions.disabled = false;
  renderReadiness(state.readiness, state.enabled, state.mode);
}

function showReadError(): void {
  enabledInput.disabled = true;
  modeOptions.disabled = true;
  readinessPanel.dataset.state = 'error';
  readinessTitle.textContent = '无法读取翻译设置';
  readinessDescription.textContent = '请打开完整设置页检查设置后重试。';
}

enabledInput.addEventListener('change', async () => {
  if (currentState === undefined) {
    return;
  }

  const previous = currentState.enabled;
  const enabled = enabledInput.checked;
  enabledInput.disabled = true;
  actionStatus.textContent = '';
  try {
    await setPopupEnabled(storage, enabled);
    renderState({ ...currentState, enabled });
  } catch {
    enabledInput.checked = previous;
    actionStatus.textContent = '保存失败，请重试。';
  } finally {
    enabledInput.disabled = false;
  }
});

for (const input of modeInputs) {
  input.addEventListener('change', async () => {
    if (currentState === undefined || !input.checked) {
      return;
    }

    const previous = currentState.mode;
    const mode: DisplayMode = input.value === 'B' ? 'B' : 'A';
    for (const option of modeInputs) {
      option.disabled = true;
    }
    actionStatus.textContent = '';
    try {
      await setPopupMode(storage, mode);
      renderState({ ...currentState, mode });
    } catch {
      for (const option of modeInputs) {
        option.checked = option.value === previous;
      }
      actionStatus.textContent = '保存失败，请重试。';
    } finally {
      for (const option of modeInputs) {
        option.disabled = false;
      }
    }
  });
}

settingsButton.addEventListener('click', async () => {
  settingsButton.disabled = true;
  actionStatus.textContent = '';
  try {
    await browser.runtime.openOptionsPage();
  } catch {
    actionStatus.textContent = '无法打开设置页，请从扩展管理页面打开。';
  } finally {
    settingsButton.disabled = false;
  }
});

historyButton.addEventListener('click', async () => {
  historyButton.disabled = true;
  try {
    await browser.tabs.create({ url: browser.runtime.getURL('history.html') });
  } catch {
    actionStatus.textContent = '无法打开词典历史页。';
  } finally {
    historyButton.disabled = false;
  }
});

void loadPopupState(storage, permissions)
  .then(renderState)
  .catch(showReadError);

const updateButton = document.querySelector<HTMLButtonElement>('#check-update')!;
const updateStatus = document.querySelector<HTMLElement>('#update-status')!;
const updateLink = document.querySelector<HTMLAnchorElement>('#update-link')!;
const checker = createReleaseChecker({ storage,
  hasPermission: () => browser.permissions.contains({ origins: [UPDATE_ORIGIN] }) });
function renderUpdate(result: ReleaseCheckResult): void {
  updateLink.hidden = true;
  if (result.kind === 'permission-missing') {
    updateStatus.textContent = '点击检查并允许访问 GitHub，即可开启每日新版提醒。';
  } else if (result.kind === 'failed') {
    updateStatus.textContent = '检查失败，请稍后重试。不会影响翻译功能。';
  } else if (result.kind === 'available' && result.release !== undefined) {
    updateStatus.textContent = `发现新版 v${result.release.version}。未打包扩展需手动更新。`;
    updateLink.href = result.release.url;
    updateLink.hidden = false;
  } else {
    updateStatus.textContent = `当前版本 v${browser.runtime.getManifest().version}，未发现更新版本。`;
  }
}
updateButton.addEventListener('click', async () => {
  if (updateButton.disabled) return;
  updateButton.disabled = true;
  updateStatus.textContent = '正在检查新版…';
  try {
    // Request directly inside the click gesture; the optional origin is not granted on startup.
    const granted = await browser.permissions.request({ origins: [UPDATE_ORIGIN] });
    if (!granted) renderUpdate({ kind: 'permission-missing' });
    else renderUpdate(await checker.check(browser.runtime.getManifest().version, true));
  } catch { renderUpdate({ kind: 'failed' }); }
  finally { updateButton.disabled = false; }
});
void checker.check(browser.runtime.getManifest().version).then(renderUpdate);
