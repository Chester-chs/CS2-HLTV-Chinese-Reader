# Gate 5 B3a: Background Integration Contract

## Scope

B3a originally connected the content script to the background service worker with an injectable fake provider. The fake remains available for tests; production B3b now uses the OpenAI-compatible provider factory and preserves the content-side injection interface.

No external provider request is made in B3a. The only runtime resource load is the packaged `dist/glossary.json` asset, which the background loads by extension URL and passes as text to `parseGlossaryJson`. The core layer does not read files, fetch resources, or import JSON modules.

## Selection magnifier and dictionary lookup

The content script watches for a non-empty text selection and places a small magnifier button beside the selection. The button is part of the page overlay and does not add a browser context-menu item or require the `contextMenus` permission, so the browser's native right-click menu remains unchanged. A single English word uses `dictionary` purpose; a longer selection uses `sentence` purpose. Both selection purposes remain available when page translation is disabled. Dictionary requests use Oxford-style Chinese meanings, concise English explanations, a verb base form when applicable, and UK/US pronunciation data; the card exposes browser speech buttons, local history/favorite storage, direct theme switching, and direct font controls. Sentence requests return a normal Chinese translation. The result appears in a temporary resizable popover without replacing the selected page text. The toolbar opens history and favorites in the dedicated `history.html` page. Missing provider permission, request failure, timeout, or invalid provider response are shown as actionable Chinese messages. No tab content is read by the background beyond the selected string, and the lookup follows the same provider, permission, cache, fallback-provider, and original-text fallback rules as other translated text.

## Message protocol

The shared protocol is in `src/background/protocol.ts`.

```ts
type TranslationPurpose = 'plain' | 'event-name' | 'dictionary' | 'sentence';
type TranslationContext = 'structured' | 'prose' | 'comment';

interface TranslateRequest {
  type: 'hltv-zh-translate-request';
  requestId: string;
  purpose: TranslationPurpose;
  context?: TranslationContext;
  texts: string[];
}

type TranslateFailureCode =
  | 'disabled'
  | 'settings-failure'
  | 'provider-failure'
  | 'provider-timeout'
  | 'invalid-response';

type TranslateResponse =
  | {
      type: 'hltv-zh-translate-response';
      requestId: string;
      purpose: TranslationPurpose;
      ok: true;
      translations: string[];
    }
  | {
      type: 'hltv-zh-translate-response';
      requestId: string;
      purpose: TranslationPurpose;
      ok: false;
      translations: string[];
      error: {
        code: TranslateFailureCode;
        fallback: 'original';
        message: string;
      };
    };
```

One request contains one purpose, an optional classification context, and a `string[]` batch. The content runtime maps `match-event`, `match-stage`, `match-meta`, and `match-time` to `structured`; news title/body strategies to `prose`; and comment strategies to `comment`. The background defaults an omitted context to `comment`, so older callers preserve the conservative behavior. A failure response always has the same number of strings as the request and uses the original strings. The content script treats a malformed response, a rejected message, no response, or a timeout as the same original-text fallback. Unknown messages are ignored by the background handler. API keys are not fields in either message type.

Before classification, the core applies deterministic glossary substitutions whenever glossary terms cover all letters in a controlled value. These exact terms do not reach the classifier or provider. The background runner exposes the same pure glossary-only mapping to the handler: the handler removes those fully covered strings and sends only uncovered strings to the provider. If permission is missing, or provider translation fails, offline labels remain translated while uncovered strings stay original. If there are no offline labels, failures keep the existing explicit original-text failure response. This lets short match/UI labels translate without a provider while preserving the conservative default for comments.

The request/response codecs validate message shape before use. They do not throw for untrusted message data; an invalid request is ignored because there is no reliable request ID with which to construct a response.

## Module and dependency direction

The B3a modules are separated as follows:

- `src/background/protocol.ts`: browser-independent message data and codecs.
- `src/background/settings.ts`: background settings storage and normalization.
- `src/background/cache-store.ts`: IndexedDB backend and the failure-tolerant `CacheStore` adapter.
- `src/background/fake-provider.ts`: B3a-only provider implementation.
- `src/background/translation-engine.ts`: background runner around the existing core translation service.
- `src/background/translation-handler.ts`: message validation, settings gate, timeout, and response fallback.
- `src/background/glossary-loader.ts`: runtime loading of the packaged glossary asset.
- `src/content/background-translator.ts`: content-side session de-duplication, message call, timeout, and fallback.
- `src/content/settings.ts`: content-side read of only the non-secret settings.
- `src/shared/settings.ts`: the single source of the default mode and shared settings types.

The content script depends on the protocol and its own settings reader. The background depends on the protocol, storage, the existing core translation interfaces, and the provider factory. `src/core/translate/` and `src/core/display/` remain independent of DOM APIs and extension APIs.

The glossary deliberately belongs only to the background translation path. The display layer has no glossary dependency, and the content script only needs translated strings and display intents. Sending the glossary to the content script would duplicate the authority and expose data that the display layer does not use.

## Settings and API-key boundary

`src/shared/settings.ts` defines the single default object:

```ts
interface ExtensionSettings {
  enabled: boolean;
  mode: 'A' | 'B';
  providerPreset: 'deepseek' | 'openai' | 'custom';
  baseURL: string;
  model: string;
  apiKey: string;
  useJsonOutputMode: boolean;
}
```

