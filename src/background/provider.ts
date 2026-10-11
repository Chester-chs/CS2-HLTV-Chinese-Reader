import {
  createOpenAICompatibleProvider,
  type ChatCompletionsTransport,
  type ChatCompletionsTransportRequest,
  type ChatCompletionsTransportResponse,
  type TranslationProvider
} from '../core/translate/index.ts';
import type { ExtensionSettings } from '../shared/settings.ts';
export const DEFAULT_PROVIDER_TIMEOUT_MS = 25000;

export interface BackgroundProviderFactoryOptions {
  timeoutMs?: number;
  temperature?: number;
  transport?: ChatCompletionsTransport;
  fetcher?: typeof fetch;
}

async function fetchChatCompletions(
  request: ChatCompletionsTransportRequest,
  fetcher: typeof fetch,
  signal?: AbortSignal
): Promise<ChatCompletionsTransportResponse> {
  const controller = new AbortController();
  const onAbort = (): void => { controller.abort(); cleanup(); };
  const timer = setTimeout(onAbort, request.timeoutMs);
  const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const response = await fetcher(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      credentials: 'omit'
    });
    if (response.status < 200 || response.status >= 300) cleanup();
    return {
      status: response.status,
      async json() { try { return await response.json() as unknown; } finally { cleanup(); } }
    };
  } catch (error) { cleanup(); throw error; }
}

export function createBackgroundProviderFactory(
  options: BackgroundProviderFactoryOptions = {}
): (settings: ExtensionSettings, signal?: AbortSignal) => TranslationProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

  return (settings, signal) =>
    createOpenAICompatibleProvider({
      baseURL: settings.baseURL,
      model: settings.model,
      apiKey: settings.apiKey,
      timeoutMs,
      useJsonOutputMode: settings.useJsonOutputMode,
      translationStyle: settings.translationStyle,
      ...(options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
      transport: options.transport ?? { send: (request) => fetchChatCompletions(request, options.fetcher ?? fetch, signal) }
    });
}
