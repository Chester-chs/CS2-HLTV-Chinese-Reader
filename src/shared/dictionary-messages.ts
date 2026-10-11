import { parseDictionaryEntry, type DictionaryEntry, type DictionaryReviewState } from '../content/dictionary-store.ts';
import { parseReadingBackup, type ReadingBackup, type BackupImportMode, type BackupImportReport } from './reading-backup.ts';

export const DICTIONARY_MESSAGE_TYPE = 'hltv-zh-dictionary';
export type DictionaryAction = 'record-history' | 'list-history' | 'toggle-favorite' |
  'is-favorite' | 'list-favorites' | 'clear-history' | 'clear-favorites' | 'record-review' | 'list-review' | 'set-favorite' | 'export-backup' | 'import-backup';

export interface DictionaryRequest {
  type: typeof DICTIONARY_MESSAGE_TYPE;
  action: DictionaryAction;
  entry?: DictionaryEntry;
  query?: string;
  remembered?: boolean;
  favorite?: boolean;
  backup?: ReadingBackup;
  importMode?: BackupImportMode;
}

export type DictionaryResponse =
  | { ok: true; value: DictionaryEntry[] | DictionaryReviewState | ReadingBackup | BackupImportReport | boolean | null }
  | { ok: false; message: string };

export function decodeDictionaryRequest(value: unknown): DictionaryRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const input = value as Record<string, unknown>;
  if (input.type !== DICTIONARY_MESSAGE_TYPE) return undefined;
  const action = input.action;
  if (action === 'import-backup') {
    const backup = parseReadingBackup(input.backup);
    if (backup === undefined || (input.importMode !== 'merge' && input.importMode !== 'replace')) return undefined;
    return { type: DICTIONARY_MESSAGE_TYPE, action, backup, importMode: input.importMode };
  }
  if (action === 'record-review' && typeof input.query === 'string' && input.query.trim().length > 0 &&
      input.query.length <= 2000 && typeof input.remembered === 'boolean') {
    return { type: DICTIONARY_MESSAGE_TYPE, action, query: input.query, remembered: input.remembered };
  }
  if (action === 'record-history' || action === 'toggle-favorite' || action === 'set-favorite') {
    const entry = parseDictionaryEntry(input.entry);
    if (entry === undefined || entry.query.length > 2000 || entry.translated.length > 100000) return undefined;
    if (action === 'set-favorite' && typeof input.favorite !== 'boolean') return undefined;
    return { type: DICTIONARY_MESSAGE_TYPE, action, entry,
      ...(action === 'set-favorite' ? { favorite: input.favorite as boolean } : {}) };
  }
  if (action === 'is-favorite' && typeof input.query === 'string' && input.query.length <= 2000) {
    return { type: DICTIONARY_MESSAGE_TYPE, action, query: input.query };
  }
  if (action === 'list-history' || action === 'list-favorites' ||
      action === 'clear-history' || action === 'clear-favorites' || action === 'list-review' || action === 'export-backup') {
    return { type: DICTIONARY_MESSAGE_TYPE, action };
  }
  return undefined;
}
