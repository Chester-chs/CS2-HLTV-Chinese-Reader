import browser from 'webextension-polyfill';
import {
  DICTIONARY_HISTORY_KEY,
  DICTIONARY_FAVORITES_KEY,
  DICTIONARY_REVIEW_KEY,
  type DictionaryEntry
} from '../content/dictionary-store.ts';
import { createDictionaryClient } from '../content/dictionary-client.ts';
import { parseDictionaryTranslation, shouldShowBaseForm } from '../content/selection-translation.ts';
import { BACKUP_MAX_BYTES, parseReadingBackup, planReadingRestore, type ReadingBackup } from '../shared/reading-backup.ts';

const store = createDictionaryClient((message) => browser.runtime.sendMessage(message));
const summary = document.querySelector<HTMLElement>('#summary')!;
const entries = document.querySelector<HTMLUListElement>('#entries')!;
const clearButton = document.querySelector<HTMLButtonElement>('#clear')!;
const reviewButton = document.querySelector<HTMLButtonElement>('#review')!;
const exportButton = document.querySelector<HTMLButtonElement>('#export')!;
const backupExport = document.querySelector<HTMLButtonElement>('#backup-export')!;
const backupPanel = document.querySelector<HTMLElement>('#backup-panel')!;
const backupFile = document.querySelector<HTMLInputElement>('#backup-file')!;
const backupPreview = document.querySelector<HTMLElement>('#backup-preview')!;
const backupConfirm = document.querySelector<HTMLButtonElement>('#backup-confirm')!;
const backupStatus = document.querySelector<HTMLElement>('#backup-status')!;
let selectedBackup: ReadingBackup | undefined;
let backupRevision = 0;
let restoring = false;
const filterButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-filter]'));

type HistoryFilter = 'all' | 'favorites';
let filter: HistoryFilter = 'all';
let reviewMode = false;
let reviewIndex = 0;
let reviewSession = 0;
let reviewStarting = false;
let reviewSaving = false;
let reviewQueue: DictionaryEntry[] = [];
let reviewNotice: string | undefined;
let revealedReviewQueries = new Set<string>();
let renderRevision = 0;
const englishUi = false;

function applyLanguage(): void {
  document.documentElement.lang = englishUi ? 'en' : 'zh-CN';
  document.querySelector<HTMLElement>('#history-title')!.textContent = englishUi ? 'Dictionary history' : '词典历史';
  document.querySelector<HTMLButtonElement>('#filter-all')!.textContent = englishUi ? 'All' : '全部';
  document.querySelector<HTMLButtonElement>('#filter-favorites')!.textContent = englishUi ? 'Favorites' : '收藏';
  reviewButton.textContent = reviewMode ? (englishUi ? 'Exit review' : '退出复习') : (englishUi ? 'Start review' : '开始复习');
  exportButton.textContent = englishUi ? 'Export CSV' : '导出 CSV';
  clearButton.textContent = englishUi ? 'Clear current list' : '清空当前列表';
  document.querySelector<HTMLButtonElement>('#close')!.textContent = englishUi ? 'Close' : '关闭';
  reviewButton.disabled = reviewStarting || restoring;
  clearButton.disabled = reviewMode || reviewStarting || restoring;
  for (const button of filterButtons) button.disabled = reviewMode || reviewStarting || restoring;
}

function renderEntry(item: DictionaryEntry, favorite: boolean): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'entry';
  const content = document.createElement('div');
  const query = document.createElement('strong');
  query.className = 'entry-query';
  query.textContent = item.query;
  const translation = document.createElement('span');
  translation.className = 'entry-translation';
  translation.textContent = modelTranslationText(item.translated);
  const meta = document.createElement('span');
  meta.className = 'entry-meta';
  const baseForm = providerBaseForm(item);
  meta.textContent = [
    baseForm === undefined ? (englishUi ? 'Dictionary lookup' : '词典查询') : `${englishUi ? 'Base form' : '动词原形'}：${baseForm}`,
    item.difficulty === undefined ? '' : `CEFR 参考等级（模型）：${item.difficulty}`,
    item.pinyin === undefined ? '' : `${englishUi ? 'Pinyin' : '拼音'}：${item.pinyin}`
  ].filter(Boolean).join(' · ');
  content.append(query, translation, meta);

  const favoriteButton = document.createElement('button');
  favoriteButton.type = 'button';
  favoriteButton.className = 'entry-favorite';
  favoriteButton.textContent = favorite ? '★' : '☆';
  favoriteButton.setAttribute('aria-label', favorite ? '取消收藏' : '收藏');
  favoriteButton.addEventListener('click', async () => {
    if (favoriteButton.disabled) return;
    favoriteButton.disabled = true;
    try {
      await store.setFavorite(item, !favorite);
      await render();
    } catch {
      summary.textContent = '收藏保存失败，请重试。';
    } finally {
      favoriteButton.disabled = false;
    }
  });
  row.append(content, favoriteButton);
  return row;
}

