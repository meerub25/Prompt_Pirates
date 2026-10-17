import * as SQLite from 'expo-sqlite';

let databasePromise;

export function database() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync('nascon-mobile.db').then(async db => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cache (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          saved_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS offline_queue (
          action_id TEXT PRIMARY KEY NOT NULL,
          type TEXT NOT NULL,
          queued_at TEXT NOT NULL,
          base_version INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_results (
          action_id TEXT PRIMARY KEY NOT NULL,
          status TEXT NOT NULL,
          reason TEXT NOT NULL,
          completed_at TEXT NOT NULL
        );
      `);
      return db;
    });
  }
  return databasePromise;
}

export async function getSetting(key, fallback = null) {
  const db = await database();
  const row = await db.getFirstAsync('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  const db = await database();
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value
  );
}

export async function saveCache(key, value) {
  const db = await database();
  await db.runAsync(
    'INSERT INTO cache (key, value, saved_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, saved_at = excluded.saved_at',
    key,
    JSON.stringify(value),
    new Date().toISOString()
  );
}

export async function readCache(key) {
  const db = await database();
  const row = await db.getFirstAsync('SELECT value FROM cache WHERE key = ?', key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export async function enqueueAction(action) {
  const db = await database();
  await db.runAsync(
    `INSERT INTO offline_queue (action_id, type, queued_at, base_version, payload)
     VALUES (?, ?, ?, ?, ?)`,
    action.action_id,
    action.type,
    action.queued_at,
    action.base_version,
    JSON.stringify(action.payload)
  );
}

export async function readQueue() {
  const db = await database();
  const rows = await db.getAllAsync(
    'SELECT action_id, type, queued_at, base_version, payload FROM offline_queue ORDER BY queued_at, action_id'
  );
  return rows.map(row => ({
    action_id: row.action_id,
    type: row.type,
    queued_at: row.queued_at,
    base_version: row.base_version,
    payload: JSON.parse(row.payload)
  }));
}

export async function removeQueuedActions(actions) {
  const db = await database();
  await db.withTransactionAsync(async () => {
    for (const action of actions) {
      await db.runAsync('DELETE FROM offline_queue WHERE action_id = ?', action.action_id);
    }
  });
}

export async function saveSyncResults(results) {
  const db = await database();
  await db.withTransactionAsync(async () => {
    for (const result of results) {
      await db.runAsync(
        `INSERT INTO sync_results (action_id, status, reason, completed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(action_id) DO UPDATE SET
           status = excluded.status,
           reason = excluded.reason,
           completed_at = excluded.completed_at`,
        result.action_id,
        result.status,
        result.reason,
        new Date().toISOString()
      );
    }
  });
}

export async function readSyncResults() {
  const db = await database();
  return db.getAllAsync(
    'SELECT action_id, status, reason, completed_at FROM sync_results ORDER BY completed_at DESC LIMIT 30'
  );
}

export async function getOrCreateDeviceId() {
  const stored = await getSetting('device_id');
  if (stored) return stored;
  const id = `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await setSetting('device_id', id);
  return id;
}
