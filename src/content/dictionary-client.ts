import { parseDictionaryEntry, parseDictionaryReviewState, type DictionaryEntry, type createDictionaryStore } from './dictionary-store.ts';
import { DICTIONARY_MESSAGE_TYPE, type DictionaryRequest } from '../shared/dictionary-messages.ts';
import { parseReadingBackup, type ReadingBackup, type BackupImportMode, type BackupImportReport } from '../shared/reading-backup.ts';

export function createDictionaryClient(send: (message: DictionaryRequest) => Promise<unknown>):
  ReturnType<typeof createDictionaryStore> & {
    exportBackup(): Promise<ReadingBackup>;
    importBackup(backup: ReadingBackup, importMode: BackupImportMode): Promise<BackupImportReport>;
  } {
  async function request(action: DictionaryRequest['action'], values: Partial<DictionaryRequest> = {}): Promise<unknown> {
    const response = await send({ ...values, type: DICTIONARY_MESSAGE_TYPE, action });
    if (typeof response !== 'object' || response === null) throw new Error('词典后台未响应，请重新加载插件并刷新网页。');
    const result = response as Record<string, unknown>;
    if (result.ok !== true) throw new Error(typeof result.message === 'string' ? result.message : '词典记录操作失败。');
    return result.value;
  }
  async function list(action: 'list-history' | 'list-favorites'): Promise<DictionaryEntry[]> {
    const value = await request(action);
    if (!Array.isArray(value)) throw new Error('词典记录格式错误。');
    return value.map((item) => {
      const entry = parseDictionaryEntry(item);
      if (entry === undefined) throw new Error('词典记录格式错误。');
      return entry;
    });
  }
  async function boolean(action: 'toggle-favorite' | 'is-favorite' | 'set-favorite', values: Partial<DictionaryRequest>): Promise<boolean> {
    const value = await request(action, values);
    if (typeof value !== 'boolean') throw new Error('词典收藏状态格式错误。');
    return value;
  }
  return {
    async exportBackup() {
      const backup = parseReadingBackup(await request('export-backup'));
      if (backup === undefined) throw new Error('备份格式错误。');
      return backup;
    },
    async importBackup(backup, importMode) {
      const value = await request('import-backup', { backup, importMode });
      if (typeof value !== 'object' || value === null || !['history', 'favorites', 'omitted'].every((key) =>
        Number.isInteger((value as Record<string, unknown>)[key]) && ((value as Record<string, number>)[key] ?? -1) >= 0)) throw new Error('恢复结果格式错误。');
      return value as BackupImportReport;
    },
    async recordHistory(entry) { await request('record-history', { entry }); },
    listHistory: () => list('list-history'),
    toggleFavorite: (entry) => boolean('toggle-favorite', { entry }),
    setFavorite: (entry, favorite) => boolean('set-favorite', { entry, favorite }),
    isFavorite: (query) => boolean('is-favorite', { query }),
    listFavorites: () => list('list-favorites'),
    async clearHistory() { await request('clear-history'); },
    async clearFavorites() { await request('clear-favorites'); },
    async recordReview(query, remembered) { await request('record-review', { query, remembered }); },
    async listReview() {
      const value = await request('list-review');
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('复习记录格式错误。');
      return parseDictionaryReviewState(value);
    }
  };
}