function renderReviewEntry(item: DictionaryEntry, favorite: boolean, total: number): HTMLLIElement {
  const row = renderEntry(item, favorite);
  row.classList.add('review-entry');
  const content = row.firstElementChild;
  if (content !== null) {
    const session = reviewSession;
    const index = reviewIndex;
    const answerFields = Array.from(content.querySelectorAll('.entry-translation, .entry-meta'));
    const queryKey = item.query.trim().toLowerCase();
    if (!revealedReviewQueries.has(queryKey)) {
      for (const field of answerFields) field.remove();
      const answer = document.createElement('button');
      answer.type = 'button';
      answer.className = 'review-answer';
      answer.textContent = englishUi ? 'Show answer' : '显示答案';
      answer.addEventListener('click', () => {
        revealedReviewQueries.add(queryKey);
        answer.replaceWith(...answerFields);
      });
      content.appendChild(answer);
    }
    const controls = document.createElement('div');
    controls.className = 'review-controls';
    for (const [label, remembered] of [[englishUi ? 'Remembered' : '记住了', true], [englishUi ? 'Review later' : '稍后复习', false]] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = reviewSaving;
      button.addEventListener('click', async () => {
        if (reviewSaving || !reviewMode || session !== reviewSession || index !== reviewIndex) return;
        reviewSaving = true;
        for (const control of controls.querySelectorAll('button')) control.disabled = true;
        try {
          await store.recordReview(item.query, remembered);
          if (reviewMode && session === reviewSession && index === reviewIndex) {
            reviewIndex += 1;
            reviewSaving = false;
            await render();
          }
        } catch {
          if (reviewMode && session === reviewSession) summary.textContent = '复习记录保存失败，请重试；未跳过当前单词。';
        } finally {
          if (session === reviewSession) {
            reviewSaving = false;
            for (const control of entries.querySelectorAll<HTMLButtonElement>('.review-controls button')) control.disabled = false;
          }
        }
      });
      controls.appendChild(button);
    }
    content.appendChild(controls);
  }
  summary.textContent = englishUi ? `Review ${Math.min(reviewIndex + 1, total)} / ${total}` : `复习 ${Math.min(reviewIndex + 1, total)} / ${total}`;
  return row;
}

function modelTranslationText(text: string): string {
  // Old saved/provider responses remain readable without implying Oxford data.
  return text.replace(
    /(?:Oxford\s*(?:\/\s*CEFR)?|牛津(?:词典)?)\s*(?:难度|等级|level|difficulty)\s*[:：]?\s*((?:A|B|C)[12]|未知|unknown)/giu,
    'CEFR 参考等级（模型）：$1'
  );
}

function providerBaseForm(item: DictionaryEntry): string | undefined {
  // Legacy metadata can contain the removed ed-stripping guess. Only display
  // a lemma actually present in the saved provider response; keep raw records.
  const base = parseDictionaryTranslation(item.translated).baseForm;
  return base !== undefined && shouldShowBaseForm(item.query, base) ? base : undefined;
}

async function render(): Promise<void> {
  const revision = ++renderRevision;
  try {
    const [history, favorites] = await Promise.all([
      store.listHistory(),
      store.listFavorites()
    ]);
    if (revision !== renderRevision) return;
    const favoriteQueries = new Set(favorites.map((item) => item.query.toLocaleLowerCase()));
    const visible = filter === 'favorites' ? favorites : history;
    summary.textContent = englishUi ? `${history.length} history · ${favorites.length} favorites` : `${history.length} 条历史 · ${favorites.length} 个收藏`;
    entries.replaceChildren();
    if (reviewMode) {
      if (reviewQueue.length === 0 || reviewIndex >= reviewQueue.length) {
        reviewMode = false;
        reviewIndex = 0;
        reviewSession += 1;
        reviewSaving = false;
        applyLanguage();
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = reviewQueue.length === 0
          ? (englishUi ? 'Favorite a word before starting review.' : '请先收藏词条，再开始复习。')
          : (englishUi ? 'Review complete.' : '本轮复习完成。');
        entries.appendChild(empty);
        return;
      }
      entries.appendChild(renderReviewEntry(
        reviewQueue[reviewIndex]!,
        favoriteQueries.has(reviewQueue[reviewIndex]!.query.toLocaleLowerCase()),
        reviewQueue.length
      ));
      return;
    }
    if (reviewNotice !== undefined) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = reviewNotice;
      entries.appendChild(empty);
      summary.textContent = `${favorites.length} 个收藏 · 当前没有到期词条`;
      return;
    }
    if (visible.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = filter === 'favorites'
        ? (englishUi ? 'No favorites yet.' : '还没有收藏词条。')
        : (englishUi ? 'No dictionary history yet.' : '还没有词典查询记录。');
      entries.appendChild(empty);
      return;
    }
    for (const item of visible) {
      entries.appendChild(renderEntry(item, favoriteQueries.has(item.query.toLocaleLowerCase())));
    }
  } catch {
    if (revision === renderRevision) {
      summary.textContent = '记录读取失败，请重新加载插件后再打开历史页；已有记录不会被清空。';
    }
  }
}

