import { parseDictionaryEntry, parseDictionaryReviewState, type DictionaryEntry, type DictionaryReviewState } from '../content/dictionary-store.ts';
import { DEFAULT_CONTENT_SETTINGS, type ThemeMode, type CardColor } from './settings.ts';

export const BACKUP_MAX_BYTES = 32 * 1024 * 1024;
export const READING_KEYS = ['dictionaryHistory', 'dictionaryFavorites', 'dictionaryReviewState', 'theme', 'cardColor', 'fontScale'] as const;
export interface ReadingBackup {
  format: 'cs2-hltv-zh-reader-backup';
  version: 1;
  exportedAt: number;
  history: DictionaryEntry[];
  favorites: DictionaryEntry[];
  review: DictionaryReviewState;
  appearance: { theme: ThemeMode; cardColor: CardColor; fontScale: number };
}
export type BackupImportMode = 'merge' | 'replace';
export interface BackupImportReport { history: number; favorites: number; omitted: number }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const normalized = (query: string): string => query.trim().toLowerCase();

function entries(value: unknown, limit: number): DictionaryEntry[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return undefined;
  const result: DictionaryEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = parseDictionaryEntry(item);
    if (parsed === undefined || parsed.query.length > 2000 || parsed.translated.length > 100000 ||
        !Number.isFinite(parsed.savedAt) || parsed.savedAt < 0 || !record(item) || typeof item.savedAt !== 'number' ||
        ['baseForm', 'englishMeaning', 'difficulty', 'pinyin'].some((key) =>
          item[key] !== undefined && (typeof item[key] !== 'string' || (item[key] as string).length > 100000)) ||
        (item.examples !== undefined && (!Array.isArray(item.examples) || item.examples.length > 20 ||
          item.examples.some((example) => typeof example !== 'string' || example.length > 10000))) || seen.has(normalized(parsed.query))) return undefined;
    seen.add(normalized(parsed.query));
    result.push(parsed);
  }
  return result;
}

export function parseReadingBackup(value: unknown): ReadingBackup | undefined {
  if (!record(value) || value.format !== 'cs2-hltv-zh-reader-backup' || value.version !== 1 ||
      typeof value.exportedAt !== 'number' || !Number.isFinite(value.exportedAt) || value.exportedAt < 0 ||
      !record(value.appearance) || !record(value.review)) return undefined;
  const history = entries(value.history, 50);
  const favorites = entries(value.favorites, 100);
  if (history === undefined || favorites === undefined) return undefined;
  const { theme, cardColor, fontScale } = value.appearance;
  if ((theme !== 'system' && theme !== 'light' && theme !== 'dark') ||
      !['neutral', 'blue', 'green', 'sand', 'rose'].includes(cardColor as string) ||
      typeof fontScale !== 'number' || !Number.isFinite(fontScale) || fontScale < 0.8 || fontScale > 1.25) return undefined;
  const favoriteQueries = new Set(favorites.map((item) => normalized(item.query)));
  for (const [key, review] of Object.entries(value.review)) {
    if (key !== normalized(key) || !favoriteQueries.has(key) || !record(review) ||
        typeof review.dueAt !== 'number' || !Number.isFinite(review.dueAt) || review.dueAt < 0 ||
        typeof review.interval !== 'number' || !Number.isInteger(review.interval) || review.interval < 0 || review.interval > 30) return undefined;
  }
  const backup: ReadingBackup = { format: 'cs2-hltv-zh-reader-backup', version: 1, exportedAt: value.exportedAt,
    history, favorites, review: parseDictionaryReviewState(value.review), appearance: { theme, cardColor: cardColor as CardColor, fontScale } };
  if (new TextEncoder().encode(JSON.stringify(backup)).length > BACKUP_MAX_BYTES) return undefined;
  return backup;
}

export function createReadingBackup(values: Record<string, unknown>, now = Date.now()): ReadingBackup {
  const history = entries(values.dictionaryHistory ?? [], 50);
  const favorites = entries(values.dictionaryFavorites ?? [], 100);
  if (history === undefined || favorites === undefined) throw new Error('记录格式错误，无法创建备份。');
  const review = parseDictionaryReviewState(values.dictionaryReviewState);
  const queries = new Set(favorites.map((item) => normalized(item.query)));
  for (const key of Object.keys(review)) if (!queries.has(key)) delete review[key];
  const backup = parseReadingBackup({ format: 'cs2-hltv-zh-reader-backup', version: 1, exportedAt: now,
    history, favorites, review, appearance: {
      theme: values.theme ?? DEFAULT_CONTENT_SETTINGS.theme,
      cardColor: values.cardColor ?? DEFAULT_CONTENT_SETTINGS.cardColor,
      fontScale: values.fontScale ?? DEFAULT_CONTENT_SETTINGS.fontScale
    } });
  if (backup === undefined) throw new Error('阅读数据格式错误，无法创建备份。');
  return backup;
}

export function planReadingRestore(current: ReadingBackup, incoming: ReadingBackup, mode: BackupImportMode):
  { values: Record<string, unknown>; report: BackupImportReport } {
  let omitted = 0;
  const merge = (old: DictionaryEntry[], added: DictionaryEntry[], cap: number): DictionaryEntry[] => {
    if (mode === 'replace') return added;
    const seen = new Set(old.map((item) => normalized(item.query)));
    const combined = [...old, ...added.filter((item) => !seen.has(normalized(item.query)))];
    omitted += Math.max(0, combined.length - cap);
    return combined.slice(0, cap);
  };
  const history = merge(current.history, incoming.history, 50);
  const favorites = merge(current.favorites, incoming.favorites, 100);
  const review = mode === 'replace' ? { ...incoming.review } : { ...incoming.review, ...current.review };
  if (mode === 'merge') {
    for (const favorite of current.favorites) {
      const key = normalized(favorite.query);
      if (current.review[key] === undefined) delete review[key];
    }
  }
  const queries = new Set(favorites.map((item) => normalized(item.query)));
  for (const key of Object.keys(review)) if (!queries.has(key)) delete review[key];
  return { values: { dictionaryHistory: history, dictionaryFavorites: favorites, dictionaryReviewState: review, ...incoming.appearance },
    report: { history: history.length, favorites: favorites.length, omitted } };
}