The defaults are `enabled: true`, `mode: 'A'`, DeepSeek base URL `https://api.deepseek.com`, model `deepseek-chat`, an empty API key, and JSON output mode enabled. OpenAI defaults to `https://api.openai.com` and `gpt-4o-mini`; Custom uses a user-provided HTTPS base URL and model, or HTTP for `localhost`, `127.0.0.1`, or `[::1]` local models. `content.ts` reads the shared enabled/mode defaults through `loadContentSettings`; it does not maintain a second independent default literal.

The background reads saved translation settings from `browser.storage.local`. The content script reads only `enabled` and `mode`. Translation API keys stay in the background settings/provider path. The options-page connection test reads the current form directly and sends its one test request from the options context; it does not put the key in a runtime message. The key is never read by the content settings loader, included in a message, written to a log, or placed in a test fixture.

```text
browser.storage.local -> background settings loader -> translation provider
options form -> one options-context connection-test request
```

The API key is stored only in `browser.storage.local`, never in `browser.storage.sync`. Translation and connection-test requests send it to the configured provider in the authorization header. It is not sent to the extension developer. The options page states these facts and does not claim the key is never transmitted over a network.

## Timeout and failure policy

The original B3a had no retries. Current provider attempts each have a 25,000 ms deadline. The background deadline is 30,000 ms for primary-only requests and 55,000 ms when fallback is enabled; the content deadline is 60,000 ms. Overrides remain injectable. Fallback is constructed only after primary failure, so invalid legacy fallback configuration cannot block a healthy primary or cache hit. Options reject an enabled fallback with an invalid URL or missing model/key before saving. A timeout, provider failure, settings read failure, malformed response, or background exception returns the original text array and an explicit failure response where a request ID is available.

Cache namespaces include a version marker and translation style as well as provider/model/JSON mode. Prior namespaces mixed natural/literal output, so neither new style reads ambiguous legacy entries; stored history/favorites are unaffected. There is no automatic cache deletion or migration.

The background runner observes provider failures while using the existing core `TranslationService`. A cache hit is successful and does not invoke the provider. A provider failure for an all-provider batch is normalized to `ok: false` with `fallback: 'original'`; the content translator never receives an exception for this path. In mixed batches the handler preserves offline glossary translations and falls back to original text only for strings that needed the provider. It checks host permission only after identifying and removing glossary-covered values.

## Three cache layers and their intentional semantics

The core `CacheStore` interface is unchanged. `src/background/cache-store.ts` adapts IndexedDB using database `cs2-hltv-zh-cache-v1` and object store `translations`. Current cache keys use the `v3:<namespace>:<purpose>:<encoded text>` format, generated by `createTranslationCacheKey` in the core. Reads that fail are reported and treated as misses. Writes that fail are reported but are best effort, so a completed translation remains usable. The options page can clear the store and reports the committed number of deleted records.

B3a records used bare text hashes. They remain in IndexedDB but are no longer read or automatically deleted. A text whose only record is in the old format is translated once again and written under its purpose-specific v2 key. This does not affect returned values, settings, permissions, or records already stored with v2 keys. The clear-cache action removes both formats.

There are deliberately three distinct behaviors:

1. Within one content-script session, `background-translator.ts` remembers an already returned result and does not send a second message for the same text and purpose.
2. For a request that does reach background, an IndexedDB hit prevents a provider call.
3. A different page has no way to know that background IndexedDB contains the text before asking background, so a cross-page cache hit still requires one content-to-background message.

The third behavior is intentional, not a missing optimization: persistent storage is owned by background, while content must not receive the cache database or provider credentials merely to avoid the lookup message.

## Permissions and B3b boundary

B3a did not add host_permissions or call a provider. B3b keeps the storage permission, declares optional_host_permissions for HTTPS hosts plus only localhost, 127.0.0.1, and [::1] over HTTP, and requests one configured origin at runtime from the options page. HTTP is limited to loopback so local model traffic stays on the user's machine; external providers still require HTTPS. It does not add fixed host permissions or <all_urls>. The background service worker can translate fully glossary-covered values without host permission; it checks permission before provider-dependent work, so there is no external request without the configured origin grant. The one-request connection test runs in the options page after checking the same exact origin. Its result uses a fixed enum and optional HTTP status only; it never contains raw provider text or settings, so a credential cannot leak through an unfamiliar error body. The background checks the saved origin at startup, after local settings changes, and after matching permission additions or removals. Its permission diagnostic represents current state: it reports only state transitions, clears with an undefined diagnostic callback after permission is restored, never prompts, and returns originals for provider-dependent text while permission is absent. The options page reacts to permission changes and offers the explicit repair action. Existing content scripts also rescan through their serialized scan queue after settings change; failed translations retain original text and can be retried after settings are saved.

There is a startup-order trap when the extension is installed before it is configured. The background starts with default settings such as `https://api.deepseek.com`, so its first permission check diagnoses the default origin before the options page saves the user's provider. Local settings changes trigger a fresh check against the saved origin and clear or replace that diagnostic. A settings change also makes already-open pages rescan; without that event, a page that scanned while permission was missing would stay untranslated until a later DOM mutation or reload.

The owner-approved and implemented B3b/B4 contract, including URL normalization, permission lifecycle, request body, full prompt, response validation, options behavior, and cache clearing, is in [b3b-provider-options-contract.md](./b3b-provider-options-contract.md). The approved contract records an explicit JSON output mode setting, an injectable provider temperature, and the approved interface-preserving core batching change.
# v1.0.4 closeout additions

Partial success responses preserve available translations and optionally carry validated failed indexes and a safe error code/message. Cancellable selection requests have independent provider operations and a document-scoped cancellation router; signals remain in background/content adapters, not pure core logic. See `closeout.md` for message semantics, backup queue operations and optional GitHub permission.