for (const button of filterButtons) {
  button.addEventListener('click', () => {
    reviewNotice = undefined;
    filter = button.dataset.filter === 'favorites' ? 'favorites' : 'all';
    for (const item of filterButtons) {
      item.classList.toggle('active', item === button);
    }
    void render();
  });
}

reviewButton.addEventListener('click', async () => {
  if (reviewStarting) return;
  renderRevision += 1;
  reviewNotice = undefined;
  const session = ++reviewSession;
  reviewSaving = false;
  revealedReviewQueries = new Set();
  if (reviewMode) {
    reviewMode = false;
    reviewQueue = [];
    reviewIndex = 0;
    applyLanguage();
    await render();
    return;
  }
  reviewStarting = true;
  applyLanguage();
  try {
    const [favorites, reviewState] = await Promise.all([store.listFavorites(), store.listReview()]);
    if (session !== reviewSession) return;
    const now = Date.now();
    reviewIndex = 0;
    reviewQueue = favorites.filter((item) => {
      const state = reviewState[item.query.trim().toLowerCase()];
      return state === undefined || state.dueAt <= now;
    }).sort((left, right) => {
      const leftDue = reviewState[left.query.trim().toLowerCase()]?.dueAt ?? 0;
      const rightDue = reviewState[right.query.trim().toLowerCase()]?.dueAt ?? 0;
      return leftDue - rightDue;
    });
    if (favorites.length > 0 && reviewQueue.length === 0) {
      reviewMode = false;
      const nextDue = Math.min(...favorites.map((item) => reviewState[item.query.trim().toLowerCase()]!.dueAt));
      reviewNotice = `当前没有到期词条，下次复习时间：${new Date(nextDue).toLocaleString('zh-CN')}。`;
    } else {
      reviewMode = true;
    }
  } catch {
    summary.textContent = '收藏读取失败，无法开始复习，请重试。';
    return;
  } finally {
    reviewStarting = false;
    applyLanguage();
  }
  await render();
});

