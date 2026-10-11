export interface DictionaryStorage {
  get(keys: readonly string[] | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export interface DictionaryEntry {
  query: string;
  translated: string;
  baseForm?: string;
  englishMeaning?: string;
  difficulty?: string;
  pinyin?: string;
  examples?: string[];
  savedAt: number;
}

export const DICTIONARY_HISTORY_KEY = 'dictionaryHistory';
export const DICTIONARY_FAVORITES_KEY = 'dictionaryFavorites';
export const DICTIONARY_REVIEW_KEY = 'dictionaryReviewState';
export interface DictionaryReviewRecord { dueAt: number; interval: number }
export type DictionaryReviewState = Record<string, DictionaryReviewRecord>;

export function parseDictionaryReviewState(stored: unknown): DictionaryReviewState {
  const state: DictionaryReviewState = Object.create(null);
  if (isRecord(stored)) {
    for (const [key, value] of Object.entries(stored)) {
      if (isRecord(value) && typeof value.dueAt === 'number' && Number.isFinite(value.dueAt) &&
          typeof value.interval === 'number' && Number.isFinite(value.interval) && value.interval >= 0 && value.interval <= 30) {
        state[key.trim().toLowerCase()] = { dueAt: value.dueAt, interval: value.interval };
      }
    }
  }
  return state;
}
const MAX_HISTORY_ENTRIES = 50;
const MAX_FAVORITES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseDictionaryEntry(value: unknown): DictionaryEntry | undefined {
  if (!isRecord(value) || typeof value.query !== 'string' || typeof value.translated !== 'string') {
    return undefined;
  }
  const query = value.query.trim();
  if (query.length === 0) {
    return undefined;
  }
  return {
    query,
    translated: value.translated,
    ...(typeof value.baseForm === 'string' ? { baseForm: value.baseForm } : {}),
    ...(typeof value.englishMeaning === 'string' ? { englishMeaning: value.englishMeaning } : {}),
    ...(typeof value.difficulty === 'string' ? { difficulty: value.difficulty } : {}),
    ...(typeof value.pinyin === 'string' ? { pinyin: value.pinyin } : {}),
    ...(Array.isArray(value.examples) && value.examples.every((item) => typeof item === 'string') ? { examples: value.examples as string[] } : {}),
    savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0
  };
}

function readEntries(values: Record<string, unknown>, key: string): DictionaryEntry[] {
  const stored = values[key];
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored.flatMap((item) => {
    const parsed = parseDictionaryEntry(item);
    return parsed === undefined ? [] : [parsed];
  });
}

function sameQuery(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

export function createDictionaryStore(
  storage: DictionaryStorage,
  now: () => number = () => Date.now()
): {
  recordHistory(entry: DictionaryEntry): Promise<void>;
  listHistory(): Promise<DictionaryEntry[]>;
  toggleFavorite(entry: DictionaryEntry): Promise<boolean>;
  setFavorite(entry: DictionaryEntry, favorite: boolean): Promise<boolean>;
  isFavorite(query: string): Promise<boolean>;
  listFavorites(): Promise<DictionaryEntry[]>;
  clearHistory(): Promise<void>;
  clearFavorites(): Promise<void>;
  recordReview(query: string, remembered: boolean): Promise<void>;
  listReview(): Promise<DictionaryReviewState>;
} {
  async function read(key: string): Promise<DictionaryEntry[]> {
    // A failed read must not turn a subsequent write into a destructive reset.
    return readEntries(await storage.get([key]), key);
  }

  async function write(key: string, entries: DictionaryEntry[]): Promise<void> {
    await storage.set({ [key]: entries });
  }

  async function recordHistory(entry: DictionaryEntry): Promise<void> {
    const current = await read(DICTIONARY_HISTORY_KEY);
    const next: DictionaryEntry = { ...entry, savedAt: now() };
    const entries = [next, ...current.filter((item) => !sameQuery(item.query, next.query))]
      .slice(0, MAX_HISTORY_ENTRIES);
    await write(DICTIONARY_HISTORY_KEY, entries);
  }

  async function listHistory(): Promise<DictionaryEntry[]> {
    return read(DICTIONARY_HISTORY_KEY);
  }

  async function toggleFavorite(entry: DictionaryEntry): Promise<boolean> {
    const current = await read(DICTIONARY_FAVORITES_KEY);
    const existing = current.findIndex((item) => sameQuery(item.query, entry.query));
    if (existing >= 0) {
      current.splice(existing, 1);
      await write(DICTIONARY_FAVORITES_KEY, current);
      return false;
    }
    const next: DictionaryEntry = { ...entry, savedAt: now() };
    await write(DICTIONARY_FAVORITES_KEY, [next, ...current].slice(0, MAX_FAVORITES));
    return true;
  }

  async function isFavorite(query: string): Promise<boolean> {
    return (await read(DICTIONARY_FAVORITES_KEY)).some((item) => sameQuery(item.query, query));
  }

  async function setFavorite(entry: DictionaryEntry, favorite: boolean): Promise<boolean> {
    const current = await read(DICTIONARY_FAVORITES_KEY);
    const existing = current.some((item) => sameQuery(item.query, entry.query));
    if (existing === favorite) return favorite;
    const next = favorite
      ? [{ ...entry, savedAt: now() }, ...current].slice(0, MAX_FAVORITES)
      : current.filter((item) => !sameQuery(item.query, entry.query));
    await write(DICTIONARY_FAVORITES_KEY, next);
    return favorite;
  }

  async function listFavorites(): Promise<DictionaryEntry[]> {
    return read(DICTIONARY_FAVORITES_KEY);
  }

  async function clearHistory(): Promise<void> {
    await write(DICTIONARY_HISTORY_KEY, []);
  }

  async function clearFavorites(): Promise<void> {
    await write(DICTIONARY_FAVORITES_KEY, []);
  }

  async function recordReview(query: string, remembered: boolean): Promise<void> {
    const values = await storage.get([DICTIONARY_REVIEW_KEY]);
    const state = parseDictionaryReviewState(values[DICTIONARY_REVIEW_KEY]);
    const key = query.trim().toLowerCase();
    const previous = state[key];
    const interval = remembered ? Math.min(30, Math.max(1, (previous?.interval ?? 0) * 2)) : 1;
    state[key] = { interval, dueAt: now() + interval * 24 * 60 * 60 * 1000 };
    await storage.set({ [DICTIONARY_REVIEW_KEY]: state });
  }

  return {
    recordHistory,
    listHistory,
    toggleFavorite,
    setFavorite,
    isFavorite,
    listFavorites,
    clearHistory,
    clearFavorites,
    recordReview,
    async listReview() {
      const values = await storage.get([DICTIONARY_REVIEW_KEY]);
      return parseDictionaryReviewState(values[DICTIONARY_REVIEW_KEY]);
    }
  };
}
