import * as SecureStore from 'expo-secure-store';
import {
  getSetting,
  readCache,
  saveCache,
  setSetting
} from './storage';

export const DEFAULT_BASE_URL = 'http://10.0.2.2:8080';
const TOKEN_KEY = 'nascon_access_token';

export async function getBaseUrl() {
  return (await getSetting('base_url', DEFAULT_BASE_URL)).replace(/\/+$/, '');
}

export async function setBaseUrl(value) {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+(?::\d+)?(?:\/[^ ]*)?$/.test(normalized)) {
    throw new Error('Enter a valid server address, including http:// or https://.');
  }
  await setSetting('base_url', normalized);
}

export async function getToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function saveToken(token) {
  return SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken() {
  return SecureStore.deleteItemAsync(TOKEN_KEY);
}

export function friendlyError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  if (error.name === 'TypeError' || /network request failed/i.test(error.message || '')) {
    return 'The server could not be reached. Check your connection or server address.';
  }
  const code = error.code || '';
  const messages = {
    UNAUTHENTICATED: 'Your sign-in has expired. Please sign in again.',
    FORBIDDEN: 'Your account does not have permission for this action.',
    LEAGUE_NOT_FOUND: 'That league could not be found.',
    MATCH_NOT_FOUND: 'That match could not be found.',
    VARIANT_NOT_FOUND: 'That item is no longer available.',
    OUT_OF_STOCK: 'There is not enough stock for that item.',
    PAYMENT_DECLINED: 'The mock payment was declined. Your cart is unchanged.',
    PAYMENT_CAPTURE_FAILED: 'The mock payment could not be completed. Your cart is unchanged.',
    INVALID_COMPENSATION: 'That event cannot be corrected.',
    EVENT_NOT_FOUND: 'The event to correct could not be found.',
    MATCH_NOT_IN_PROGRESS: 'Start the match before adding a score.',
    ILLEGAL_TRANSITION: 'That match action is not allowed in its current state.',
    UNKNOWN_EVENT_TYPE: 'That scoring event is not configured for this sport.',
    INVALID_BASE_VERSION: 'The match changed before this action could be synced. Review and try again.',
    NOT_IN_SQUAD: 'This player is not currently in the selected squad.',
    PLAYER_NOT_FOUND: 'That player could not be found.',
    VALIDATION_ERROR: 'Some information is missing or invalid. Please review the form.'
  };
  return messages[code] || error.message || 'The request could not be completed. Please try again.';
}

export async function apiRequest(path, { method = 'GET', body, token, cacheKey } = {}) {
  const baseUrl = await getBaseUrl();
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    error.message = 'Network request failed';
    throw error;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('The server returned an unreadable response.');
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'The request could not be completed.');
    error.code = data?.error?.code;
    error.status = response.status;
    throw error;
  }
  if (cacheKey) await saveCache(cacheKey, data);
  return data;
}

export async function cachedOrFetch(path, token, cacheKey) {
  try {
    const data = await apiRequest(path, { token, cacheKey });
    return { data, cached: false };
  } catch (error) {
    if (error.status) throw error;
    const cached = await readCache(cacheKey);
    if (cached !== null) return { data: cached, cached: true };
    throw error;
  }
}