exportButton.addEventListener('click', async () => {
  if (exportButton.disabled) return;
  exportButton.disabled = true;
  const favoritesOnly = reviewMode || filter === 'favorites';
  try {
    const [history, favorites] = await Promise.all([store.listHistory(), store.listFavorites()]);
    const exportEntries = favoritesOnly ? favorites : Array.from(new Map(
      [...favorites, ...history].map((item) => [item.query.trim().toLowerCase(), item])
    ).values());
    const rows = [
      ['query', 'translation', 'baseForm', 'difficulty', 'pinyin', 'favorite'],
      ...exportEntries.map((item) => [
        item.query,
        modelTranslationText(item.translated),
        providerBaseForm(item) ?? '',
        item.difficulty ?? '',
        item.pinyin ?? '',
        favorites.some((favorite) => favorite.query.toLocaleLowerCase() === item.query.toLocaleLowerCase()) ? 'yes' : 'no'
      ])
    ];
    const csv = rows
      .map((row) => row.map((cell) => {
        // Quoting alone does not stop spreadsheets evaluating formula-like text.
        const safeCell = /^[\s]*[=+@-]/u.test(cell) || /^[\t\r]/u.test(cell) ? `'${cell}` : cell;
        return `"${safeCell.replace(/"/gu, '""')}"`;
      }).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'hltv-dictionary.csv';
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    summary.textContent = '记录导出失败，请重试。';
  } finally {
    exportButton.disabled = false;
  }
});

clearButton.addEventListener('click', async () => {
  if (clearButton.disabled || reviewMode || reviewStarting) return;
  reviewNotice = undefined;
  clearButton.disabled = true;
  try {
    if (filter === 'favorites') {
      await store.clearFavorites();
    } else {
      await store.clearHistory();
    }
    await render();
  } catch {
    summary.textContent = '记录清空失败，请重试。';
  } finally {
    clearButton.disabled = reviewMode || reviewStarting;
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (Object.hasOwn(changes, DICTIONARY_HISTORY_KEY) || Object.hasOwn(changes, DICTIONARY_FAVORITES_KEY) || Object.hasOwn(changes, DICTIONARY_REVIEW_KEY))) {
    if (Object.hasOwn(changes, DICTIONARY_FAVORITES_KEY) || Object.hasOwn(changes, DICTIONARY_REVIEW_KEY)) reviewNotice = undefined;
    void render();
  }
});

document.querySelector<HTMLButtonElement>('#close')?.addEventListener('click', () => window.close());
backupExport.addEventListener('click', async () => {
  if (backupExport.disabled) return;
  backupExport.disabled = true;
  try {
    const backup = await store.exportBackup();
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `HLTV-reading-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    backupStatus.textContent = '备份已导出，请妥善保管。';
  } catch {
    backupStatus.textContent = '备份导出失败，请重试；已有数据没有被修改。';
  } finally { backupExport.disabled = false; }
});
document.querySelector<HTMLButtonElement>('#backup-open')!.addEventListener('click', () => {
  backupPanel.hidden = false;
  backupFile.focus();
});
document.querySelector<HTMLButtonElement>('#backup-close')!.addEventListener('click', () => {
  if (restoring) return;
  backupRevision += 1;
  selectedBackup = undefined;
  backupConfirm.disabled = true;
  backupFile.value = '';
  backupPanel.hidden = true;
});
async function previewBackup(): Promise<void> {
  const revision = ++backupRevision;
  backupConfirm.disabled = true;
  const file = backupFile.files?.[0];
  selectedBackup = undefined;
  if (file === undefined) return;
  try {
    if (file.size > BACKUP_MAX_BYTES) throw new Error('备份文件过大（最多 32 MB）。');
    const parsed = parseReadingBackup(JSON.parse(await file.text()) as unknown);
    if (parsed === undefined) throw new Error('文件不是有效的阅读备份，或备份版本不受支持。');
    const current = await store.exportBackup();
    if (revision !== backupRevision) return;
    const mode = document.querySelector<HTMLInputElement>('input[name="backup-mode"]:checked')!.value === 'replace' ? 'replace' : 'merge';
    const plan = planReadingRestore(current, parsed, mode);
    selectedBackup = parsed;
    backupPreview.textContent = `备份：${parsed.history.length} 条历史、${parsed.favorites.length} 个收藏；恢复后：${plan.report.history} 条历史、${plan.report.favorites} 个收藏。${plan.report.omitted > 0 ? `超出容量的 ${plan.report.omitted} 条记录不会导入。` : ''}${mode === 'replace' ? '注意：当前历史、收藏和复习进度将被覆盖。' : '当前同名词条和复习进度会保留。'}`;
    backupConfirm.disabled = false;
  } catch (error) {
    if (revision === backupRevision) backupPreview.textContent = error instanceof Error ? error.message : '备份读取失败。';
  }
}
backupFile.addEventListener('change', () => void previewBackup());
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="backup-mode"]')) {
  input.addEventListener('change', () => void previewBackup());
}
backupConfirm.addEventListener('click', async () => {
  if (selectedBackup === undefined || restoring || backupConfirm.disabled) return;
  const mode = document.querySelector<HTMLInputElement>('input[name="backup-mode"]:checked')!.value === 'replace' ? 'replace' : 'merge';
  if (mode === 'replace' && !window.confirm('用备份替换当前历史、收藏和复习进度？建议先导出当前备份。')) return;
  restoring = true;
  applyLanguage();
  backupConfirm.disabled = true;
  backupFile.disabled = true;
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="backup-mode"]')) input.disabled = true;
  try {
    reviewSession += 1;
    reviewMode = false;
    reviewNotice = undefined;
    const report = await store.importBackup(selectedBackup, mode);
    backupStatus.textContent = `恢复完成：${report.history} 条历史、${report.favorites} 个收藏。${report.omitted > 0 ? `容量限制：${report.omitted} 条未导入。` : ''}`;
    backupPanel.hidden = true;
    selectedBackup = undefined;
    backupFile.value = '';
    applyLanguage();
    await render();
  } catch {
    backupStatus.textContent = '恢复失败，请重试；未清空已有数据。复习已退出，可重新开始。';
    applyLanguage();
    await render();
    backupConfirm.disabled = false;
  } finally {
    restoring = false;
    applyLanguage();
    backupFile.disabled = false;
    for (const input of document.querySelectorAll<HTMLInputElement>('input[name="backup-mode"]')) input.disabled = false;
  }
});
void (async () => {
  applyLanguage();
  await render();
})();
