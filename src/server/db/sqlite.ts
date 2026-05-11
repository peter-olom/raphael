export { DB_PATH, applySqlitePragmas, DEFAULT_DROP_ID } from './core.js';
export type { TraceInsertRow, WideEventInsertRow } from './telemetry.js';
export {
  insertTraceRows,
  insertWideEventRows,
  insertTraceRow,
  insertWideEventRow,
  getRecentTraces,
  getRecentWideEvents,
  getTraceById,
  getWideEventById,
  getWideEventsByTraceId,
  searchTraces,
  searchWideEvents,
  getStats,
  clearAll,
} from './telemetry.js';
export type { RetentionPruneResult } from './drops.js';
export {
  listDrops,
  createDrop,
  getDropById,
  getDropByName,
  setDropLabel,
  deleteDrop,
  ensureDrop,
  resolveDropId,
  setDropRetentionMs,
  getDropRetention,
  pruneByRetention,
  getRetentionPruneConfig,
  checkpointDatabase,
  compactDatabase,
} from './drops.js';
export { listDashboards, getDashboard, createDashboard, updateDashboard, deleteDashboard } from './dashboards.js';
export { getAppSetting, setAppSetting, deleteAppSetting } from './settings.js';
export type { UserRole } from './users.js';
export {
  countUserProfiles,
  countAdminProfiles,
  getUserProfile,
  listUserProfiles,
  deleteSessionsForUsers,
  upsertUserProfile,
  createUserProfileIfMissing,
  updateUserRole,
  updateUserDisabled,
  listUserDropPermissions,
  getUserDropPermission,
  listDropsForOwnerAccess,
  setUserDropPermissions,
  hasAnyUserDropPermissions,
} from './users.js';
export {
  listServiceAccounts,
  createServiceAccount,
  deleteServiceAccountOwned,
  listApiKeys,
  listApiKeysForOwner,
  getServiceAccountById,
  createApiKey,
  revokeApiKey,
  revokeApiKeyOwned,
  getApiKeyByHash,
  setApiKeyPermissions,
  getApiKeyPermissions,
  logApiKeyUsage,
  listApiKeyUsage,
  listApiKeyUsageForOwner,
} from './serviceAccounts.js';
export type { TraceQuery, WideEventQuery } from './queries.js';
export { queryTraces, queryWideEvents } from './queries.js';
