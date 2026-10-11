# Test execution convention

The repository uses Node's native test runner. The `test` script is:

```text
node --test tests/*.test.ts
```

Node v24.19.0 executes the TypeScript test files through native type stripping; no `ts-node`, `tsx`, or test runtime dependency is required. `tsconfig.json` includes `tests/**/*.ts`, so test-file type errors are checked by the normal `typecheck` command.

Test files must use explicit `.ts` extensions when importing TypeScript modules, for example:

```ts
import { add } from './fixtures/add.ts';
```

`tsconfig.json` enables `allowImportingTsExtensions`, allowing the runtime-required spelling without suppression comments. Do not add `@ts-expect-error` or `@ts-ignore` to silence imports or other checks. Existing imports inside `src/` retain their established spelling and are not being batch-normalized.

## v1.0.4 closeout regression coverage

The owner authorized the final regression pass on 2026-10-11. New tests use injected storage, fetch and providers; none contact HLTV, GitHub or a real translation provider.

- `closeout.test.ts`: mixed IndexedDB/session cache failures, retrying failed misses, model/style isolation, old-response cache generation, backup export without secrets, validated merge/replace and capacity reporting, unreviewed-state preservation, malformed warning indexes, and review intervals.
- `cancellation.test.ts`: document-scoped cancellation, actual fetch AbortSignal, independent identical requests, preventing fallback after cancel, and late-response cache protection.
- `update-check.test.ts`: origin permission before fetch, daily success/failure throttling, numeric version comparison and rejection of foreign release URLs.
- `b3a.test.ts`: updated timeout contract and a real cache warm/hit path instead of a hard-coded obsolete namespace.

Reverse validation deliberately reintroduces realistic regressions, checks that assertions fail, restores production source, and reruns the affected test file. Evidence is kept under ignored `raw-capture/closeout-mutation-evidence.txt`. No DOM test framework, skipped tests, new dependency or CI configuration is added.

Unit tests and source review do not establish Chrome reload, rendered layout, system voice availability or real-provider success. Those require browser verification after manual extension reload; the blocked extension-management surface must not be bypassed.

## Provider permission browser verification

Provider permission verification must include both of these browser scenarios:

1. Install and load the extension with no saved provider configuration or host permission. Open `/matches` so the content script scans while permission is missing. Then configure an HTTPS provider in Options and grant its permission. The open page must rescan after the settings change and translate without a reload.
2. Use a real external HTTPS provider origin, such as `https://api.deepseek.com`, for the permission flow. A loopback address such as `127.0.0.1` exercises the special local HTTP allowance and does not represent an external provider origin.

The earlier automated browser validation used `127.0.0.1` and granted its permission in the same session. It therefore did not exercise the extension-starts-before-configuration timing, the default-origin startup diagnostic, or recovery of a page that had already scanned before permission was granted. Keep these scenarios in future provider permission verification; unit tests do not replace the external-origin browser check.
