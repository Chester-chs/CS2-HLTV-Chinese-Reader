import type { ExtensionSettings } from '../shared/settings.ts';
import { parseProviderBaseURL } from '../shared/provider-url.ts';

export interface OptionsSettingsStorage {
  set(values: Record<string, unknown>): Promise<void>;
}

export interface OptionalHostPermissions {
  contains(details: { origins: string[] }): Promise<boolean>;
  request(details: { origins: string[] }): Promise<boolean>;
}

export type ProviderPermissionStatus =
  | { state: 'invalid' }
  | { state: 'unavailable' }
  | { state: 'granted'; origin: string }
  | { state: 'missing'; origin: string };

export async function getProviderPermissionStatus(
  baseURL: string,
  permissions: Pick<OptionalHostPermissions, 'contains'>
): Promise<ProviderPermissionStatus> {
  const parsed = parseProviderBaseURL(baseURL);
  if (parsed === undefined) {
    return { state: 'invalid' };
  }

  try {
    const granted = await permissions.contains({
      origins: [parsed.permissionPattern]
    });
    return {
      state: granted ? 'granted' : 'missing',
      origin: parsed.origin
    };
  } catch {
    return { state: 'unavailable' };
  }
}

export async function authorizeProviderOrigin(
  baseURL: string,
  permissions: OptionalHostPermissions
): Promise<{ state: 'invalid' | 'denied' | 'unavailable' | 'granted'; origin?: string }> {
  const parsed = parseProviderBaseURL(baseURL);
  if (parsed === undefined) {
    return { state: 'invalid' };
  }

  try {
    const details = { origins: [parsed.permissionPattern] };
    if (await permissions.contains(details)) {
      return { state: 'granted', origin: parsed.origin };
    }
    const granted = await permissions.request(details);
    return {
      state: granted ? 'granted' : 'denied',
      origin: parsed.origin
    };
  } catch {
    return { state: 'unavailable', origin: parsed.origin };
  }
}

export type SaveOptionsSettingsResult =
  | { ok: true; origin: string }
  | {
      ok: false;
      reason:
        | 'invalid-base-url'
        | 'invalid-fallback'
        | 'permission-check-failed'
        | 'permission-denied'
        | 'settings-save-failed';
      origin?: string;
    };

export async function saveOptionsSettings(
  settings: ExtensionSettings,
  storage: OptionsSettingsStorage,
  permissions: OptionalHostPermissions
): Promise<SaveOptionsSettingsResult> {
  const parsed = parseProviderBaseURL(settings.baseURL);
  if (parsed === undefined) {
    return { ok: false, reason: 'invalid-base-url' };
  }
  if (settings.fallbackEnabled === true && (
    parseProviderBaseURL(settings.fallbackBaseURL ?? '') === undefined ||
    (settings.fallbackModel ?? '').trim().length === 0 ||
    (settings.fallbackApiKey ?? '').trim().length === 0
  )) {
    return { ok: false, reason: 'invalid-fallback' };
  }

  const details = { origins: [parsed.permissionPattern] };
  let granted: boolean;
  try {
    granted = await permissions.contains(details);
  } catch {
    return {
      ok: false,
      reason: 'permission-check-failed',
      origin: parsed.origin
    };
  }

  if (!granted) {
    try {
      granted = await permissions.request(details);
    } catch {
      granted = false;
    }
  }
  if (!granted) {
    return {
      ok: false,
      reason: 'permission-denied',
      origin: parsed.origin
    };
  }

  try {
    await storage.set({
      ...settings,
      baseURL: parsed.normalizedBaseURL
    });
  } catch {
    return {
      ok: false,
      reason: 'settings-save-failed',
      origin: parsed.origin
    };
  }

  return { ok: true, origin: parsed.origin };
}
