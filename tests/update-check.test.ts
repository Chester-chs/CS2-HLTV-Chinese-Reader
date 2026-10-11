const { strict: assert } = await import('node:assert/strict' as string) as {
  strict: { equal(a: unknown, b: unknown): void; deepEqual(a: unknown, b: unknown): void };
};
const { test } = await import('node:test' as string) as { test(name: string, run: () => void | Promise<void>): void };
import { createReleaseChecker, isNewerVersion } from '../src/shared/release-check.ts';

test('release checking requires permission, caches for a day and compares numeric versions', async () => {
  let granted = false;
  let calls = 0;
  let now = 1000;
  const values: Record<string, unknown> = {};
  const checker = createReleaseChecker({
    storage: { async get() { return { ...values }; }, async set(next) { Object.assign(values, next); } },
    hasPermission: async () => granted, now: () => now,
    fetchLatest: async () => { calls += 1; return { tag_name: 'v1.0.10', draft: false, prerelease: false,
      html_url: 'https://github.com/Chester-chs/CS2-HLTV-Chinese-Reader/releases/tag/v1.0.10' }; }
  });
  assert.equal((await checker.check('1.0.4')).kind, 'permission-missing');
  assert.equal(calls, 0);
  granted = true;
  assert.equal((await checker.check('1.0.4')).kind, 'available');
  assert.equal((await checker.check('1.0.10')).kind, 'current');
  assert.equal(calls, 1);
  now += 86400000;
  await checker.check('1.0.4');
  assert.equal(calls, 2);
  assert.equal(isNewerVersion('1.0.10', '1.0.9'), true);
  assert.equal(isNewerVersion('1.0.4', '1.1.0'), false);
});

test('release checking rejects foreign links and remembers failures without losing a valid previous release', async () => {
  const values: Record<string, unknown> = {};
  let bad = false;
  let calls = 0;
  const checker = createReleaseChecker({
    storage: { async get() { return { ...values }; }, async set(next) { Object.assign(values, next); } },
    hasPermission: async () => true, now: () => 1000,
    fetchLatest: async () => { calls += 1; return { tag_name: 'v1.0.5', draft: false, prerelease: false,
      html_url: bad ? 'https://evil.invalid/' : 'https://github.com/Chester-chs/CS2-HLTV-Chinese-Reader/releases/tag/v1.0.5' }; }
  });
  assert.equal((await checker.check('1.0.4')).kind, 'available');
  bad = true;
  const result = await checker.check('1.0.4', true);
  assert.equal(result.kind, 'failed');
  assert.equal(result.release?.version, '1.0.5');
  assert.equal((await checker.check('1.0.4')).kind, 'failed');
  assert.equal(calls, 2);
});
