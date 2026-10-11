export const UPDATE_ORIGIN = 'https://api.github.com/*';
export const RELEASE_API = 'https://api.github.com/repos/Chester-chs/CS2-HLTV-Chinese-Reader/releases/latest';
const RELEASE_PREFIX = 'https://github.com/Chester-chs/CS2-HLTV-Chinese-Reader/releases/tag/';
const UPDATE_KEY = 'releaseCheck';
const DAY = 24 * 60 * 60 * 1000;
export interface ReleaseInfo { version: string; url: string }
export interface ReleaseCheckResult {
  kind: 'permission-missing' | 'available' | 'current' | 'failed';
  release?: ReleaseInfo;
  checkedAt?: number;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function versionParts(value: string): number[] | undefined {
  if (!/^\d+\.\d+\.\d+$/u.test(value)) return undefined;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}
export function isNewerVersion(candidate: string, installed: string): boolean {
  const left = versionParts(candidate); const right = versionParts(installed);
  if (left === undefined || right === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}
function parseInfo(value: unknown): ReleaseInfo | undefined {
  if (!record(value) || typeof value.version !== 'string' || versionParts(value.version) === undefined ||
      value.url !== `${RELEASE_PREFIX}v${value.version}`) return undefined;
  return { version: value.version, url: value.url as string };
}
function parseRelease(value: unknown): ReleaseInfo | undefined {
  if (!record(value) || typeof value.tag_name !== 'string' || !value.tag_name.startsWith('v') ||
      value.draft !== false || value.prerelease !== false) return undefined;
  return parseInfo({ version: value.tag_name.slice(1), url: value.html_url });
}
export async function fetchLatestRelease(): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(RELEASE_API, { signal: controller.signal, credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error('Release check failed.');
    return await response.json() as unknown;
  } finally { clearTimeout(timeout); }
}
export function createReleaseChecker(options: {
  storage: { get(keys: readonly string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> };
  hasPermission(): Promise<boolean>;
  fetchLatest?: () => Promise<unknown>;
  now?: () => number;
}): { check(installedVersion: string, force?: boolean): Promise<ReleaseCheckResult> } {
  let inFlight: Promise<ReleaseCheckResult> | undefined;
  return { async check(installedVersion, force = false) {
    if (inFlight !== undefined) return inFlight;
    const operation = (async (): Promise<ReleaseCheckResult> => {
      let release: ReleaseInfo | undefined;
      try {
        if (!await options.hasPermission()) return { kind: 'permission-missing' };
        const now = (options.now ?? Date.now)();
        const stored = (await options.storage.get([UPDATE_KEY]))[UPDATE_KEY];
        const cached = record(stored) ? stored : {};
        release = parseInfo(cached.release);
        const checkedAt = typeof cached.checkedAt === 'number' && Number.isFinite(cached.checkedAt) ? cached.checkedAt : undefined;
        if (!force && checkedAt !== undefined && now >= checkedAt && now - checkedAt < DAY && (release !== undefined || cached.failed === true)) {
          return { kind: cached.failed === true ? 'failed' : isNewerVersion(release!.version, installedVersion) ? 'available' : 'current',
            ...(release === undefined ? {} : { release }), checkedAt };
        }
        // Persist failed attempts too, so repeated popup openings do not hammer GitHub.
        await options.storage.set({ [UPDATE_KEY]: { checkedAt: now, failed: true, ...(release === undefined ? {} : { release }) } });
        const latest = parseRelease(await (options.fetchLatest ?? fetchLatestRelease)());
        if (latest === undefined) throw new Error('Invalid release.');
        release = latest;
        await options.storage.set({ [UPDATE_KEY]: { checkedAt: now, failed: false, release } });
        return { kind: isNewerVersion(release.version, installedVersion) ? 'available' : 'current', release, checkedAt: now };
      } catch {
        return { kind: 'failed', ...(release === undefined ? {} : { release }) };
      }
    })();
    inFlight = operation;
    try { return await operation; } finally { if (inFlight === operation) inFlight = undefined; }
  } };
}
