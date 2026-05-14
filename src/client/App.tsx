import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createAuthClient } from 'better-auth/client';
import type { DashboardRow, DashboardSpecV1, WidgetSpec } from './dashboards/types';
import { computeWidget, parseDashboardSpec } from './dashboards/render';
import GridLayout, { useContainerWidth, type Layout } from 'react-grid-layout';
import { styles } from './styles';
import type { Drop, Stats, Tab, Trace, WideEvent } from './types';
import { DASHBOARD_COLS, DASHBOARD_ROW_HEIGHT, addPlacedWidget, clampInt, defaultWidgetLayout, normalizeDashboardSpec } from './dashboardLayout';
import { applyFilters, computeFieldStats, normalizeFilterKey, type FilterSetter, type FilterState } from './filters';
import { fetchJson, formatNumber, truncate } from './utils';
import { EventDetailModal, TraceDetailModal, type Selected } from './DetailModals';
import { EventsTable, TracesTable } from './TelemetryTables';

const LIST_PAGE_SIZE = 100;

export default function App() {
  type SettingsTab = 'account' | 'drops' | 'service_accounts' | 'auth' | 'users' | 'integrations';
  type AuthMode = 'disabled' | 'oauth_only' | 'password_only' | 'hybrid';

  const parseTab = (value: string | null): Tab | null => {
    if (value === 'events' || value === 'traces' || value === 'dashboards' || value === 'settings') return value;
    return null;
  };

  const parseSettingsTab = (value: string | null): SettingsTab | null => {
    if (
      value === 'account' ||
      value === 'drops' ||
      value === 'service_accounts' ||
      value === 'auth' ||
      value === 'users' ||
      value === 'integrations'
    ) {
      return value;
    }
    return null;
  };

  const initialTab: Tab =
    parseTab(new URLSearchParams(window.location.search).get('tab')) ??
    parseTab(window.location.hash.replace(/^#/, '')) ??
    'events';

  const initialSettingsTab: SettingsTab =
    parseSettingsTab(new URLSearchParams(window.location.search).get('settings')) ?? 'account';
  const initialDropRaw = new URLSearchParams(window.location.search).get('drop');
  const initialDropId = initialDropRaw && /^\d+$/.test(initialDropRaw) ? Number.parseInt(initialDropRaw, 10) : null;

  const [tab, setTab] = useState<Tab>(initialTab);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialSettingsTab);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('disabled');
  const [authProviders, setAuthProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [authEmailPasswordEnabled, setAuthEmailPasswordEnabled] = useState(false);
  const [authAllowlistSummary, setAuthAllowlistSummary] = useState<{ enabled: boolean; domains_count: number; emails_count: number } | null>(null);
  const [authBaseUrlSet, setAuthBaseUrlSet] = useState(false);
  const [authTrustedOriginsSet, setAuthTrustedOriginsSet] = useState(false);
  const [unauthAdminEnabled, setUnauthAdminEnabled] = useState(false);
  const [authUser, setAuthUser] = useState<{ id: string; email: string; role: 'admin' | 'member' } | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [users, setUsers] = useState<
    Array<{
      user_id: string;
      email: string;
      role: 'admin' | 'member';
      disabled: number;
      protected_admin?: boolean;
      created_at: number;
      last_login_at: number | null;
    }>
  >([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUserRole, setSelectedUserRole] = useState<'admin' | 'member'>('member');
  const [selectedUserDisabled, setSelectedUserDisabled] = useState(false);
  const [userPermissions, setUserPermissions] = useState<Array<{ drop_id: number; can_ingest: number; can_query: number }>>([]);
  const [userSaving, setUserSaving] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<'admin' | 'member'>('member');
  const [newUserPermissions, setNewUserPermissions] = useState<
    Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>
  >([]);
  const [newUserCreating, setNewUserCreating] = useState(false);
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [createdUserCreds, setCreatedUserCreds] = useState<null | { email: string; password: string; role: 'admin' | 'member' }>(null);
  const [authPolicyDomains, setAuthPolicyDomains] = useState('');
  const [authPolicyEmails, setAuthPolicyEmails] = useState('');
  const [authPolicyDefaultPermissions, setAuthPolicyDefaultPermissions] = useState<
    Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>
  >([]);
  const [authPolicySaving, setAuthPolicySaving] = useState(false);
  const [authPolicyError, setAuthPolicyError] = useState<string | null>(null);
  const [serviceAccounts, setServiceAccounts] = useState<
    Array<{ id: number; name: string; created_at: number; created_by_email: string | null }>
  >([]);
  const [apiKeys, setApiKeys] = useState<
    Array<{
      id: number;
      service_account_id: number;
      name: string | null;
      key_prefix: string;
      created_at: number;
      revoked_at: number | null;
      permissions: Array<{ drop_id: number; can_ingest: number; can_query: number }>;
    }>
  >([]);
  const [newServiceAccountName, setNewServiceAccountName] = useState('');
  const [selectedServiceAccountId, setSelectedServiceAccountId] = useState<number | null>(null);
  const [newApiKeyName, setNewApiKeyName] = useState('');
  const [apiKeyDropId, setApiKeyDropId] = useState<number | null>(null);
  const [apiKeyCanIngest, setApiKeyCanIngest] = useState(true);
  const [apiKeyCanQuery, setApiKeyCanQuery] = useState(true);
  const [generatedApiKey, setGeneratedApiKey] = useState<string | null>(null);
  const [generatedApiKeyMeta, setGeneratedApiKeyMeta] = useState<string | null>(null);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [accountDrops, setAccountDrops] = useState<
    Array<{ id: number; name: string; label: string | null; can_ingest: number; can_query: number }>
  >([]);
  const [accountDropsLoaded, setAccountDropsLoaded] = useState(false);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [events, setEvents] = useState<WideEvent[]>([]);
  const [traceNextCursor, setTraceNextCursor] = useState<number | null>(null);
  const [eventNextCursor, setEventNextCursor] = useState<number | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [stats, setStats] = useState<Stats>({ traces: 0, wideEvents: 0, errors: 0 });
  const [search, setSearch] = useState('');
  const [drops, setDrops] = useState<Drop[]>([]);
  const [defaultDropId, setDefaultDropId] = useState<number | null>(null);
  const [dropId, setDropId] = useState<number | null>(initialDropId);
  const dropIdRef = useRef<number | null>(null);
  const dataRequestSeqRef = useRef(0);
  const dashboardRequestSeqRef = useRef(0);
  const [showFilters, setShowFilters] = useState(false);
  const [eventFilters, setEventFilters] = useState<FilterState>({});
  const [traceFilters, setTraceFilters] = useState<FilterState>({});
  const [newDropName, setNewDropName] = useState('');
  const [dropLabelDraft, setDropLabelDraft] = useState('');
  const [dropLabelSaving, setDropLabelSaving] = useState(false);
  const [showDeleteDrop, setShowDeleteDrop] = useState(false);
  const [deleteDropConfirm, setDeleteDropConfirm] = useState('');
  const [deleteDropDeleting, setDeleteDropDeleting] = useState(false);
  const [retentionTracesDays, setRetentionTracesDays] = useState<string>('3');
  const [retentionEventsDays, setRetentionEventsDays] = useState<string>('7');
  const [selected, setSelected] = useState<Selected | null>(null);
  const [dashboards, setDashboards] = useState<DashboardRow[]>([]);
  const [dashboardSelectedId, setDashboardSelectedId] = useState<number | null>(null);
  const [dashboardSpec, setDashboardSpec] = useState<DashboardSpecV1 | null>(null);
  const [dashboardName, setDashboardName] = useState('');
  const [dashboardSample, setDashboardSample] = useState<WideEvent[]>([]);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardEditingWidgetId, setDashboardEditingWidgetId] = useState<string | null>(null);
  const [dashboardMode, setDashboardMode] = useState<'view' | 'edit'>(() => {
    const stored = window.localStorage.getItem('raphael.dashboardMode');
    return stored === 'edit' ? 'edit' : 'view';
  });
  const [showNewDashboard, setShowNewDashboard] = useState(false);
  const [newDashboardName, setNewDashboardName] = useState('My Dashboard');
  const [showGenerateDashboard, setShowGenerateDashboard] = useState(false);
  const [generateLimit, setGenerateLimit] = useState<string>('2000');
  const [generateUseAi, setGenerateUseAi] = useState(false);
  const [appToast, setAppToast] = useState<string | null>(null);
  const [openRouterModel, setOpenRouterModel] = useState('');
  const [openRouterApiKey, setOpenRouterApiKey] = useState('');
  const [openRouterApiKeySet, setOpenRouterApiKeySet] = useState(false);
  const [openRouterSaving, setOpenRouterSaving] = useState(false);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pausedRef = useRef(false);
  const authActive = authEnabled === true;
  const authReady = authEnabled === false || authUser !== null;
  const isAdmin = authUser?.role === 'admin';
  const canManageDashboards = authActive ? isAdmin : unauthAdminEnabled;
  const isMember = authActive && !isAdmin;
  const dataLocked =
    authActive &&
    !isAdmin &&
    accountDropsLoaded &&
    !accountDrops.some((d) => Boolean(d.can_query));
  const authClient = useMemo(() => createAuthClient({ baseURL: window.location.origin }), []);

  const formatDropDisplay = useCallback((drop?: { name: string; label?: string | null } | null) => {
    if (!drop) return '';
    const label = (drop.label ?? '').trim();
    return label ? label : drop.name;
  }, []);

  const dropLabel = useCallback(
    (id: number) => {
      const fromAll = drops.find((d) => d.id === id);
      const fromAccount = accountDrops.find((d) => d.id === id);
      const drop = fromAll || fromAccount;
      if (!drop) return `Drop #${id}`;
      const display = formatDropDisplay(drop);
      const identity = drop.name;
      const suffix = display !== identity ? ` (${identity})` : '';
      return `${display}${suffix} (#${id})`;
    },
    [drops, accountDrops, formatDropDisplay]
  );

  useEffect(() => {
    if (tab !== 'settings') return;
    if (!authReady) return;
    // When auth is enabled, non-admins cannot access admin-only settings tabs.
    const adminOnly = settingsTab === 'users' || settingsTab === 'auth' || settingsTab === 'integrations';
    if (authActive && !isAdmin && adminOnly) {
      setSettingsTab('account');
    }
  }, [tab, settingsTab, authActive, isAdmin, authReady]);

  useEffect(() => {
    if (!authReady) return;
    if (!dataLocked) return;
    if (tab !== 'settings') {
      setTab('settings');
      setSettingsTab('account');
    }
  }, [authReady, dataLocked, tab]);

  // Persist tab + settings sub-tab selection via URL (refresh-safe).
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    if (tab === 'settings') {
      url.searchParams.set('settings', settingsTab);
    } else {
      url.searchParams.delete('settings');
    }
    if (dropId !== null) {
      url.searchParams.set('drop', String(dropId));
    } else {
      url.searchParams.delete('drop');
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [tab, settingsTab, dropId]);

  useEffect(() => {
    window.localStorage.setItem('raphael.dashboardMode', dashboardMode);
  }, [dashboardMode]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const fetchAuthMe = useCallback(async () => {
    if (!authEnabled) return;
    try {
      const json = await fetchJson<{ user?: { id: string; email: string; role: 'admin' | 'member' } }>('/api/admin/me');
      setAuthUser(json.user ?? null);
    } catch (error) {
      console.error('Failed to fetch auth session:', error);
      setAuthUser(null);
    }
  }, [authEnabled]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const json = await fetchJson<{
          enabled?: boolean;
          mode?: 'disabled' | 'oauth_only' | 'password_only' | 'hybrid';
          email_password_enabled?: boolean;
          providers?: Array<{ id: string; label: string }>;
          oauth_allowlist?: { enabled: boolean; domains_count: number; emails_count: number };
          unauthenticated_admin_enabled?: boolean;
          base_url_set?: boolean;
          trusted_origins_set?: boolean;
        }>('/api/auth/config');
        if (cancelled) return;
        const enabled = Boolean(json?.enabled);
        setAuthEnabled(enabled);
        setAuthMode(json?.mode ?? (enabled ? 'oauth_only' : 'disabled'));
        setAuthEmailPasswordEnabled(Boolean(json?.email_password_enabled));
        setAuthProviders(json?.providers ?? []);
        setAuthAllowlistSummary(json?.oauth_allowlist ?? null);
        setUnauthAdminEnabled(Boolean(json?.unauthenticated_admin_enabled));
        setAuthBaseUrlSet(Boolean(json?.base_url_set));
        setAuthTrustedOriginsSet(Boolean(json?.trusted_origins_set));
        setAuthError(null);
        if (!enabled) {
          setAuthUser(null);
          return;
        }
        await fetchAuthMe();
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to fetch auth config:', error);
        setAuthEnabled(false);
        setAuthMode('disabled');
        setAuthError('Failed to load auth config');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchAuthMe]);

  // Support back/forward navigation if the user edits the URL or uses history.
  useEffect(() => {
    const onPopState = () => {
      const next =
        parseTab(new URLSearchParams(window.location.search).get('tab')) ??
        parseTab(window.location.hash.replace(/^#/, ''));
      if (next && next !== tab) setTab(next);

      const nextSettings = parseSettingsTab(new URLSearchParams(window.location.search).get('settings'));
      if (nextSettings && nextSettings !== settingsTab) setSettingsTab(nextSettings);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [tab, settingsTab]);

  const fetchData = useCallback(async () => {
    if (!authReady) return;
    if (dataLocked) return;
    const activeDropId = dropIdRef.current;
    if (activeDropId === null) return;
    const seq = ++dataRequestSeqRef.current;
    setListLoading(true);
    try {
      const [tracesJson, eventsJson, nextStats] = await Promise.all([
        fetchJson<{ items?: Trace[]; nextCursor?: number | null } | Trace[]>(
          `/api/traces?dropId=${activeDropId}&limit=${LIST_PAGE_SIZE}&envelope=1`
        ),
        fetchJson<{ items?: WideEvent[]; nextCursor?: number | null } | WideEvent[]>(
          `/api/events?dropId=${activeDropId}&limit=${LIST_PAGE_SIZE}&envelope=1`
        ),
        fetchJson<Stats>(`/api/stats?dropId=${activeDropId}`),
      ]);
      if (seq !== dataRequestSeqRef.current || activeDropId !== dropIdRef.current) return;
      const nextTraces = Array.isArray(tracesJson) ? tracesJson : tracesJson.items ?? [];
      const nextEvents = Array.isArray(eventsJson) ? eventsJson : eventsJson.items ?? [];
      setTraces(Array.isArray(nextTraces) ? nextTraces : []);
      setEvents(Array.isArray(nextEvents) ? nextEvents : []);
      setTraceNextCursor(Array.isArray(tracesJson) ? null : tracesJson.nextCursor ?? null);
      setEventNextCursor(Array.isArray(eventsJson) ? null : eventsJson.nextCursor ?? null);
      setStats(nextStats);
    } catch (error) {
      console.error('Failed to fetch data:', error);
      if (seq === dataRequestSeqRef.current) {
        setTraces([]);
        setEvents([]);
        setTraceNextCursor(null);
        setEventNextCursor(null);
        setStats({ traces: 0, wideEvents: 0, errors: 0 });
      }
    } finally {
      if (seq === dataRequestSeqRef.current) setListLoading(false);
    }
  }, [authReady, dataLocked]);

  const fetchMoreListRows = useCallback(async () => {
    if (!authReady) return;
    if (dataLocked) return;
    const activeDropId = dropIdRef.current;
    if (activeDropId === null) return;
    if (tab !== 'events' && tab !== 'traces') return;
    const cursor = tab === 'events' ? eventNextCursor : traceNextCursor;
    if (!cursor) return;
    setListLoading(true);
    try {
      const resource = tab === 'events' ? 'events' : 'traces';
      const json = await fetchJson<{ items?: Array<Trace | WideEvent>; nextCursor?: number | null } | Array<Trace | WideEvent>>(
        `/api/${resource}?dropId=${activeDropId}&limit=${LIST_PAGE_SIZE}&beforeId=${cursor}&envelope=1`
      );
      const items = Array.isArray(json) ? json : json.items ?? [];
      const nextCursor = Array.isArray(json) ? null : json.nextCursor ?? null;
      if (activeDropId !== dropIdRef.current) return;
      if (tab === 'events') {
        setEvents((prev) => [...prev, ...(items as WideEvent[])]);
        setEventNextCursor(nextCursor);
      } else {
        setTraces((prev) => [...prev, ...(items as Trace[])]);
        setTraceNextCursor(nextCursor);
      }
    } catch (error) {
      console.error('Failed to fetch older rows:', error);
      setAppToast('Failed to load older rows');
    } finally {
      setListLoading(false);
    }
  }, [authReady, dataLocked, tab, eventNextCursor, traceNextCursor]);

  const fetchDrops = useCallback(async () => {
    if (!authReady) return;
    try {
      const json = await fetchJson<{ default_drop_id: number; drops: Drop[] }>('/api/drops');
      const nextDrops = Array.isArray(json.drops) ? json.drops : [];
      setDrops(nextDrops);
      setDefaultDropId(json.default_drop_id);

      const urlDropRaw = new URLSearchParams(window.location.search).get('drop');
      const urlDropId = urlDropRaw && /^\d+$/.test(urlDropRaw) ? Number.parseInt(urlDropRaw, 10) : null;
      const stored = window.localStorage.getItem('raphael.dropId');
      const storedId = stored && /^\d+$/.test(stored) ? Number.parseInt(stored, 10) : null;
      const desired = urlDropId ?? storedId ?? json.default_drop_id;
      const exists = nextDrops.some((d) => d.id === desired);
      setDropId(exists ? desired : nextDrops[0]?.id ?? null);
    } catch (error) {
      console.error('Failed to fetch drops:', error);
      setDrops([]);
      setDropId(null);
    }
  }, [authReady]);

  const fetchDashboards = useCallback(async () => {
    if (!authReady) return;
    const activeDropId = dropIdRef.current;
    if (activeDropId === null) return;
    const seq = ++dashboardRequestSeqRef.current;
    try {
      const rows = await fetchJson<DashboardRow[]>(`/api/dashboards?dropId=${activeDropId}`);
      if (seq !== dashboardRequestSeqRef.current || activeDropId !== dropIdRef.current) return;
      setDashboards(rows);
      if (dashboardSelectedId !== null && !rows.some((d) => d.id === dashboardSelectedId)) {
        setDashboardSelectedId(null);
        setDashboardSpec(null);
        setDashboardName('');
        setDashboardSample([]);
      }
    } catch (error) {
      console.error('Failed to fetch dashboards:', error);
      if (seq === dashboardRequestSeqRef.current) {
        setDashboards([]);
        setDashboardSelectedId(null);
        setDashboardSpec(null);
        setDashboardName('');
        setDashboardSample([]);
      }
    }
  }, [dashboardSelectedId, authReady]);

  const fetchServiceAccounts = useCallback(async () => {
    if (!authActive || !authUser) return;
    try {
      const rows = await fetchJson<Array<{ id: number; name: string; created_at: number; created_by_email: string | null }>>(
        '/api/account/service-accounts'
      );
      setServiceAccounts(rows);
      if (rows.length && selectedServiceAccountId === null) {
        setSelectedServiceAccountId(rows[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch service accounts:', error);
    }
  }, [authActive, authUser, selectedServiceAccountId]);

  const fetchApiKeys = useCallback(async () => {
    if (!authActive || !authUser) return;
    try {
      const rows = await fetchJson<Array<{
        id: number;
        service_account_id: number;
        name: string | null;
        key_prefix: string;
        created_at: number;
        revoked_at: number | null;
        permissions: Array<{ drop_id: number; can_ingest: number; can_query: number }>;
      }>>('/api/account/api-keys');
      setApiKeys(rows);
    } catch (error) {
      console.error('Failed to fetch API keys:', error);
    }
  }, [authActive, authUser]);

  const fetchAccountDrops = useCallback(async () => {
    if (!authActive || !authUser) return;
    try {
      setAccountDropsLoaded(false);
      const json = await fetchJson<{
        drops: Array<{ id: number; name: string; label: string | null; can_ingest: number; can_query: number }>;
      }>('/api/account/drops');
      setAccountDrops(json.drops ?? []);
    } catch (error) {
      console.error('Failed to fetch account drops:', error);
      setAccountDrops([]);
    } finally {
      setAccountDropsLoaded(true);
    }
  }, [authActive, authUser]);

  const refreshAuthAssets = useCallback(async () => {
    await Promise.all([fetchAccountDrops(), fetchServiceAccounts(), fetchApiKeys()]);
  }, [fetchAccountDrops, fetchServiceAccounts, fetchApiKeys]);

  // Keep account drop permissions fresh so we can gate UX when a user has no query access.
  useEffect(() => {
    if (!authReady) return;
    if (!authActive || !authUser) {
      setAccountDrops([]);
      setAccountDropsLoaded(false);
      return;
    }
    void fetchAccountDrops();
  }, [authReady, authActive, authUser, fetchAccountDrops]);

  const fetchUsers = useCallback(async () => {
    if (!authActive || !authUser || !isAdmin) return;
    try {
      const rows = await fetchJson<Array<{
        user_id: string;
        email: string;
        role: 'admin' | 'member';
        disabled: number;
        protected_admin?: boolean;
        created_at: number;
        last_login_at: number | null;
      }>>('/api/admin/users');
      setUsers(rows);
      if (rows.length > 0) {
        if (!selectedUserId || !rows.some((u) => u.user_id === selectedUserId)) {
          setSelectedUserId(rows[0].user_id);
        }
      } else {
        setSelectedUserId(null);
      }
    } catch (error) {
      console.error('Failed to fetch users:', error);
    }
  }, [authActive, authUser, isAdmin, selectedUserId]);

  const fetchAuthPolicy = useCallback(async () => {
    if (!authActive || !authUser || !isAdmin) return;
    try {
      setAuthPolicyError(null);
      const json = await fetchJson<{
        oauth_only?: boolean;
        allowed_domains?: string[];
        allowed_emails?: string[];
        default_permissions?: Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>;
        error?: string;
      }>('/api/admin/auth-policy');
      const domains = (json.allowed_domains ?? []).join('\n');
      const emails = (json.allowed_emails ?? []).join('\n');
      setAuthPolicyDomains(domains);
      setAuthPolicyEmails(emails);
      setAuthPolicyDefaultPermissions(
        (json.default_permissions ?? []).map((p) => ({
          drop_id: Number(p.drop_id),
          can_ingest: Boolean(p.can_ingest),
          can_query: Boolean(p.can_query),
        }))
      );
    } catch (error) {
      console.error('Failed to fetch auth policy:', error);
      setAuthPolicyError((error as Error).message);
    }
  }, [authActive, authUser, isAdmin]);

  const saveAuthPolicy = useCallback(async () => {
    if (!authActive || !authUser || !isAdmin) return;
    setAuthPolicySaving(true);
    setAuthPolicyError(null);
    try {
      const domains = authPolicyDomains
        .split(/[\n,]/g)
        .map((d) => d.trim())
        .filter(Boolean);
      const emails = authPolicyEmails
        .split(/[\n,]/g)
        .map((e) => e.trim())
        .filter(Boolean);
      const json = await fetchJson<{
        allowed_domains?: string[];
        allowed_emails?: string[];
        default_permissions?: Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>;
        error?: string;
      }>('/api/admin/auth-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowed_domains: domains, allowed_emails: emails, default_permissions: authPolicyDefaultPermissions }),
      });
      setAuthPolicyDomains((json.allowed_domains ?? []).join('\n'));
      setAuthPolicyEmails((json.allowed_emails ?? []).join('\n'));
      setAuthPolicyDefaultPermissions(
        (json.default_permissions ?? []).map((p) => ({
          drop_id: Number(p.drop_id),
          can_ingest: Boolean(p.can_ingest),
          can_query: Boolean(p.can_query),
        }))
      );
      setAppToast('Auth policy saved');
      await fetchAuthPolicy();
    } catch (error) {
      console.error('Failed to save auth policy:', error);
      setAuthPolicyError((error as Error).message);
    } finally {
      setAuthPolicySaving(false);
    }
  }, [authActive, authUser, isAdmin, authPolicyDomains, authPolicyEmails, authPolicyDefaultPermissions, fetchAuthPolicy]);

  const fetchUserPermissions = useCallback(
    async (userId: string) => {
      if (!authActive || !authUser || !isAdmin) return;
      try {
        const rows = await fetchJson<Array<{ drop_id: number; can_ingest: number; can_query: number }>>(
          `/api/admin/users/${userId}/permissions`
        );
        setUserPermissions(rows);
      } catch (error) {
        console.error('Failed to fetch user permissions:', error);
        setUserPermissions([]);
      }
    },
    [authActive, authUser, isAdmin]
  );

  const handleSaveUserProfile = useCallback(async () => {
    if (!selectedUserId) return;
    setUserSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${selectedUserId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: selectedUserRole, disabled: selectedUserDisabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to update user');
      setUsers((prev) => prev.map((u) => (u.user_id === selectedUserId ? { ...u, ...json } : u)));
      if (authUser && authUser.id === selectedUserId) {
        setAuthUser({ ...authUser, role: selectedUserRole });
      }
      setAppToast('User updated');
    } catch (error) {
      console.error('Failed to update user:', error);
      setAppToast('Failed to update user');
    } finally {
      setUserSaving(false);
    }
  }, [selectedUserId, selectedUserRole, selectedUserDisabled, authUser]);

  const generatePassword = useCallback(() => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += alphabet[b % alphabet.length];
    setNewUserPassword(out);
  }, []);

  const handleCreateUser = useCallback(async () => {
    if (!newUserEmail.trim() || !newUserPassword.trim()) {
      setAppToast('Email and password are required');
      return;
    }
    const permissions = newUserPermissions.filter((p) => p.can_ingest || p.can_query);
    if (newUserRole !== 'admin' && permissions.length === 0) {
      setAppToast('Assign at least one drop permission (ingest or query)');
      return;
    }
    setNewUserCreating(true);
    try {
      const email = newUserEmail.trim();
      const password = newUserPassword;
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          role: newUserRole,
          permissions,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to create user');
      setCreatedUserCreds({ email, password, role: newUserRole });
      setAppToast('User created');
      await fetchUsers();
      if (json?.user_id) setSelectedUserId(json.user_id);
    } catch (error) {
      console.error('Failed to create user:', error);
      setAppToast((error as Error).message || 'Failed to create user');
    } finally {
      setNewUserCreating(false);
    }
  }, [newUserEmail, newUserPassword, newUserRole, newUserPermissions, fetchUsers]);

  const openAddUserModal = useCallback(() => {
    setCreatedUserCreds(null);
    setNewUserEmail('');
    setNewUserPassword('');
    setNewUserRole('member');
    const defaultDropId = dropId ?? drops[0]?.id ?? null;
    setNewUserPermissions(defaultDropId ? [{ drop_id: defaultDropId, can_ingest: false, can_query: true }] : []);
    setShowAddUserModal(true);
  }, [dropId, drops]);

  const closeAddUserModal = useCallback(() => {
    if (newUserCreating) return;
    setShowAddUserModal(false);
    setCreatedUserCreds(null);
    setNewUserEmail('');
    setNewUserPassword('');
    setNewUserRole('member');
    setNewUserPermissions([]);
  }, [newUserCreating]);

  const handleSaveUserPermissions = useCallback(async () => {
    if (!selectedUserId) return;
    setUserSaving(true);
    try {
      const permissions = drops.map((drop) => {
        const existing = userPermissions.find((p) => p.drop_id === drop.id);
        return {
          drop_id: drop.id,
          can_ingest: Boolean(existing?.can_ingest),
          can_query: Boolean(existing?.can_query),
        };
      });
      const res = await fetch(`/api/admin/users/${selectedUserId}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to update permissions');
      setUserPermissions(json ?? []);
      setAppToast('Permissions updated');
    } catch (error) {
      console.error('Failed to update permissions:', error);
      setAppToast('Failed to update permissions');
    } finally {
      setUserSaving(false);
    }
  }, [selectedUserId, drops, userPermissions]);

  const handleLogin = useCallback(async () => {
    if (!loginEmail || !loginPassword) {
      setAuthError('Email and password are required');
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      const { error } = await authClient.signIn.email({
        email: loginEmail,
        password: loginPassword,
        callbackURL: window.location.origin,
      });
      if (error) throw new Error(error.message || 'Login failed');
      await fetchAuthMe();
      setLoginPassword('');
      setAuthError(null);
    } catch (error) {
      setAuthError((error as Error).message);
    } finally {
      setAuthLoading(false);
    }
  }, [loginEmail, loginPassword, authClient, fetchAuthMe]);

  const handleSocialLogin = useCallback(
    async (providerId: string) => {
      setAuthLoading(true);
      setAuthError(null);
      try {
        const { error } = await authClient.signIn.social({
          provider: providerId,
          callbackURL: window.location.origin,
        });
        if (error) throw new Error(error.message || 'Login failed');
      } catch (error) {
        setAuthError((error as Error).message);
      } finally {
        setAuthLoading(false);
      }
    },
    [authClient]
  );

  const handleLogout = useCallback(async () => {
    try {
      await authClient.signOut();
    } finally {
      setAuthUser(null);
      setServiceAccounts([]);
      setApiKeys([]);
      setAccountDrops([]);
      setAccountDropsLoaded(false);
    }
  }, [authClient]);

  const handleCreateServiceAccount = useCallback(async () => {
    if (!newServiceAccountName.trim()) return;
    try {
      const res = await fetch('/api/account/service-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newServiceAccountName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to create service account');
      setNewServiceAccountName('');
      await refreshAuthAssets();
    } catch (error) {
      console.error('Failed to create service account:', error);
      setAppToast('Failed to create service account');
    }
  }, [newServiceAccountName, refreshAuthAssets]);

  const handleDeleteServiceAccount = useCallback(
    async (id: number) => {
      if (!confirm('Delete this service account? This will revoke all associated API keys.')) return;
      try {
        const res = await fetch(`/api/account/service-accounts/${id}`, { method: 'DELETE' });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || 'Failed to delete service account');
        if (selectedServiceAccountId === id) setSelectedServiceAccountId(null);
        await refreshAuthAssets();
      } catch (error) {
        console.error('Failed to delete service account:', error);
        setAppToast('Failed to delete service account');
      }
    },
    [refreshAuthAssets, selectedServiceAccountId]
  );

  const handleCreateApiKey = useCallback(async () => {
    if (!selectedServiceAccountId) return;
    if (!apiKeyDropId) {
      setAppToast('Select a drop for API key permissions');
      return;
    }
    if (!apiKeyCanIngest && !apiKeyCanQuery) {
      setAppToast('Select at least one permission (ingest or query)');
      return;
    }
    try {
      const res = await fetch('/api/account/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_account_id: selectedServiceAccountId,
          name: newApiKeyName || null,
          permissions: [
            {
              drop_id: apiKeyDropId,
              can_ingest: apiKeyCanIngest,
              can_query: apiKeyCanQuery,
            },
          ],
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to create API key');
      setGeneratedApiKey(json.api_key);
      setGeneratedApiKeyMeta(`Prefix ${json.key_prefix} • SA ${json.service_account_id}`);
      setShowApiKeyModal(true);
      setNewApiKeyName('');
      await refreshAuthAssets();
    } catch (error) {
      console.error('Failed to create API key:', error);
      setAppToast('Failed to create API key');
    }
  }, [selectedServiceAccountId, apiKeyDropId, apiKeyCanIngest, apiKeyCanQuery, newApiKeyName, refreshAuthAssets]);

  const handleRevokeApiKey = useCallback(async (id: number) => {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/account/api-keys/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to revoke API key');
      await refreshAuthAssets();
    } catch (error) {
      console.error('Failed to revoke API key:', error);
      setAppToast('Failed to revoke API key');
    }
  }, [refreshAuthAssets]);

  const handleSearch = useCallback(async () => {
    if (!authReady) return;
    if (!search.trim()) {
      fetchData();
      return;
    }
    try {
      if (dropIdRef.current === null) return;
      if (tab === 'dashboards' || tab === 'settings') return;
      if (tab === 'traces') {
        const rows = await fetchJson<Trace[]>(
          `/api/search/traces?dropId=${dropIdRef.current}&q=${encodeURIComponent(search)}&limit=${LIST_PAGE_SIZE}`
        );
        setTraces(Array.isArray(rows) ? rows : []);
        setTraceNextCursor(null);
      } else {
        const rows = await fetchJson<WideEvent[]>(
          `/api/search/events?dropId=${dropIdRef.current}&q=${encodeURIComponent(search)}&limit=${LIST_PAGE_SIZE}`
        );
        setEvents(Array.isArray(rows) ? rows : []);
        setEventNextCursor(null);
      }
    } catch (error) {
      console.error('Search failed:', error);
    }
  }, [search, tab, fetchData, authReady]);

  const handleClear = async () => {
    if (!authReady) return;
    if (!confirm('Clear all traces and events?')) return;
    if (dropIdRef.current === null) return;
    try {
      await fetchJson<{ success: boolean }>(`/api/clear?dropId=${dropIdRef.current}`, { method: 'DELETE' });
      fetchData();
    } catch (error) {
      setAppToast((error as Error).message || 'Clear failed');
    }
  };

  useEffect(() => {
    fetchDrops();
  }, [fetchDrops]);

  const subscribeWs = useCallback((id: number | null) => {
    if (id === null) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', dropId: id }));
    }
  }, []);

  useEffect(() => {
    if (!authReady) return;
    if (dataLocked) return;
    if (dropId === null) return;
    dropIdRef.current = dropId;
    window.localStorage.setItem('raphael.dropId', String(dropId));

    const current = drops.find((d) => d.id === dropId);
    if (current) {
      setDropLabelDraft(current.label ?? '');
      setShowDeleteDrop(false);
      setDeleteDropConfirm('');
      setRetentionTracesDays(
        current.traces_retention_ms ? String(Math.round(current.traces_retention_ms / (24 * 60 * 60 * 1000))) : '0'
      );
      setRetentionEventsDays(
        current.events_retention_ms ? String(Math.round(current.events_retention_ms / (24 * 60 * 60 * 1000))) : '0'
      );
    }

    setSelected(null);
    fetchData();
    fetchDashboards();
    subscribeWs(dropId);
  }, [dropId, drops, fetchData, subscribeWs, fetchDashboards, authReady, dataLocked]);

  useEffect(() => {
    if (tab !== 'dashboards') return;
    if (!dashboardSpec) return;
    void ensureDashboardDataLoaded();
  }, [tab, dashboardSpec]);

  useEffect(() => {
    if (!authReady) return;
    if (tab !== 'settings') return;
    if (settingsTab !== 'integrations') return;
    if (authActive && !isAdmin) return;
    void (async () => {
      try {
        const json = await fetchJson<{ model: string; api_key_set: boolean }>('/api/settings/openrouter');
        setOpenRouterModel(json.model || '');
        setOpenRouterApiKeySet(Boolean(json.api_key_set));
      } catch (error) {
        console.error('Failed to fetch OpenRouter settings:', error);
      }
    })();
  }, [tab, authReady, authActive, isAdmin, settingsTab]);

  useEffect(() => {
    if (tab !== 'settings') return;
    if (!authReady) return;

    if (settingsTab === 'service_accounts') {
      if (authActive && authUser) void refreshAuthAssets();
      return;
    }

    if (settingsTab === 'users') {
      if (isAdmin) void fetchUsers();
      return;
    }

    if (settingsTab === 'auth') {
      if (isAdmin) void fetchAuthPolicy();
      return;
    }
  }, [tab, authReady, settingsTab, authActive, authUser, isAdmin, refreshAuthAssets, fetchUsers, fetchAuthPolicy]);

  useEffect(() => {
    if (!selectedUserId) return;
    const user = users.find((u) => u.user_id === selectedUserId);
    if (user) {
      setSelectedUserRole(user.role);
      setSelectedUserDisabled(Boolean(user.disabled));
    }
    void fetchUserPermissions(selectedUserId);
  }, [selectedUserId, users, fetchUserPermissions]);

  useEffect(() => {
    if (!authActive || !authUser) return;
    if (accountDrops.length === 0) return;

    const currentDropId = dropId ?? null;
    const hasCurrent = currentDropId !== null && accountDrops.some((d) => d.id === currentDropId);

    if (apiKeyDropId === null) {
      setApiKeyDropId(hasCurrent ? (currentDropId as number) : accountDrops[0].id);
      return;
    }
    if (!accountDrops.some((d) => d.id === apiKeyDropId)) {
      setApiKeyDropId(hasCurrent ? (currentDropId as number) : accountDrops[0].id);
    }
  }, [apiKeyDropId, dropId, accountDrops, authActive, authUser]);

  useEffect(() => {
    if (!authActive || !authUser) return;
    if (apiKeyDropId === null) return;
    const d = accountDrops.find((x) => x.id === apiKeyDropId);
    if (!d) return;
    const canIngest = Boolean(d.can_ingest) || isAdmin;
    const canQuery = Boolean(d.can_query) || isAdmin;
    if (!canIngest && apiKeyCanIngest) setApiKeyCanIngest(false);
    if (!canQuery && apiKeyCanQuery) setApiKeyCanQuery(false);
    if (canIngest === false && canQuery === false) {
      // This should not happen if /api/account/drops is correct, but keep the UI safe.
      setApiKeyCanIngest(false);
      setApiKeyCanQuery(false);
    }
  }, [apiKeyDropId, accountDrops, authActive, authUser, isAdmin, apiKeyCanIngest, apiKeyCanQuery]);

  useEffect(() => {
    if (authEnabled === null) return;
    if (authActive && !authUser) return;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (disposed) return;
        setConnected(true);
        console.log('WebSocket connected');
        subscribeWs(dropIdRef.current);
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        console.log('WebSocket disconnected, reconnecting...');
        reconnectTimer = window.setTimeout(connect, 2000);
      };

      ws.onmessage = (event) => {
        if (pausedRef.current) return;

        let data: any;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data?.drop_id !== undefined && dropIdRef.current !== null && data.drop_id !== dropIdRef.current) return;

        if (data.type === 'traces') {
          setTraces((prev) => {
            const newTraces = data.data.map((t: Trace) => ({
              ...t,
              created_at: t.created_at || t.start_time || Date.now(),
            }));
            return [...newTraces, ...prev].slice(0, 500);
          });
          setStats((prev) => ({ ...prev, traces: prev.traces + data.data.length }));
        } else if (data.type === 'wide_events') {
          setEvents((prev) => {
            const newEvents = data.data.map((e: WideEvent) => ({
              ...e,
              created_at: e.created_at || Date.now(),
            }));
            return [...newEvents, ...prev].slice(0, 500);
          });
          const errorCount = data.data.filter((e: WideEvent) => e.outcome === 'error').length;
          setStats((prev) => ({
            ...prev,
            wideEvents: prev.wideEvents + data.data.length,
            errors: prev.errors + errorCount,
          }));
        }
      };

      wsRef.current = ws;
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [subscribeWs, authEnabled, authActive, authUser]);

  const activeFilters: FilterState =
    tab === 'events' ? eventFilters : tab === 'traces' ? traceFilters : {};
  const noopFilterSetter: FilterSetter = () => {};
  const setActiveFilters: FilterSetter =
    tab === 'events'
      ? (setEventFilters as unknown as FilterSetter)
      : tab === 'traces'
        ? (setTraceFilters as unknown as FilterSetter)
        : noopFilterSetter;

  const visibleEvents = applyFilters('events', events, eventFilters, search);
  const visibleTraces = applyFilters('traces', traces, traceFilters, search);

  const effectiveDashboardSpec: DashboardSpecV1 | null = dashboardSpec
    ? {
        ...dashboardSpec,
        name: dashboardName || dashboardSpec.name,
        sampleSize: Math.max(100, Math.min(20_000, Number(dashboardSpec.sampleSize ?? 2000))),
        bucketSeconds: Math.max(10, Math.min(3600, Number(dashboardSpec.bucketSeconds ?? 60))),
      }
    : null;

  const dashboardComputeKey = useMemo(() => {
    if (!effectiveDashboardSpec) return '';
    return JSON.stringify({
      bucketSeconds: effectiveDashboardSpec.bucketSeconds,
      widgets: effectiveDashboardSpec.widgets.map((w) => {
        const base: any = { id: w.id, type: w.type, title: w.title };
        if (w.type === 'stat') base.metric = (w as any).metric;
        if (w.type === 'timeseries') base.metric = (w as any).metric;
        if (w.type === 'bar') {
          base.field = (w as any).field;
          base.topN = (w as any).topN;
        }
        if (w.type === 'histogram') {
          base.field = (w as any).field;
          base.bins = (w as any).bins;
        }
        return base;
      }),
    });
  }, [effectiveDashboardSpec]);

  const dashboardWidgetResults = useMemo(() => {
    if (!effectiveDashboardSpec || dashboardSample.length === 0) return new Map<string, any>();
    const map = new Map<string, any>();
    for (const w of effectiveDashboardSpec.widgets) {
      const withoutLayout = { ...w, layout: undefined } as any;
      map.set(w.id, computeWidget(withoutLayout, dashboardSample as any, effectiveDashboardSpec));
    }
    return map;
  }, [dashboardSample, dashboardComputeKey]);

  const dashboardContainer = useContainerWidth();

  useEffect(() => {
    if (!effectiveDashboardSpec) {
      setDashboardEditingWidgetId(null);
      return;
    }
    if (dashboardMode === 'view' || !canManageDashboards) {
      setDashboardEditingWidgetId(null);
      return;
    }
    if (
      dashboardEditingWidgetId &&
      effectiveDashboardSpec.widgets.some((w) => w.id === dashboardEditingWidgetId)
    ) {
      return;
    }
    setDashboardEditingWidgetId(effectiveDashboardSpec.widgets[0]?.id ?? null);
  }, [effectiveDashboardSpec, dashboardEditingWidgetId, dashboardMode, canManageDashboards]);

  useEffect(() => {
    if (!canManageDashboards && dashboardMode === 'edit') {
      setDashboardMode('view');
    }
  }, [canManageDashboards, dashboardMode]);

  const statsForTab =
    tab === 'events'
      ? computeFieldStats('events', events, Object.keys(activeFilters))
      : tab === 'traces'
        ? computeFieldStats('traces', traces, Object.keys(activeFilters))
        : [];
  const suggestedKeys = statsForTab.slice(0, 8).map((s) => s.key);
  const filterKeys = Array.from(new Set([...suggestedKeys, ...Object.keys(activeFilters)]));
  const statsByKey = new Map(statsForTab.map((s) => [s.key, s]));

  const toggleInValue = (key: string, value: string) => {
    setActiveFilters((prev) => {
      const normalizedKey = normalizeFilterKey(tab, key);
      const current = prev[normalizedKey] ?? { op: 'in' as const, values: [] as string[] };
      const nextValues = current.values.includes(value)
        ? current.values.filter((v) => v !== value)
        : [...current.values, value];
      const next: FilterState = { ...prev, [normalizedKey]: { op: 'in', values: nextValues } };
      if (next[normalizedKey].values.length === 0) {
        delete next[normalizedKey];
      }
      return next;
    });
  };

  const addContainsToken = (key: string, token: string) => {
    const cleaned = token.trim();
    if (!cleaned) return;
    setActiveFilters((prev) => {
      const normalizedKey = normalizeFilterKey(tab, key);
      const current = prev[normalizedKey] ?? { op: 'contains' as const, values: [] as string[] };
      const values = current.values.includes(cleaned) ? current.values : [...current.values, cleaned];
      return { ...prev, [normalizedKey]: { op: 'contains', values } };
    });
  };

  const clearFilterKey = (key: string) => {
    setActiveFilters((prev) => {
      const normalizedKey = normalizeFilterKey(tab, key);
      if (!prev[normalizedKey]) return prev;
      const next: FilterState = { ...prev };
      delete next[normalizedKey];
      return next;
    });
  };

  const clearAllFilters = () => {
    if (tab === 'events') setEventFilters({});
    else setTraceFilters({});
  };

  const handleCreateDrop = async () => {
    const name = newDropName.trim();
    if (!name) return;
    try {
      const res = await fetch('/api/drops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to create drop');
      }
      const created = (await res.json()) as { id: number };
      setNewDropName('');
      await fetchDrops();
      setDropId(created.id);
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const handleSaveRetention = async () => {
    if (dropIdRef.current === null) return;
    const tracesDays = Number(retentionTracesDays);
    const eventsDays = Number(retentionEventsDays);
    if (!Number.isFinite(tracesDays) || tracesDays < 0) return alert('Trace retention must be a non-negative number');
    if (!Number.isFinite(eventsDays) || eventsDays < 0) return alert('Event retention must be a non-negative number');

    try {
      const res = await fetch(`/api/drops/${dropIdRef.current}/retention`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traces_days: tracesDays, events_days: eventsDays }),
      });
      if (!res.ok) throw new Error('Failed to save retention');
      await fetchDrops();
      fetchData();
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const handleSaveDropLabel = async () => {
    if (dropIdRef.current === null) return;
    setDropLabelSaving(true);
    try {
      const res = await fetch(`/api/drops/${dropIdRef.current}/label`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: dropLabelDraft.trim() ? dropLabelDraft.trim() : null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to save drop label');
      }
      await fetchDrops();
      flashToast('Saved drop label');
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setDropLabelSaving(false);
    }
  };

  const handleDeleteDrop = async () => {
    if (dropIdRef.current === null) return;
    if (defaultDropId !== null && dropIdRef.current === defaultDropId) {
      return alert('Cannot delete the default drop.');
    }
    if (drops.length <= 1) {
      return alert('Cannot delete the last remaining drop.');
    }
    const current = drops.find((d) => d.id === dropIdRef.current) ?? null;
    if (!current) return;

    const typed = deleteDropConfirm.trim();
    if (typed !== current.name) {
      return alert(`Type the drop ID exactly to confirm: ${current.name}`);
    }

    const ok = confirm(
      `Permanently delete drop "${formatDropDisplay(current)}" (ID: ${current.name})?\n\nThis will delete all traces, wide events, dashboards, and permissions for this drop.`
    );
    if (!ok) return;

    setDeleteDropDeleting(true);
    try {
      const res = await fetch(`/api/drops/${dropIdRef.current}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to delete drop');
      }
      setShowDeleteDrop(false);
      setDeleteDropConfirm('');
      await fetchDrops();
      flashToast('Deleted drop');
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setDeleteDropDeleting(false);
    }
  };

  const flashToast = (message: string) => {
    setAppToast(message);
    setTimeout(() => setAppToast(null), 2000);
  };

  const uuid = (prefix = 'w') =>
    `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 8)}`;

  const loadDashboard = async (id: number) => {
    if (dropIdRef.current === null) return;
    setDashboardLoading(true);
    try {
      const row = await fetchJson<DashboardRow>(`/api/dashboards/${id}?dropId=${dropIdRef.current}`);
      setDashboardSelectedId(row.id);
      setDashboardName(row.name);
      const spec = parseDashboardSpec(row.spec_json);
      setDashboardSpec(spec ? normalizeDashboardSpec(spec) : null);
      setDashboardSample([]);
      setDashboardEditingWidgetId(null);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setDashboardLoading(false);
    }
  };

  const refreshDashboardSample = async () => {
    if (dropIdRef.current === null) return;
    if (!dashboardSpec) return;
    setDashboardLoading(true);
    try {
      const limit = Math.max(100, Math.min(20_000, Number(dashboardSpec.sampleSize ?? 2000)));
      const data = await fetchJson<WideEvent[]>(`/api/events?dropId=${dropIdRef.current}&limit=${limit}`);
      setDashboardSample(data);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setDashboardLoading(false);
    }
  };

  const createNewDashboard = async () => {
    if (dropIdRef.current === null) return;
    const name = newDashboardName.trim();
    if (!name) return;
    const defaultSpec: DashboardSpecV1 = {
      version: 1,
      name,
      sampleSize: 2000,
      bucketSeconds: 60,
      widgets: [
        { id: uuid('stat'), type: 'stat', title: 'Events', metric: 'events', layout: { x: 0, y: 0, w: 3, h: 1 } },
        { id: uuid('stat'), type: 'stat', title: 'Errors', metric: 'errors', layout: { x: 3, y: 0, w: 3, h: 1 } },
        { id: uuid('stat'), type: 'stat', title: 'Error rate', metric: 'error_rate', layout: { x: 6, y: 0, w: 3, h: 1 } },
        { id: uuid('bar'), type: 'bar', title: 'Top services', field: 'service_name', topN: 8, layout: { x: 0, y: 1, w: 6, h: 2 } },
        { id: uuid('hist'), type: 'histogram', title: 'Duration (ms)', field: 'duration_ms', bins: 12, layout: { x: 6, y: 1, w: 6, h: 2 } },
      ],
    };

    try {
      const res = await fetch(`/api/dashboards?dropId=${dropIdRef.current}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, spec: normalizeDashboardSpec(defaultSpec) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to create dashboard');
      }
      const row = (await res.json()) as DashboardRow;
      setShowNewDashboard(false);
      setNewDashboardName('My Dashboard');
      await fetchDashboards();
      setDashboardSelectedId(row.id);
      setDashboardName(row.name);
      const spec = parseDashboardSpec(row.spec_json);
      setDashboardSpec(spec ? normalizeDashboardSpec(spec) : null);
      setDashboardSample([]);
      setDashboardEditingWidgetId(null);
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const saveDashboard = async () => {
    if (dropIdRef.current === null) return;
    if (!dashboardSpec) return;
    try {
      const creating = dashboardSelectedId === null;
      const url = creating
        ? `/api/dashboards?dropId=${dropIdRef.current}`
        : `/api/dashboards/${dashboardSelectedId}?dropId=${dropIdRef.current}`;
      const method = creating ? 'POST' : 'PUT';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dashboardName, spec: dashboardSpec }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to save dashboard');
      }
      const row = (await res.json()) as DashboardRow;
      await fetchDashboards();
      setDashboardSelectedId(row.id);
      setDashboardName(row.name);
      const spec = parseDashboardSpec(row.spec_json);
      setDashboardSpec(spec ? normalizeDashboardSpec(spec) : null);
      flashToast('Dashboard saved');
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const deleteDashboardById = async () => {
    if (dropIdRef.current === null) return;
    if (dashboardSelectedId === null) return;
    if (!confirm('Delete this dashboard?')) return;
    try {
      const res = await fetch(`/api/dashboards/${dashboardSelectedId}?dropId=${dropIdRef.current}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      setDashboardSelectedId(null);
      setDashboardSpec(null);
      setDashboardName('');
      setDashboardSample([]);
      setDashboardEditingWidgetId(null);
      await fetchDashboards();
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const generateDashboard = async () => {
    if (dropIdRef.current === null) return;
    const limit = Number(generateLimit);
    if (!Number.isFinite(limit) || limit < 100) return alert('Limit must be >= 100');
    setDashboardLoading(true);
    try {
      const res = await fetch(`/api/dashboards/generate?dropId=${dropIdRef.current}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit, use_ai: generateUseAi, ack_external_ai: generateUseAi }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'Failed to generate dashboard');
      const spec = json.spec as DashboardSpecV1;
      setDashboardSelectedId(null);
      setDashboardName(spec.name || 'Auto dashboard');
      setDashboardSpec(normalizeDashboardSpec(spec));
      setShowGenerateDashboard(false);
      setTab('dashboards');
      setDashboardSample([]);
      setDashboardEditingWidgetId(null);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setDashboardLoading(false);
    }
  };

  const saveOpenRouterSettings = async () => {
    setOpenRouterSaving(true);
    try {
      const res = await fetch('/api/settings/openrouter', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: openRouterModel,
          api_key: openRouterApiKey.trim() ? openRouterApiKey.trim() : undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'Failed to save OpenRouter settings');
      setOpenRouterApiKey('');
      setOpenRouterApiKeySet(Boolean(json.api_key_set));
      setOpenRouterModel(json.model || openRouterModel);
      flashToast('OpenRouter settings saved');
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setOpenRouterSaving(false);
    }
  };

  const clearOpenRouterKey = async () => {
    if (!confirm('Clear stored OpenRouter API key?')) return;
    setOpenRouterSaving(true);
    try {
      const res = await fetch('/api/settings/openrouter', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: '' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'Failed to clear OpenRouter API key');
      setOpenRouterApiKey('');
      setOpenRouterApiKeySet(false);
      flashToast('OpenRouter API key cleared');
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setOpenRouterSaving(false);
    }
  };

  const updateDashboardSpec = (fn: (prev: DashboardSpecV1) => DashboardSpecV1) => {
    setDashboardSpec((prev) => (prev ? fn(prev) : prev));
  };

  const applyDashboardGridLayout = (layout: Layout) => {
    if (dashboardMode !== 'edit') return;
    const byId = new Map(layout.map((l) => [l.i, l]));
    updateDashboardSpec((prev) => {
      let changed = false;
      const widgets = prev.widgets.map((w) => {
        const l = byId.get(w.id);
        if (!l) return w;
        const defaults = defaultWidgetLayout(w);
        const current = {
          x: w.layout?.x ?? 0,
          y: w.layout?.y ?? 0,
          w: w.layout?.w ?? defaults.w,
          h: w.layout?.h ?? defaults.h,
        };
        const next = { ...current, x: l.x, y: l.y, w: l.w, h: l.h };
        if (current.x === next.x && current.y === next.y && current.w === next.w && current.h === next.h) return w;
        changed = true;
        return { ...w, layout: next } as WidgetSpec;
      });
      return changed ? { ...prev, widgets } : prev;
    });
  };

  const addDashboardWidget = (type: WidgetSpec['type']) => {
    updateDashboardSpec((prev) => {
      const baseLayout = { w: 6, h: 2 };
      const widget: WidgetSpec =
        type === 'stat'
          ? { id: uuid('stat'), type: 'stat', title: 'New stat', metric: 'events', layout: { w: 3, h: 1 } }
          : type === 'bar'
            ? { id: uuid('bar'), type: 'bar', title: 'New bar', field: 'service_name', topN: 8, layout: baseLayout }
            : type === 'timeseries'
              ? { id: uuid('ts'), type: 'timeseries', title: 'New series', metric: 'events', layout: baseLayout }
              : { id: uuid('hist'), type: 'histogram', title: 'New histogram', field: 'duration_ms', bins: 12, layout: baseLayout };
      const normalized = normalizeDashboardSpec(prev);
      const placed = addPlacedWidget(normalized.widgets, widget);
      return { ...normalized, widgets: [...normalized.widgets, placed] };
    });
  };

  const deleteDashboardWidget = (id: string) => {
    updateDashboardSpec((prev) => ({ ...prev, widgets: prev.widgets.filter((w) => w.id !== id) }));
  };

  const moveDashboardWidget = (id: string, dir: -1 | 1) => {
    updateDashboardSpec((prev) => {
      const idx = prev.widgets.findIndex((w) => w.id === id);
      if (idx < 0) return prev;
      const nextIdx = idx + dir;
      if (nextIdx < 0 || nextIdx >= prev.widgets.length) return prev;
      const widgets = [...prev.widgets];
      const [w] = widgets.splice(idx, 1);
      widgets.splice(nextIdx, 0, w);
      return { ...prev, widgets };
    });
  };

  const setWidget = (id: string, partial: Partial<WidgetSpec>) => {
    updateDashboardSpec((prev) => ({
      ...prev,
      widgets: prev.widgets.map((w) => (w.id === id ? ({ ...w, ...partial } as WidgetSpec) : w)),
    }));
  };

  const renderLineChart = (points: Array<{ t: number; v: number }>, color: string) => {
    if (points.length < 2) return <div style={styles.tiny}>Not enough data</div>;
    const width = 640;
    const height = 110;
    const padding = 8;
    const xs = points.map((p) => p.t);
    const ys = points.map((p) => p.v);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dx = Math.max(1, maxX - minX);
    const dy = Math.max(1e-9, maxY - minY);

    const scaleX = (t: number) => padding + ((t - minX) / dx) * (width - padding * 2);
    const scaleY = (v: number) => height - padding - ((v - minY) / dy) * (height - padding * 2);

    const d = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(p.t).toFixed(2)} ${scaleY(p.v).toFixed(2)}`)
      .join(' ');

    return (
      <svg viewBox={`0 0 ${width} ${height}`} style={styles.chart}>
        <path d={d} fill="none" stroke={color} strokeWidth="2" />
        <path
          d={`${d} L ${scaleX(points[points.length - 1].t).toFixed(2)} ${height - padding} L ${scaleX(points[0].t).toFixed(2)} ${height - padding} Z`}
          fill={color}
          opacity="0.08"
        />
      </svg>
    );
  };

  const renderHistogram = (bins: Array<{ x0: number; x1: number; count: number }>, color: string) => {
    if (!bins.length) return <div style={styles.tiny}>No numeric values</div>;
    const width = 640;
    const height = 110;
    const padding = 8;
    const max = Math.max(...bins.map((b) => b.count));
    const barW = (width - padding * 2) / bins.length;

    return (
      <svg viewBox={`0 0 ${width} ${height}`} style={styles.chart}>
        {bins.map((b, i) => {
          const h = max ? (b.count / max) * (height - padding * 2) : 0;
          const x = padding + i * barW;
          const y = height - padding - h;
          return <rect key={i} x={x} y={y} width={Math.max(1, barW - 1)} height={h} fill={color} opacity="0.9" />;
        })}
      </svg>
    );
  };

  async function ensureDashboardDataLoaded() {
    if (!dashboardSpec) return;
    if (dashboardSample.length > 0) return;
    await refreshDashboardSample();
  }

  if (authEnabled === null) {
    return (
      <div style={{ ...styles.container, alignItems: 'center', justifyContent: 'center', background: '#0b0b0b', color: '#fff' }}>
        Loading…
      </div>
    );
  }

  if (authEnabled && !authUser) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          padding: '40px 16px',
          position: 'relative',
          overflow: 'hidden',
          background:
            'radial-gradient(1200px circle at 18% 8%, rgba(99,102,241,0.18), transparent 42%), radial-gradient(900px circle at 84% 18%, rgba(34,197,94,0.12), transparent 46%), radial-gradient(1100px circle at 52% 86%, rgba(251,191,36,0.10), transparent 55%), linear-gradient(180deg, #070707, #0b0b0b 40%, #050505)',
        }}
      >
        <style>{`
          @keyframes authIn {
            from { opacity: 0; transform: translateY(10px) scale(0.99); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          .auth-card { animation: authIn 260ms ease-out both; }
          .auth-btn { transition: transform 120ms ease, background 120ms ease, border-color 120ms ease, opacity 120ms ease; }
          .auth-btn:hover { transform: translateY(-1px); border-color: rgba(255,255,255,0.16); background: rgba(255,255,255,0.06); }
          .auth-btn:active { transform: translateY(0); }
          .auth-input { transition: border-color 120ms ease, box-shadow 120ms ease; }
          .auth-input:focus { border-color: rgba(99,102,241,0.55); box-shadow: 0 0 0 3px rgba(99,102,241,0.14); }
          @media (prefers-reduced-motion: reduce) {
            .auth-card { animation: none; }
            .auth-btn { transition: none; }
            .auth-input { transition: none; }
          }
        `}</style>

        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            opacity: 0.26,
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)',
            backgroundSize: '34px 34px',
            maskImage: 'radial-gradient(circle at 50% 30%, rgba(0,0,0,1), rgba(0,0,0,0.05) 72%)',
            pointerEvents: 'none',
          }}
        />

        <div
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'grid',
            justifyItems: 'center',
            gap: '10px',
            marginBottom: '14px',
            textAlign: 'center' as const,
          }}
        >
          <img
            src="/raphael-icon-192.png"
            alt="Raphael"
            width={96}
            height={96}
            style={{
              display: 'block',
              filter:
                'drop-shadow(0 28px 70px rgba(0,0,0,0.62)) drop-shadow(0 14px 34px rgba(99,102,241,0.24))',
            }}
          />
          <div style={{ color: '#fff', fontSize: '26px', fontWeight: 950, letterSpacing: '-0.03em' }}>Raphael</div>
          <div style={{ color: 'rgba(255,255,255,0.62)', fontSize: '13px' }}>
            The watcher who heals
          </div>
        </div>

        <div
          className="auth-card"
          style={{
            width: '100%',
            maxWidth: '460px',
            borderRadius: '16px',
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(16,16,16,0.72)',
            boxShadow: '0 26px 70px rgba(0,0,0,0.65)',
            backdropFilter: 'blur(10px)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '18px 18px 14px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              background:
                'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.00))',
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '12px',
            }}
          >
            <div style={{ display: 'grid', gap: '4px' }}>
              <div style={{ color: '#fff', fontSize: '16px', fontWeight: 850, letterSpacing: '-0.01em' }}>Sign in</div>
              <div style={{ color: 'rgba(255,255,255,0.64)', fontSize: '12px' }}>Sign in to view and query telemetry</div>
            </div>
            <div style={{ ...styles.badgeOutline, borderColor: 'rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.25)', color: '#e5e7eb' }}>
              Auth enabled
            </div>
          </div>

          <div style={{ padding: '16px 18px 18px' }}>
            {authProviders.length > 0 && (
		                              <div style={{ display: 'grid', gap: '10px' }}>
                {authProviders.map((provider) => (
                  <button
                    key={provider.id}
                    className="auth-btn"
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: '10px',
                      border: '1px solid rgba(255,255,255,0.12)',
                      background: 'rgba(255,255,255,0.04)',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: 650,
                      textAlign: 'center',
                    }}
                    onClick={() => handleSocialLogin(provider.id)}
                    disabled={authLoading}
                  >
                    Continue with {provider.label}
                  </button>
                ))}
              </div>
            )}

            {authEmailPasswordEnabled && (
              <>
                {(authProviders.length > 0) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '14px 0' }}>
                    <div style={{ height: '1px', flex: 1, background: 'rgba(255,255,255,0.10)' }} />
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', letterSpacing: '0.08em', textTransform: 'uppercase' as const }}>
                      or
                    </div>
                    <div style={{ height: '1px', flex: 1, background: 'rgba(255,255,255,0.10)' }} />
                  </div>
                )}

                <div style={{ display: 'grid', gap: '10px' }}>
                  <div style={{ display: 'grid', gap: '6px' }}>
                    <div style={{ ...styles.metaLabel, color: 'rgba(255,255,255,0.70)' }}>Email</div>
                    <input
                      className="auth-input"
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        borderRadius: '10px',
                        border: '1px solid rgba(255,255,255,0.12)',
                        background: 'rgba(0,0,0,0.35)',
                        color: '#fff',
                        outline: 'none',
                        fontSize: '14px',
                      }}
                      placeholder="you@example.com"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                      autoComplete="email"
                    />
                  </div>

                  <div style={{ display: 'grid', gap: '6px' }}>
                    <div style={{ ...styles.metaLabel, color: 'rgba(255,255,255,0.70)' }}>Password</div>
                    <input
                      className="auth-input"
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        borderRadius: '10px',
                        border: '1px solid rgba(255,255,255,0.12)',
                        background: 'rgba(0,0,0,0.35)',
                        color: '#fff',
                        outline: 'none',
                        fontSize: '14px',
                      }}
                      type="password"
                      placeholder="••••••••"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                      autoComplete="current-password"
                    />
                  </div>

                  <button
                    className="auth-btn"
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: '10px',
                      border: '1px solid rgba(99,102,241,0.55)',
                      background: 'linear-gradient(180deg, rgba(99,102,241,0.45), rgba(99,102,241,0.22))',
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: 750,
                    }}
                    onClick={handleLogin}
                    disabled={authLoading}
                  >
                    {authLoading ? 'Signing in…' : 'Sign in'}
                  </button>
                </div>
              </>
            )}

            {!authEmailPasswordEnabled && authProviders.length === 0 && (
              <div style={{ color: 'rgba(255,255,255,0.66)', fontSize: '13px' }}>
                No authentication providers configured. Set provider environment variables to enable login.
              </div>
            )}

            {authError && (
              <div
                style={{
                  marginTop: '12px',
                  padding: '10px 12px',
                  borderRadius: '10px',
                  border: '1px solid rgba(239,68,68,0.25)',
                  background: 'rgba(127,29,29,0.25)',
                  color: '#fecaca',
                  fontSize: '12px',
                }}
              >
                {authError}
              </div>
            )}

            {import.meta.env.DEV && (
              <div style={{ marginTop: '14px', color: 'rgba(255,255,255,0.45)', fontSize: '11px', lineHeight: 1.5 }}>
                Tip: if you are using Vite dev (`http://localhost:5173`), set `BETTER_AUTH_BASE_URL` and `RAPHAEL_AUTH_TRUSTED_ORIGINS` to that origin.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        tr:hover { background: #1a1a1a; }
        input::placeholder { color: #666; }
        button:hover { opacity: 0.9; }
        @media (max-width: 640px) {
          .app-header {
            height: auto !important;
            min-height: 72px;
            padding: 12px 16px !important;
            gap: 10px;
            flex-wrap: wrap;
          }
          .app-header-brand {
            width: 100%;
            justify-content: space-between;
            min-width: 0;
          }
          .app-header-stats {
            width: 100%;
            justify-content: space-between;
            gap: 8px !important;
          }
          .app-sticky-nav {
            position: static !important;
          }
        }
      `}</style>

      <header className="app-header" style={styles.header}>
        <div className="app-header-brand" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={styles.logo}>
            <img
              src="/raphael-icon-192.png"
              alt="Raphael"
              width={30}
              height={30}
              style={{
                display: 'block',
                filter:
                  'drop-shadow(0 0 10px rgba(99,102,241,0.55)) drop-shadow(0 0 22px rgba(59,130,246,0.30))',
              }}
            />
            Raphael
          </div>
          <button
            type="button"
            onClick={() => {
              setTab('settings');
              setSettingsTab('drops');
            }}
            title="Open Drops settings"
            style={{
              ...styles.pill,
              cursor: 'pointer',
            }}
          >
            Drop:
            <span style={{ color: '#fff' }}>
              {dataLocked
                ? 'No query access'
                : formatDropDisplay(drops.find((d) => d.id === dropId) ?? null) ||
                  (dropId === null ? 'loading…' : `#${dropId}`)}
            </span>
          </button>
        </div>
        <div className="app-header-stats" style={styles.stats}>
          <div style={styles.stat}>
            <div style={styles.statValue}>{stats.wideEvents}</div>
            <div style={styles.statLabel}>Events</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statValue}>{stats.traces}</div>
            <div style={styles.statLabel}>Traces</div>
          </div>
          <div style={styles.stat}>
            <div style={{ ...styles.statValue, color: stats.errors > 0 ? '#ef4444' : undefined }}>
              {stats.errors}
            </div>
            <div style={styles.statLabel}>Errors</div>
          </div>
        </div>
	      </header>

	      <main style={styles.main}>
	        <div className="app-sticky-nav" style={styles.stickyNav}>
	          <div style={styles.tabs}>
		          <button
		            style={{
		              ...styles.tab,
		              ...(tab === 'events' ? styles.tabActive : {}),
	              ...(dataLocked ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
	            }}
	            onClick={() => setTab('events')}
	            disabled={dataLocked}
	            title={dataLocked ? 'No query permissions assigned' : undefined}
		          >
		            Wide Events
		          </button>
		          <button
	            style={{
	              ...styles.tab,
	              ...(tab === 'traces' ? styles.tabActive : {}),
	              ...(dataLocked ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
	            }}
	            onClick={() => setTab('traces')}
	            disabled={dataLocked}
	            title={dataLocked ? 'No query permissions assigned' : undefined}
		          >
		            Traces
		          </button>
		          <button
	            style={{
	              ...styles.tab,
	              ...(tab === 'dashboards' ? styles.tabActive : {}),
	              ...(dataLocked ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
	            }}
	            onClick={() => setTab('dashboards')}
	            disabled={dataLocked}
	            title={dataLocked ? 'No query permissions assigned' : undefined}
		          >
		            Dashboards
		          </button>
	          <button
	            style={{ ...styles.tab, ...(tab === 'settings' ? styles.tabActive : {}) }}
	            onClick={() => setTab('settings')}
	          >
	            Settings
	          </button>
	          </div>

	          <div style={styles.toolbar}>
		          {tab === 'dashboards' ? (
		            <>
              {canManageDashboards && (
                <>
                  <button
                    style={styles.button}
                    onClick={() => setDashboardMode(dashboardMode === 'edit' ? 'view' : 'edit')}
                    disabled={!dashboardSpec}
                    title={dashboardMode === 'edit' ? 'Hide config knobs' : 'Show config knobs'}
                  >
                    {dashboardMode === 'edit' ? 'View Mode' : 'Edit Mode'}
                  </button>
                  <button style={styles.button} onClick={() => setShowNewDashboard(true)} disabled={dropId === null}>
                    New Dashboard
                  </button>
                  <button style={styles.button} onClick={() => setShowGenerateDashboard(true)} disabled={dropId === null}>
                    Generate
                  </button>
                </>
              )}
              <button style={styles.button} onClick={fetchDashboards} disabled={dropId === null}>
                Refresh List
              </button>
              <button style={styles.button} onClick={refreshDashboardSample} disabled={!dashboardSpec || dropId === null}>
                Refresh Data
              </button>
              {canManageDashboards && dashboardMode === 'edit' && (
                <>
                  <button style={styles.button} onClick={saveDashboard} disabled={!dashboardSpec || dropId === null}>
                    Save
                  </button>
                  <button
                    style={{ ...styles.button, ...styles.buttonDanger }}
                    onClick={deleteDashboardById}
                    disabled={dashboardSelectedId === null}
                  >
                    Delete
                  </button>
                </>
              )}
              <div style={styles.pill}>
                Sample:
                <span style={{ color: '#fff' }}>
                  {dashboardSpec?.sampleSize ?? '-'} / loaded {dashboardSample.length}
                </span>
              </div>
            </>
          ) : tab === 'settings' ? (
            <div style={styles.pill}>
              <span style={{ color: '#fff' }}>Settings</span>
              <span style={{ color: '#777' }}>
                {settingsTab === 'account'
                  ? 'Account'
                  : settingsTab === 'drops'
                    ? 'Drops'
                    : settingsTab === 'service_accounts'
                      ? 'Service Accounts'
                      : settingsTab === 'auth'
                        ? 'Auth'
                        : settingsTab === 'users'
                          ? 'Users'
                          : 'Integrations'}
              </span>
            </div>
		          ) : (
		            <>
		              <input
		                type="text"
                placeholder="Search..."
                style={styles.searchInput}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
              <button style={styles.button} onClick={handleSearch}>
                Search
              </button>
              <button style={styles.button} onClick={() => setShowFilters(!showFilters)}>
                {showFilters ? 'Hide Filters' : 'Filters'} ({Object.keys(activeFilters).length})
              </button>
              {Object.keys(activeFilters).length > 0 && (
                <button style={styles.button} onClick={clearAllFilters}>
                  Clear Filters
                </button>
              )}
              {Object.entries(activeFilters).map(([key, filter]) => (
                <span key={key} style={styles.chip} title={`${key} ${filter.op} ${filter.values.join(', ')}`}>
                  <span style={{ ...styles.mono, color: '#e5e7eb' }}>{key}</span>
                  <span style={{ color: '#777' }}>{filter.op === 'contains' ? '∋' : '='}</span>
                  <span>{truncate(filter.values.join(', '), 26)}</span>
                  <button
                    style={styles.chipButton}
                    onClick={() => clearFilterKey(key)}
                    aria-label={`Remove ${key} filter`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <button style={styles.button} onClick={() => setPaused(!paused)}>
                {paused ? 'Resume' : 'Pause'}
              </button>
              <button style={{ ...styles.button, ...styles.buttonDanger }} onClick={handleClear}>
                Clear
              </button>
              <div style={styles.liveIndicator}>
                {connected && !paused && <div style={styles.liveDot} />}
                {connected ? (paused ? 'Paused' : 'Live') : 'Disconnected'}
              </div>
            </>
		          )}
	          </div>
	        </div>

	        {tab !== 'dashboards' && tab !== 'settings' && showFilters && (
	          <div style={styles.filtersPanel}>
	            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '12px' }}>
	              <div style={{ color: '#fff', fontWeight: 700 }}>Smart Filters</div>
              <div style={{ color: '#777', fontSize: '12px' }}>
                Suggested fields update as logs stream in (high-cardinality fields use token search).
              </div>
            </div>

            <div style={styles.filtersGrid}>
              {filterKeys.map((key) => {
                const stat = statsByKey.get(key);
                const filter = activeFilters[key];
                const isHigh = stat?.highCardinality ?? true;

                return (
                  <div key={key} style={styles.filterCard}>
                    <div style={styles.filterCardTitle}>
                      <span style={{ ...styles.mono, color: '#e5e7eb' }}>{key}</span>
                      <span style={styles.filterHint}>
                        {stat
                          ? isHigh
                            ? `high-card (${stat.distinct})`
                            : `${stat.distinct} values`
                          : 'custom'}
                      </span>
                    </div>

                    {isHigh ? (
                      <>
                        <input
                          style={styles.filterInput}
                          placeholder="Add token (press Enter)…"
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            const input = e.currentTarget;
                            addContainsToken(key, input.value);
                            input.value = '';
                          }}
                        />
                        <div style={{ ...styles.filterValues, marginTop: '10px' }}>
                          {(filter?.values ?? []).map((v) => (
                            <span key={v} style={{ ...styles.chip, borderColor: '#6366f1' }}>
                              {v}
                              <button
                                style={styles.chipButton}
                                onClick={() => {
                                  setActiveFilters((prev) => {
                                    const cur = prev[key];
                                    if (!cur) return prev;
                                    const nextValues = cur.values.filter((x) => x !== v);
                                    const next: FilterState = { ...prev, [key]: { op: 'contains', values: nextValues } };
                                    if (next[key].values.length === 0) delete next[key];
                                    return next;
                                  });
                                }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          {stat?.valuesTop?.map(({ value }) => (
                            <button
                              key={value}
                              style={{ ...styles.chip, cursor: 'pointer', background: '#141414' }}
                              onClick={() => addContainsToken(key, value)}
                              title="Add token"
                            >
                              {value}
                            </button>
                          ))}
                          {filter?.values?.length ? (
                            <button style={styles.button} onClick={() => clearFilterKey(key)}>
                              Clear
                            </button>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <div style={styles.filterValues}>
                        {(stat?.valuesTop ?? []).map(({ value, count }) => {
                          const selected = filter?.op === 'in' && filter.values.includes(value);
                          return (
                            <button
                              key={value}
                              style={{
                                ...styles.chip,
                                cursor: 'pointer',
                                borderColor: selected ? '#6366f1' : '#333',
                                background: selected ? '#1b1b3a' : '#0f0f0f',
                                color: selected ? '#fff' : '#ddd',
                              }}
                              onClick={() => toggleInValue(key, value)}
                              title={`${count} occurrences`}
                            >
                              {value}
                              <span style={{ color: selected ? '#c7d2fe' : '#777' }}>({count})</span>
                            </button>
                          );
                        })}
                        {filter?.values?.length ? (
                          <button style={styles.button} onClick={() => clearFilterKey(key)}>
                            Clear
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={styles.content}>
          {tab === 'dashboards' ? (
            <div style={{ display: 'flex', gap: '16px', alignItems: 'stretch' }}>
              <div style={{ ...styles.pane, flex: '0 0 340px' }}>
                <div style={styles.paneHeader}>
                  <span style={styles.paneTitle}>Dashboards</span>
                  <button style={styles.copyButton} onClick={fetchDashboards}>
                    Refresh
                  </button>
                </div>
                <div style={styles.paneBody}>
                  {dashboards.length === 0 ? (
                    <div style={styles.tiny}>
                      No dashboards yet. Create one or generate from the last N wide events.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {dashboards.map((d) => (
                        <button
                          key={d.id}
                          style={{
                            ...styles.button,
                            textAlign: 'left' as const,
                            background: d.id === dashboardSelectedId ? '#1b1b3a' : '#222',
                            border: d.id === dashboardSelectedId ? '1px solid #6366f1' : '1px solid #333',
                          }}
                          onClick={() => loadDashboard(d.id)}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                            <span>{d.name}</span>
                            <span style={{ color: '#777', fontSize: '12px' }}>#{d.id}</span>
                          </div>
                          <div style={{ color: '#777', fontSize: '11px', marginTop: '4px' }}>
                            Updated: {new Date(d.updated_at).toLocaleString()}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #222' }}>
                    <div style={styles.tiny}>
                      Builder edits a JSON dashboard spec. Save stores it per Drop.
                    </div>
                  </div>
                </div>
              </div>

              <div
                style={{
                  ...styles.pane,
                  flex: 1,
                  ...(dashboardMode === 'view'
                    ? { borderColor: '#14532d', background: '#0b1410' }
                    : { borderColor: '#333' }),
                }}
              >
                <div style={styles.paneHeader}>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <span style={styles.paneTitle}>{dashboardMode === 'view' ? 'Dashboard' : 'Builder'}</span>
                    <span
                      style={{
                        ...styles.badgeOutline,
                        ...(dashboardMode === 'view' ? styles.badgeView : styles.badgeEdit),
                      }}
                    >
                      {dashboardMode === 'view' ? 'VIEW' : 'EDIT'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    {dashboardLoading && <span style={styles.tiny}>Loading…</span>}
                    {dashboardMode === 'view' && effectiveDashboardSpec && (
                      <span style={styles.tiny}>{effectiveDashboardSpec.name}</span>
                    )}
                  </div>
                </div>
                <div style={styles.paneBody}>
                  {!effectiveDashboardSpec ? (
                    <div style={styles.empty}>
                      Select a dashboard, or click “Generate” to create one from the last N events.
                    </div>
                  ) : (
                    <>
                      {dashboardMode === 'edit' && (
                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                          <div>
                            <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Dashboard name</div>
                            <input
                              style={styles.filterInput}
                              value={dashboardName}
                              onChange={(e) => {
                                const name = e.target.value;
                                setDashboardName(name);
                                setDashboardSpec((prev) => (prev ? { ...prev, name } : prev));
                              }}
                            />
                          </div>
                          <div>
                            <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Sample size (N)</div>
                            <input
                              style={styles.filterInput}
                              inputMode="numeric"
                              value={String(effectiveDashboardSpec.sampleSize)}
                              onChange={(e) =>
                                updateDashboardSpec((prev) => ({
                                  ...prev,
                                  sampleSize: Number(e.target.value || '0'),
                                }))
                              }
                            />
                          </div>
                          <div>
                            <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Bucket (sec)</div>
                            <input
                              style={styles.filterInput}
                              inputMode="numeric"
                              value={String(effectiveDashboardSpec.bucketSeconds)}
                              onChange={(e) =>
                                updateDashboardSpec((prev) => ({
                                  ...prev,
                                  bucketSeconds: Number(e.target.value || '0'),
                                }))
                              }
                            />
                          </div>
                        </div>
                      )}

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: dashboardMode === 'edit' ? '420px 1fr' : '1fr',
                          gap: '16px',
                          alignItems: 'start',
                        }}
                      >
                        {dashboardMode === 'edit' && (
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' as const, marginBottom: '12px' }}>
                              <span style={styles.pill}>Add:</span>
                              <button style={styles.button} onClick={() => addDashboardWidget('stat')}>
                                Stat
                              </button>
                              <button style={styles.button} onClick={() => addDashboardWidget('timeseries')}>
                                Timeseries
                              </button>
                              <button style={styles.button} onClick={() => addDashboardWidget('bar')}>
                                Bar
                              </button>
                              <button style={styles.button} onClick={() => addDashboardWidget('histogram')}>
                                Histogram
                              </button>
                            </div>

                            <div style={{ ...styles.pane, overflow: 'hidden', maxHeight: '70vh' }}>
                              <div style={styles.paneHeader}>
                                <span style={styles.paneTitle}>Widgets</span>
                                <span style={styles.tiny}>{effectiveDashboardSpec.widgets.length}</span>
                              </div>
                              <div style={{ ...styles.paneBody, maxHeight: 'calc(70vh - 44px)', padding: 0 }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px' }}>
                                  {effectiveDashboardSpec.widgets.map((w, idx) => {
                                    const expanded = w.id === dashboardEditingWidgetId;

                                    const setWidgetType = (nextType: WidgetSpec['type']) => {
                                      updateDashboardSpec((prev) => ({
                                        ...prev,
                                        widgets: prev.widgets.map((x) => {
                                          if (x.id !== w.id) return x;
                                          if (nextType === 'stat')
                                            return {
                                              id: x.id,
                                              type: 'stat',
                                              title: x.title || 'Stat',
                                              metric: (x as any).metric || 'events',
                                              layout: x.layout ?? { w: 3, h: 1 },
                                            };
                                          if (nextType === 'timeseries')
                                            return {
                                              id: x.id,
                                              type: 'timeseries',
                                              title: x.title || 'Series',
                                              metric: (x as any).metric || 'events',
                                              layout: x.layout ?? { w: 6, h: 2 },
                                            };
                                          if (nextType === 'bar')
                                            return {
                                              id: x.id,
                                              type: 'bar',
                                              title: x.title || 'Bar',
                                              field: (x as any).field || 'service_name',
                                              topN: Number((x as any).topN || 8),
                                              layout: x.layout ?? { w: 6, h: 2 },
                                            };
                                          return {
                                            id: x.id,
                                            type: 'histogram',
                                            title: x.title || 'Histogram',
                                            field: (x as any).field || 'duration_ms',
                                            bins: Number((x as any).bins || 12),
                                            layout: x.layout ?? { w: 6, h: 2 },
                                          };
                                        }),
                                      }));
                                    };

                                    return (
                                      <div
                                        key={w.id}
                                        style={{
                                          border: '1px solid #2a2a2a',
                                          borderRadius: '12px',
                                          background: expanded ? '#0b1020' : '#0f0f0f',
                                          padding: '10px',
                                        }}
                                        onClick={() => setDashboardEditingWidgetId(w.id)}
                                      >
                                        <div
                                          style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            gap: '12px',
                                            alignItems: 'center',
                                          }}
                                        >
                                          <div style={{ minWidth: 0 }}>
                                            <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                                              <span style={{ ...styles.mono, color: '#a78bfa' }}>{w.type}</span>
                                              <span
                                                style={{
                                                  fontSize: '13px',
                                                  color: '#fff',
                                                  fontWeight: 700,
                                                  overflow: 'hidden',
                                                  textOverflow: 'ellipsis',
                                                  whiteSpace: 'nowrap',
                                                  maxWidth: '260px',
                                                  display: 'inline-block',
                                                  verticalAlign: 'bottom',
                                                }}
                                              >
                                                {w.title || '(untitled)'}
                                              </span>
                                            </div>
                                            <div style={styles.tiny}>
                                              layout {w.layout?.w ?? (w.type === 'stat' ? 3 : 6)}×{w.layout?.h ?? (w.type === 'stat' ? 1 : 2)}
                                            </div>
                                          </div>

                                          <div style={{ display: 'flex', gap: '8px' }}>
                                            <button
                                              style={styles.copyButton}
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                moveDashboardWidget(w.id, -1);
                                              }}
                                              disabled={idx === 0}
                                              title="Move up"
                                            >
                                              ↑
                                            </button>
                                            <button
                                              style={styles.copyButton}
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                moveDashboardWidget(w.id, 1);
                                              }}
                                              disabled={idx === effectiveDashboardSpec.widgets.length - 1}
                                              title="Move down"
                                            >
                                              ↓
                                            </button>
                                            <button
                                              style={styles.copyButton}
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                deleteDashboardWidget(w.id);
                                              }}
                                              title="Remove"
                                            >
                                              ×
                                            </button>
                                          </div>
                                        </div>

                                        {expanded && (
                                          <div style={{ marginTop: '10px', display: 'grid', gap: '10px' }}>
                                            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' as const }}>
                                              <select
                                                style={styles.select}
                                                value={w.type}
                                                onChange={(e) => setWidgetType(e.target.value as any)}
                                                onClick={(e) => e.stopPropagation()}
                                              >
                                                <option value="stat">stat</option>
                                                <option value="timeseries">timeseries</option>
                                                <option value="bar">bar</option>
                                                <option value="histogram">histogram</option>
                                              </select>
                                              <input
                                                style={{ ...styles.filterInput, flex: 1, minWidth: '180px' }}
                                                value={w.title}
                                                onChange={(e) => setWidget(w.id, { title: e.target.value } as any)}
                                                onClick={(e) => e.stopPropagation()}
                                                placeholder="Title"
                                              />
                                            </div>

                                            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' as const, alignItems: 'center' }}>
                                              <span style={styles.tiny}>w</span>
                                              <input
                                                style={{ ...styles.filterInput, width: '78px' }}
                                                inputMode="numeric"
                                                value={String(w.layout?.w ?? (w.type === 'stat' ? 3 : 6))}
                                                onChange={(e) =>
                                                  setWidget(w.id, {
                                                    layout: {
                                                      x: w.layout?.x,
                                                      y: w.layout?.y,
                                                      w: clampInt(e.target.value || '6', 1, DASHBOARD_COLS, 6),
                                                      h: clampInt(w.layout?.h ?? (w.type === 'stat' ? 1 : 2), 1, 50, 2),
                                                    },
                                                  } as any)
                                                }
                                                onClick={(e) => e.stopPropagation()}
                                              />
                                              <span style={styles.tiny}>h</span>
                                              <input
                                                style={{ ...styles.filterInput, width: '78px' }}
                                                inputMode="numeric"
                                                value={String(w.layout?.h ?? (w.type === 'stat' ? 1 : 2))}
                                                onChange={(e) =>
                                                  setWidget(w.id, {
                                                    layout: {
                                                      x: w.layout?.x,
                                                      y: w.layout?.y,
                                                      w: clampInt(w.layout?.w ?? (w.type === 'stat' ? 3 : 6), 1, DASHBOARD_COLS, 6),
                                                      h: clampInt(e.target.value || '2', 1, 50, 2),
                                                    },
                                                  } as any)
                                                }
                                                onClick={(e) => e.stopPropagation()}
                                              />

                                              {w.type === 'stat' && (
                                                <select
                                                  style={styles.select}
                                                  value={(w as any).metric}
                                                  onChange={(e) => setWidget(w.id, { metric: e.target.value } as any)}
                                                  onClick={(e) => e.stopPropagation()}
                                                >
                                                  <option value="events">events</option>
                                                  <option value="errors">errors</option>
                                                  <option value="error_rate">error_rate</option>
                                                  <option value="unique_traces">unique_traces</option>
                                                  <option value="unique_users">unique_users</option>
                                                </select>
                                              )}
                                              {w.type === 'timeseries' && (
                                                <select
                                                  style={styles.select}
                                                  value={(w as any).metric}
                                                  onChange={(e) => setWidget(w.id, { metric: e.target.value } as any)}
                                                  onClick={(e) => e.stopPropagation()}
                                                >
                                                  <option value="events">events</option>
                                                  <option value="errors">errors</option>
                                                  <option value="error_rate">error_rate</option>
                                                </select>
                                              )}
                                              {w.type === 'bar' && (
                                                <>
                                                  <input
                                                    style={{ ...styles.filterInput, width: '200px' }}
                                                    value={(w as any).field}
                                                    onChange={(e) => setWidget(w.id, { field: e.target.value } as any)}
                                                    onClick={(e) => e.stopPropagation()}
                                                    placeholder="field (service_name, outcome, operation, user_id, foo.bar)"
                                                  />
                                                  <input
                                                    style={{ ...styles.filterInput, width: '86px' }}
                                                    inputMode="numeric"
                                                    value={String((w as any).topN)}
                                                    onChange={(e) => setWidget(w.id, { topN: Number(e.target.value || '8') } as any)}
                                                    onClick={(e) => e.stopPropagation()}
                                                  />
                                                </>
                                              )}
                                              {w.type === 'histogram' && (
                                                <>
                                                  <input
                                                    style={{ ...styles.filterInput, width: '200px' }}
                                                    value={(w as any).field}
                                                    onChange={(e) => setWidget(w.id, { field: e.target.value } as any)}
                                                    onClick={(e) => e.stopPropagation()}
                                                    placeholder="numeric field (duration_ms, foo.ms)"
                                                  />
                                                  <input
                                                    style={{ ...styles.filterInput, width: '86px' }}
                                                    inputMode="numeric"
                                                    value={String((w as any).bins)}
                                                    onChange={(e) => setWidget(w.id, { bins: Number(e.target.value || '12') } as any)}
                                                    onClick={(e) => e.stopPropagation()}
                                                  />
                                                </>
                                              )}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}

                        <div style={{ ...styles.pane, overflow: 'hidden' }}>
                          <div style={styles.paneHeader}>
                            <span style={styles.paneTitle}>
                              {dashboardMode === 'edit' ? 'Preview' : 'Dashboard'}
                            </span>
                            <span style={styles.tiny}>
                              last {effectiveDashboardSpec.sampleSize} (loaded {dashboardSample.length})
                            </span>
                          </div>
                          <div style={{ ...styles.paneBody, maxHeight: '70vh' }}>
                            {dashboardSample.length === 0 ? (
                              <div style={styles.empty}>No sample loaded. Click “Refresh Data” in the toolbar.</div>
                            ) : (
                              <div ref={dashboardContainer.containerRef} style={{ width: '100%' }}>
                                <GridLayout
                                  width={dashboardContainer.width}
                                  layout={
                                    effectiveDashboardSpec.widgets.map((w) => {
                                      const defaults = defaultWidgetLayout(w);
                                      const l: any = w.layout ?? {};
                                      const ww = clampInt(l.w, 1, DASHBOARD_COLS, defaults.w);
                                      const hh = clampInt(l.h, 1, 50, defaults.h);
                                      const xx = clampInt(l.x, 0, Math.max(0, DASHBOARD_COLS - ww), 0);
                                      const yy = clampInt(l.y, 0, 100_000, 0);
                                      return { i: w.id, x: xx, y: yy, w: ww, h: hh };
                                    }) as unknown as Layout
                                  }
                                  gridConfig={{
                                    cols: DASHBOARD_COLS,
                                    rowHeight: DASHBOARD_ROW_HEIGHT,
                                    margin: [12, 12],
                                    containerPadding: [0, 0],
                                    maxRows: Infinity,
                                  }}
                                  dragConfig={{ enabled: dashboardMode === 'edit', bounded: false, handle: '.drag-handle', threshold: 3 }}
                                  resizeConfig={{ enabled: dashboardMode === 'edit', handles: ['se'] }}
                                  onLayoutChange={applyDashboardGridLayout}
                                >
                                  {effectiveDashboardSpec.widgets.map((w) => {
                                    const result =
                                      dashboardWidgetResults.get(w.id) ??
                                      computeWidget(w as any, dashboardSample as any, effectiveDashboardSpec);
                                    return (
                                      <div key={w.id} style={styles.card}>
                                        <div style={styles.cardHeader}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                                            {dashboardMode === 'edit' && (
                                              <span
                                                className="drag-handle"
                                                title="Drag"
                                                style={{
                                                  cursor: 'grab',
                                                  padding: '2px 6px',
                                                  borderRadius: '6px',
                                                  border: '1px solid #2a2a2a',
                                                  color: '#888',
                                                  fontSize: '12px',
                                                  userSelect: 'none',
                                                }}
                                              >
                                                ⋮⋮
                                              </span>
                                            )}
                                            <span
                                              style={{
                                                ...styles.cardTitle,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {w.title}
                                            </span>
                                          </div>
                                          <span style={styles.tiny}>{w.type}</span>
                                        </div>
                                        <div style={styles.cardBody}>
                                          {result.type === 'stat' ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                              <div style={{ fontSize: '30px', fontWeight: 800, color: '#fff' }}>
                                                {result.data.value}
                                              </div>
                                              {result.data.sub && <div style={styles.tiny}>{result.data.sub}</div>}
                                            </div>
                                          ) : result.type === 'bar' ? (
                                            (() => {
                                              const max = Math.max(1, ...result.data.values);
                                              return (
                                                <div>
                                                  {result.data.labels.map((label: string, i: number) => {
                                                    const v = result.data.values[i];
                                                    const pct = (v / max) * 100;
                                                    return (
                                                      <div key={label} style={styles.barRow}>
                                                        <div style={{ minWidth: 0 }}>
                                                          <div style={styles.barLabel} title={label}>
                                                            {label}
                                                          </div>
                                                          <div style={{ ...styles.barTrack, marginTop: '6px' }}>
                                                            <div style={{ ...styles.barFill, width: `${pct}%` }} />
                                                          </div>
                                                        </div>
                                                        <div style={styles.barValue}>{formatNumber(v)}</div>
                                                      </div>
                                                    );
                                                  })}
                                                </div>
                                              );
                                            })()
                                          ) : result.type === 'timeseries' ? (
                                            <div>
                                              {renderLineChart(
                                                result.data.points,
                                                result.data.unit === '%' ? '#f472b6' : '#6366f1'
                                              )}
                                              <div style={styles.tiny}>Points: {result.data.points.length}</div>
                                            </div>
                                          ) : (
                                            <div>
                                              {renderHistogram(result.data.bins, '#a78bfa')}
                                              <div style={styles.tiny}>Bins: {result.data.bins.length}</div>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </GridLayout>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : tab === 'settings' ? (
            <div style={{ display: 'grid', gap: '16px', alignItems: 'start' }}>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                {(
                  [
                    { id: 'account', label: 'Account', show: true },
                    { id: 'service_accounts', label: 'Service Accounts', show: true },
                    { id: 'drops', label: 'Drops', show: true },
                    { id: 'auth', label: 'Auth', show: !authActive || isAdmin },
                    { id: 'users', label: 'Users', show: !authActive || isAdmin },
                    { id: 'integrations', label: 'Integrations', show: !authActive || isAdmin },
                  ] as Array<{ id: SettingsTab; label: string; show: boolean }>
                )
                  .filter((t) => t.show)
                  .map((t) => {
                    const active = settingsTab === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSettingsTab(t.id)}
                        style={{
                          padding: '8px 12px',
                          borderRadius: '999px',
                          border: `1px solid ${active ? 'rgba(99,102,241,0.55)' : '#222'}`,
                          background: active ? 'rgba(99,102,241,0.16)' : '#0f0f0f',
                          color: active ? '#fff' : '#cbd5e1',
                          fontWeight: 700,
                          cursor: 'pointer',
                          fontSize: '13px',
                        }}
                      >
                        {t.label}
                      </button>
                    );
                  })}
              </div>

              {settingsTab === 'account' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', alignItems: 'start' }}>
                  <div style={styles.pane}>
                    <div style={styles.paneHeader}>
                      <span style={styles.paneTitle}>Account</span>
                      <span style={styles.tiny}>{authActive ? 'Signed in' : 'Auth disabled'}</span>
                    </div>
                    <div style={styles.paneBody}>
                      {authActive ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                          <div style={styles.pill}>
                            User:
                            <span style={{ color: '#fff' }}>{authUser?.email ?? 'unknown'}</span>
                            <span style={{ color: '#777' }}>({authUser?.role ?? 'member'})</span>
                          </div>
                          <button style={styles.button} onClick={handleLogout}>
                            Sign out
                          </button>
                        </div>
                      ) : (
                        <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6 }}>
                          Authentication is disabled. UI access is unrestricted and API keys are not required.
                        </div>
                      )}

                      <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid #222' }}>
                        <div style={{ ...styles.metaLabel, marginBottom: '8px' }}>Auth summary</div>
                        <div style={{ display: 'grid', gap: '8px' }}>
                          <div style={styles.pill}>
                            Mode:
                            <span style={{ color: '#fff' }}>{authMode}</span>
                          </div>
                          <div style={styles.pill}>
                            Providers:
                            <span style={{ color: '#fff' }}>
                              {authProviders.length === 0 ? 'none' : authProviders.map((p) => p.label).join(', ')}
                            </span>
                          </div>
                          <div style={styles.pill}>
                            Email/password:
                            <span style={{ color: '#fff' }}>{authEmailPasswordEnabled ? 'enabled' : 'disabled'}</span>
                          </div>
                          <div style={styles.pill}>
                            Base URL:
                            <span style={{ color: '#fff' }}>{authBaseUrlSet ? 'set' : 'missing'}</span>
                          </div>
                          <div style={styles.pill}>
                            Trusted origins:
                            <span style={{ color: '#fff' }}>{authTrustedOriginsSet ? 'set' : 'missing'}</span>
                          </div>
                          <div style={styles.pill}>
                            OAuth allowlist:
                            <span style={{ color: '#fff' }}>
                              {authAllowlistSummary
                                ? `${authAllowlistSummary.domains_count} domains, ${authAllowlistSummary.emails_count} emails`
                                : 'n/a'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div style={styles.pane}>
                    <div style={styles.paneHeader}>
                      <span style={styles.paneTitle}>Dependency Map</span>
                      <span style={styles.tiny}>What depends on what</span>
                    </div>
                    <div style={styles.paneBody}>
                      <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.7 }}>
                        <ul style={{ margin: 0, paddingLeft: '18px' }}>
                          <li>
                            <span style={styles.mono}>RAPHAEL_AUTH_ENABLED=true</span> requires login for the UI and enforces drop permissions for queries and ingestion.
                          </li>
                          <li>Providers are enabled only when their env vars are configured (buttons appear automatically).</li>
                          <li>
                            OAuth allowlist is enforced only in <span style={styles.mono}>oauth_only</span> mode (email/password disabled).
                          </li>
                          <li>
                            Service accounts and API keys are <b>mine-only</b>. Keys can only be minted with permissions you already have.
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              )}

	              {settingsTab === 'drops' && (
	                <div style={{ display: 'grid', gap: '16px' }}>
                  {authActive && !isAdmin && (
                    <div style={styles.pane}>
                      <div style={styles.paneHeader}>
                        <span style={styles.paneTitle}>Drops</span>
                        <span style={styles.tiny}>Admin-managed</span>
                      </div>
                      <div style={styles.paneBody}>
                        <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6 }}>
                          Drops are managed by admins. You can still query and ingest into drops you have access to.
                        </div>
                        <div style={{ ...styles.tiny, marginTop: '10px', color: 'rgba(255,255,255,0.65)', lineHeight: 1.6 }}>
                          Admin-only controls like <span style={styles.mono}>Create drop</span>, <span style={styles.mono}>Drop label</span>, and retention settings are hidden for non-admins.
                        </div>
                      </div>
                    </div>
                  )}

                  <div style={styles.pane}>
                    <div style={styles.paneHeader}>
                      <span style={styles.paneTitle}>Active Drop</span>
                      <span style={styles.tiny}>Applies across the app</span>
                    </div>
                    <div style={styles.paneBody}>
                      <div style={{ color: '#888', fontSize: '13px', marginBottom: '12px', lineHeight: 1.6 }}>
                        This selection controls what you view in <span style={styles.mono}>Wide Events</span>, <span style={styles.mono}>Traces</span>, and <span style={styles.mono}>Dashboards</span>.
                        Drop retention and routing settings apply to the active drop.
                      </div>
	                      <select
	                        style={{ ...styles.select, width: '100%' }}
	                        value={dropId ?? ''}
	                        onChange={(e) => setDropId(Number(e.target.value))}
	                        disabled={drops.length === 0}
	                        title="Active Drop"
	                      >
                        {drops.map((d) => (
                          <option key={d.id} value={d.id}>
                            {(() => {
                              const display = formatDropDisplay(d);
                              const identity = d.name;
                              return display !== identity ? `${display} (${identity})` : display;
                            })()}
                          </option>
	                        ))}
	                      </select>
	                    </div>
	                  </div>
	
                  {(!authActive || isAdmin) && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', alignItems: 'start' }}>
                      <div style={styles.pane}>
                        <div style={styles.paneHeader}>
                          <span style={styles.paneTitle}>Drop Configuration</span>
                          <span style={styles.tiny}>
                            Active: {formatDropDisplay(drops.find((d) => d.id === dropId) ?? null) || (dropId === null ? '-' : `#${dropId}`)}
                          </span>
                        </div>
	                        <div style={styles.paneBody}>
	                          <div style={{ color: '#888', fontSize: '13px', marginBottom: '12px' }}>
	                            Drops isolate telemetry streams (e.g., staging vs production).
	                          </div>

	                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', alignItems: 'start' }}>
	                            <div style={styles.filterCard}>
	                              <div style={styles.filterCardTitle}>
	                                <span>Current Drop</span>
	                                <span style={styles.filterHint}>
	                                  ID:{' '}
	                                  <span style={styles.mono}>
	                                    {drops.find((d) => d.id === dropId)?.name ?? (dropId === null ? '-' : `#${dropId}`)}
	                                  </span>
	                                </span>
	                              </div>
	                              <div style={{ display: 'grid', gap: '10px' }}>
	                                <div
	                                  style={{
	                                    display: 'grid',
	                                    gridTemplateColumns: '1fr 132px',
	                                    gap: '10px',
	                                    alignItems: 'end',
	                                  }}
	                                >
	                                  <div>
	                                    <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Display label</div>
	                                    <input
	                                      style={styles.filterInput}
	                                      placeholder="Shown in the UI (optional)"
	                                      value={dropLabelDraft}
	                                      onChange={(e) => setDropLabelDraft(e.target.value)}
	                                      onKeyDown={(e) => e.key === 'Enter' && handleSaveDropLabel()}
	                                      disabled={dropId === null}
	                                    />
	                                  </div>
	                                  <button
	                                    style={{ ...styles.button, width: '100%' }}
	                                    onClick={handleSaveDropLabel}
	                                    disabled={dropId === null || dropLabelSaving}
	                                  >
	                                    {dropLabelSaving ? 'Saving…' : 'Save'}
	                                  </button>
	                                </div>
	                                <div style={styles.tiny}>
	                                  Labels are cosmetic. Routing still uses the drop ID above.
	                                </div>
		                                <div style={styles.tiny}>
		                                  Send:{' '}
		                                  <span style={styles.mono}>
		                                    X-Raphael-Drop: {drops.find((d) => d.id === dropId)?.name ?? ''}
		                                  </span>
		                                </div>

		                                <div style={{ marginTop: '6px', paddingTop: '10px', borderTop: '1px solid #242424' }}>
		                                  <div style={{ ...styles.metaLabel, marginBottom: '6px', color: '#fca5a5' }}>Danger zone</div>
		                                  {(() => {
		                                    const isDefault = dropId !== null && defaultDropId !== null && dropId === defaultDropId;
		                                    const isLast = drops.length <= 1;
		                                    const disabled = dropId === null || isDefault || isLast;
		                                    const dropName = drops.find((d) => d.id === dropId)?.name ?? '';
		
		                                    return (
		                                      <div style={{ display: 'grid', gap: '8px' }}>
		                                        {isDefault && (
		                                          <div style={styles.tiny}>
		                                            The default drop cannot be deleted.
		                                          </div>
		                                        )}
		                                        {isLast && (
		                                          <div style={styles.tiny}>
		                                            You can’t delete the last remaining drop.
		                                          </div>
		                                        )}
		                                        <button
		                                          type="button"
		                                          style={{ ...styles.button, ...styles.buttonDanger, width: 'fit-content', opacity: disabled ? 0.6 : 1 }}
		                                          onClick={() => !disabled && setShowDeleteDrop((v) => !v)}
		                                          disabled={disabled}
		                                          title={disabled ? (isDefault ? 'Default drop cannot be deleted' : isLast ? 'Cannot delete last drop' : '') : ''}
		                                        >
		                                          {showDeleteDrop ? 'Cancel delete' : 'Delete this drop…'}
		                                        </button>
		                                        {showDeleteDrop && !disabled && (
		                                          <div style={{ display: 'grid', gap: '8px' }}>
		                                            <div style={styles.tiny}>
		                                              This deletes <b>all</b> traces, wide events, dashboards, and permissions in this drop.
		                                            </div>
		                                            <div style={styles.tiny}>
		                                              Type the drop ID to confirm: <span style={styles.mono}>{dropName}</span>
		                                            </div>
		                                            <div
		                                              style={{
		                                                display: 'grid',
		                                                gridTemplateColumns: '1fr 132px',
		                                                gap: '10px',
		                                                alignItems: 'end',
		                                              }}
		                                            >
		                                              <input
		                                                style={styles.filterInput}
		                                                placeholder="Type drop ID exactly"
		                                                value={deleteDropConfirm}
		                                                onChange={(e) => setDeleteDropConfirm(e.target.value)}
		                                                onKeyDown={(e) => e.key === 'Enter' && handleDeleteDrop()}
		                                                disabled={deleteDropDeleting}
		                                              />
		                                              <button
		                                                type="button"
		                                                style={{ ...styles.button, ...styles.buttonDanger, width: '100%' }}
		                                                onClick={handleDeleteDrop}
		                                                disabled={deleteDropDeleting}
		                                              >
		                                                {deleteDropDeleting ? 'Deleting…' : 'Delete'}
		                                              </button>
		                                            </div>
		                                          </div>
		                                        )}
		                                      </div>
		                                    );
		                                  })()}
		                                </div>
		                              </div>
		                            </div>

	                            <div style={styles.filterCard}>
	                              <div style={styles.filterCardTitle}>
	                                <span>Create New Drop</span>
	                                <span style={styles.filterHint}>New telemetry stream</span>
	                              </div>
	                              <div style={{ display: 'grid', gap: '10px' }}>
	                                <div
	                                  style={{
	                                    display: 'grid',
	                                    gridTemplateColumns: '1fr 132px',
	                                    gap: '10px',
	                                    alignItems: 'end',
	                                  }}
	                                >
	                                  <div>
	                                    <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Drop ID (routing)</div>
	                                    <input
	                                      style={styles.filterInput}
	                                      placeholder="e.g., prod"
	                                      value={newDropName}
	                                      onChange={(e) => setNewDropName(e.target.value)}
	                                      onKeyDown={(e) => e.key === 'Enter' && handleCreateDrop()}
	                                    />
	                                  </div>
	                                  <button
	                                    style={{ ...styles.button, width: '100%' }}
	                                    onClick={handleCreateDrop}
	                                    disabled={!newDropName.trim()}
	                                  >
	                                    Create
	                                  </button>
	                                </div>
	                                <div style={styles.tiny}>
	                                  This ID is what you send in <span style={styles.mono}>X-Raphael-Drop</span> or <span style={styles.mono}>?drop=</span> (max 64 chars).
	                                </div>
	                              </div>
	                            </div>
	                          </div>

	                          <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid #222' }}>
	                            <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Ingest routing</div>
	                            <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.5 }}>
	                              Use header <span style={styles.mono}>X-Raphael-Drop</span> or query <span style={styles.mono}>?drop=</span>.
	                            </div>
	                          </div>
	                        </div>
	                      </div>

                      <div style={styles.pane}>
                        <div style={styles.paneHeader}>
                          <span style={styles.paneTitle}>Retention</span>
                          <span style={styles.tiny}>Per-drop auto-truncation</span>
                        </div>
                        <div style={styles.paneBody}>
                          <div style={{ color: '#888', fontSize: '13px', marginBottom: '14px' }}>
                            Set days to keep per drop (0 disables). Cleanup runs in the background.
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                            <div>
                              <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Traces (days)</div>
                              <input
                                style={styles.filterInput}
                                inputMode="numeric"
                                value={retentionTracesDays}
                                onChange={(e) => setRetentionTracesDays(e.target.value)}
                              />
                            </div>
                            <div>
                              <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Wide Events (days)</div>
                              <input
                                style={styles.filterInput}
                                inputMode="numeric"
                                value={retentionEventsDays}
                                onChange={(e) => setRetentionEventsDays(e.target.value)}
                              />
                            </div>
                          </div>

                          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
                            <button style={styles.button} onClick={handleSaveRetention} disabled={dropId === null}>
                              Save retention
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {settingsTab === 'service_accounts' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', alignItems: 'start' }}>
                  {!authActive ? (
                    <div style={{ ...styles.pane, gridColumn: '1 / -1' }}>
                      <div style={styles.paneHeader}>
                        <span style={styles.paneTitle}>Service Accounts</span>
                        <span style={styles.tiny}>Auth required</span>
                      </div>
                      <div style={styles.paneBody}>
                        <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6 }}>
                          Enable authentication to create service accounts and API keys.
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={styles.pane}>
                        <div style={styles.paneHeader}>
                          <span style={styles.paneTitle}>Service Accounts</span>
                          <span style={styles.tiny}>Mine only</span>
                        </div>
                        <div style={styles.paneBody}>
                          <div style={{ color: '#888', fontSize: '13px', marginBottom: '12px', lineHeight: 1.6 }}>
                            Service accounts are private to your user. Names are unique per user.
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', alignItems: 'end' }}>
                            <div>
                              <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>New service account</div>
                              <input
                                style={styles.filterInput}
                                placeholder="e.g., api-gateway"
                                value={newServiceAccountName}
                                onChange={(e) => setNewServiceAccountName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleCreateServiceAccount()}
                              />
                            </div>
                            <button style={styles.button} onClick={handleCreateServiceAccount} disabled={!newServiceAccountName.trim()}>
                              Create
                            </button>
                          </div>

                          <div style={{ marginTop: '12px', display: 'grid', gap: '8px' }}>
                            {serviceAccounts.length === 0 ? (
                              <div style={styles.tiny}>No service accounts yet.</div>
                            ) : (
                              serviceAccounts.map((sa) => (
                                <div
                                  key={sa.id}
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr auto',
                                    gap: '10px',
                                    alignItems: 'center',
                                    padding: '8px 10px',
                                    borderRadius: '8px',
                                    border: '1px solid #222',
                                    background: selectedServiceAccountId === sa.id ? '#151515' : '#0f0f0f',
                                  }}
                                >
                                  <div style={{ cursor: 'pointer' }} onClick={() => setSelectedServiceAccountId(sa.id)}>
                                    <div style={{ color: '#fff', fontWeight: 600 }}>{sa.name}</div>
                                    <div style={styles.tiny}>Created {new Date(sa.created_at).toLocaleString()}</div>
                                  </div>
                                  <button
                                    style={{ ...styles.button, ...styles.buttonDanger, padding: '6px 10px' }}
                                    onClick={() => handleDeleteServiceAccount(sa.id)}
                                  >
                                    Delete
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>

                      <div style={styles.pane}>
                        <div style={styles.paneHeader}>
                          <span style={styles.paneTitle}>API Keys</span>
                          <span style={styles.tiny}>Scoped to your access</span>
                        </div>
                        <div style={styles.paneBody}>
                          {serviceAccounts.length === 0 ? (
                            <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6 }}>
                              Create a service account first.
                            </div>
                          ) : (
                            <>
                              <div style={{ display: 'grid', gap: '10px' }}>
                                <div>
                                  <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Service account</div>
                                  <select
                                    style={styles.select}
                                    value={selectedServiceAccountId ?? ''}
                                    onChange={(e) => setSelectedServiceAccountId(Number(e.target.value))}
                                    disabled={serviceAccounts.length === 0}
                                  >
                                    {serviceAccounts.map((sa) => (
                                      <option key={sa.id} value={sa.id}>
                                        {sa.name}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <div>
                                  <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Scope (drop)</div>
                                  <select
                                    style={styles.select}
                                    value={apiKeyDropId ?? ''}
                                    onChange={(e) => setApiKeyDropId(Number(e.target.value))}
                                    disabled={accountDrops.length === 0}
                                  >
                                    {accountDrops.map((d) => (
                                      <option key={d.id} value={d.id}>
                                        {(() => {
                                          const display = formatDropDisplay(d);
                                          const identity = d.name;
                                          return display !== identity ? `${display} (${identity})` : display;
                                        })()}
                                      </option>
                                    ))}
                                  </select>
                                  {accountDrops.length === 0 && (
                                    <div style={{ ...styles.tiny, marginTop: '6px' }}>
                                      No drops assigned. Ask an admin to grant you query and/or ingest access.
                                    </div>
                                  )}
                                  <div style={{ ...styles.tiny, marginTop: '6px' }}>
                                    This does not change the app's active drop. It only scopes what this key can access.
                                  </div>
                                </div>
                                <div>
                                  <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Name (optional)</div>
                                  <input
                                    style={styles.filterInput}
                                    placeholder="e.g., staging-query"
                                    value={newApiKeyName}
                                    onChange={(e) => setNewApiKeyName(e.target.value)}
                                  />
                                </div>

                                {(() => {
                                  const d = apiKeyDropId === null ? null : accountDrops.find((x) => x.id === apiKeyDropId) ?? null;
                                  const canIngest = Boolean(d?.can_ingest) || isAdmin;
                                  const canQuery = Boolean(d?.can_query) || isAdmin;
                                  const scopeLabel = apiKeyDropId ? dropLabel(apiKeyDropId) : 'Select a drop';
                                  return (
                                    <div style={{ display: 'grid', gap: '8px' }}>
                                      <div style={{ ...styles.tiny, color: 'rgba(255,255,255,0.55)' }}>
                                        Permissions for: <span style={styles.mono}>{scopeLabel}</span>
                                      </div>
                                      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#ccc' }}>
                                        <input
                                          type="checkbox"
                                          checked={apiKeyCanIngest}
                                          onChange={(e) => setApiKeyCanIngest(e.target.checked)}
                                          disabled={!canIngest}
                                        />
                                        Ingest {!canIngest && <span style={{ color: '#777' }}>(no access)</span>}
                                      </label>
                                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#ccc' }}>
                                        <input
                                          type="checkbox"
                                          checked={apiKeyCanQuery}
                                          onChange={(e) => setApiKeyCanQuery(e.target.checked)}
                                          disabled={!canQuery}
                                        />
                                        Query {!canQuery && <span style={{ color: '#777' }}>(no access)</span>}
                                      </label>
                                      </div>
                                    </div>
                                  );
                                })()}

                                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                  <button
                                    style={styles.button}
                                    onClick={handleCreateApiKey}
                                    disabled={!selectedServiceAccountId || !apiKeyDropId || accountDrops.length === 0}
                                  >
                                    Create API key
                                  </button>
                                </div>
                              </div>

                              <div style={{ marginTop: '14px', display: 'grid', gap: '8px' }}>
                                {apiKeys.filter((k) => (selectedServiceAccountId ? k.service_account_id === selectedServiceAccountId : true)).length === 0 ? (
                                  <div style={styles.tiny}>No API keys yet.</div>
                                ) : (
                                  apiKeys
                                    .filter((k) => (selectedServiceAccountId ? k.service_account_id === selectedServiceAccountId : true))
                                    .map((key) => (
                                      <div key={key.id} style={{ border: '1px solid #222', borderRadius: '8px', padding: '8px 10px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                                          <div style={{ color: '#fff', fontWeight: 600 }}>
                                            {key.name || 'API key'} • {key.key_prefix}…
                                          </div>
                                          <div style={styles.tiny}>#{key.id}</div>
                                        </div>
                                        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '6px' }}>
                                          {key.permissions.map((p) => (
                                            <span key={`${key.id}-${p.drop_id}`} style={{ ...styles.pill, display: 'inline-flex', gap: '8px' }}>
                                              <span style={{ color: '#e5e7eb' }}>{dropLabel(p.drop_id)}</span>
                                              <span
                                                style={{
                                                  ...styles.mono,
                                                  padding: '2px 6px',
                                                  borderRadius: '999px',
                                                  border: '1px solid rgba(34,197,94,0.35)',
                                                  background: p.can_ingest ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.04)',
                                                  color: p.can_ingest ? '#bbf7d0' : 'rgba(255,255,255,0.45)',
                                                }}
                                              >
                                                ingest
                                              </span>
                                              <span
                                                style={{
                                                  ...styles.mono,
                                                  padding: '2px 6px',
                                                  borderRadius: '999px',
                                                  border: '1px solid rgba(99,102,241,0.35)',
                                                  background: p.can_query ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.04)',
                                                  color: p.can_query ? '#c7d2fe' : 'rgba(255,255,255,0.45)',
                                                }}
                                              >
                                                query
                                              </span>
                                            </span>
                                          ))}
                                          {key.revoked_at && <span style={{ ...styles.pill, color: '#fca5a5', borderColor: '#7f1d1d' }}>Revoked</span>}
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                                          <div style={styles.tiny}>Created {new Date(key.created_at).toLocaleString()}</div>
                                          {!key.revoked_at && (
                                            <button style={{ ...styles.button, ...styles.buttonDanger }} onClick={() => handleRevokeApiKey(key.id)}>
                                              Revoke
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    ))
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {settingsTab === 'users' && (
                <div style={{ display: 'grid', gap: '16px' }}>
                  {authActive && !isAdmin ? (
                    <div style={styles.pane}>
                      <div style={styles.paneHeader}>
                        <span style={styles.paneTitle}>Users</span>
                        <span style={styles.tiny}>Admin only</span>
                      </div>
                      <div style={styles.paneBody}>
                        <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6 }}>
                          Only admins can manage users.
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', alignItems: 'start' }}>
                        <div style={styles.pane}>
                          <div style={styles.paneHeader}>
                            <span style={styles.paneTitle}>Users</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              <span style={styles.tiny}>Admin</span>
                              {authActive && isAdmin && authMode === 'password_only' && (
                                <button style={{ ...styles.button, padding: '6px 10px' }} onClick={openAddUserModal}>
                                  Add user
                                </button>
                              )}
                            </div>
                          </div>
                          <div style={styles.paneBody}>
                            {authActive && isAdmin && authMode === 'password_only' && (
                              <div style={{ color: '#888', fontSize: '12px', lineHeight: 1.6, marginBottom: '10px' }}>
                                Password-only mode has no self-service sign-up. Admins create users.
                              </div>
                            )}
                            <div role="listbox" aria-label="Users" style={{ display: 'grid', gap: '8px' }}>
                              {users.length === 0 ? (
                                <div style={styles.tiny}>No users yet.</div>
                              ) : (
                                users.map((user, idx) => {
                                  const selected = selectedUserId === user.user_id;
                                  const tabIndex = selected ? 0 : -1;
                                  return (
                                    <div
                                      key={user.user_id}
                                      role="option"
                                      aria-selected={selected}
                                      tabIndex={tabIndex}
                                      style={{
                                        position: 'relative',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        padding: '9px 10px 9px 12px',
                                        borderRadius: '10px',
                                        border: selected ? '1px solid rgba(99,102,241,0.65)' : '1px solid #222',
                                        background: selected ? 'rgba(99,102,241,0.10)' : '#0f0f0f',
                                        boxShadow: selected ? '0 0 0 3px rgba(99,102,241,0.14)' : undefined,
                                        cursor: 'pointer',
                                        outline: 'none',
                                      }}
                                      onClick={() => setSelectedUserId(user.user_id)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                          e.preventDefault();
                                          setSelectedUserId(user.user_id);
                                          return;
                                        }
                                        if (e.key === 'ArrowDown') {
                                          e.preventDefault();
                                          const next = users[Math.min(idx + 1, users.length - 1)];
                                          if (next) setSelectedUserId(next.user_id);
                                          return;
                                        }
                                        if (e.key === 'ArrowUp') {
                                          e.preventDefault();
                                          const prev = users[Math.max(idx - 1, 0)];
                                          if (prev) setSelectedUserId(prev.user_id);
                                        }
                                      }}
                                      title="Select user"
                                    >
                                      <div
                                        aria-hidden="true"
                                        style={{
                                          position: 'absolute',
                                          left: 0,
                                          top: 0,
                                          bottom: 0,
                                          width: '3px',
                                          background: selected
                                            ? 'linear-gradient(180deg, rgba(99,102,241,0.9), rgba(34,197,94,0.65))'
                                            : 'transparent',
                                        }}
                                      />
                                      <div style={{ minWidth: 0 }}>
                                        <div style={{ color: '#fff', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                          {user.email}{' '}
                                          {user.protected_admin && <span style={{ ...styles.pill, marginLeft: '8px' }}>Protected admin</span>}
                                        </div>
                                        <div style={styles.tiny}>
                                          {user.role} • {user.disabled ? 'disabled' : 'active'}
                                        </div>
                                      </div>
                                      <span style={styles.tiny}>#{user.user_id.slice(0, 6)}</span>
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        </div>

                        <div style={styles.pane}>
                          <div style={styles.paneHeader}>
                            <span style={styles.paneTitle}>Selected User</span>
                            <span style={styles.tiny}>Profile</span>
                          </div>
                          <div style={styles.paneBody}>
                            {!selectedUserId ? (
                              <div style={styles.tiny}>Select a user to edit.</div>
                            ) : (
                              (() => {
                                const selectedUser = users.find((u) => u.user_id === selectedUserId) ?? null;
                                const isProtected = Boolean(selectedUser?.protected_admin);
                                return (
                                  <div style={{ display: 'grid', gap: '10px' }}>
                                    <div>
                                      <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Role</div>
                                      <select
                                        style={styles.select}
                                        value={selectedUserRole}
                                        onChange={(e) => setSelectedUserRole(e.target.value === 'admin' ? 'admin' : 'member')}
                                        disabled={isProtected}
                                      >
                                        <option value="member">Member</option>
                                        <option value="admin">Admin</option>
                                      </select>
                                      {isProtected && (
                                        <div style={{ ...styles.tiny, marginTop: '6px' }}>
                                          This account is protected by <span style={styles.mono}>RAPHAEL_ADMIN_EMAIL</span>.
                                        </div>
                                      )}
                                    </div>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#ccc' }}>
                                      <input
                                        type="checkbox"
                                        checked={selectedUserDisabled}
                                        onChange={(e) => setSelectedUserDisabled(e.target.checked)}
                                        disabled={isProtected}
                                      />
                                      Disabled
                                    </label>
                                    <button style={styles.button} onClick={handleSaveUserProfile} disabled={userSaving}>
                                      {userSaving ? 'Saving…' : 'Save User'}
                                    </button>
                                  </div>
                                );
                              })()
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {(!authActive || isAdmin) && (
                    <div style={styles.pane}>
                      <div style={styles.paneHeader}>
                        <span style={styles.paneTitle}>User Drop Permissions</span>
                        <span style={styles.tiny}>Admin</span>
                      </div>
                      <div style={styles.paneBody}>
                        {!selectedUserId ? (
                          <div style={styles.tiny}>Select a user to manage permissions.</div>
                        ) : drops.length === 0 ? (
                          <div style={styles.tiny}>No drops available.</div>
                        ) : (
                          <div style={{ display: 'grid', gap: '10px' }}>
                            {drops.map((drop) => {
                              const existing = userPermissions.find((p) => p.drop_id === drop.id);
                              return (
                                <div
                                  key={drop.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    border: '1px solid #222',
                                    padding: '8px 10px',
                                    borderRadius: '8px',
                                  }}
                                >
                                  <div style={{ color: '#fff' }}>{formatDropDisplay(drop)}</div>
                                  <div style={{ display: 'flex', gap: '12px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#ccc' }}>
                                      <input
                                        type="checkbox"
                                        checked={Boolean(existing?.can_ingest)}
                                        onChange={(e) => {
                                          const canIngest = e.target.checked;
                                          setUserPermissions((prev) => {
                                            const rest = prev.filter((p) => p.drop_id !== drop.id);
                                            return [...rest, { drop_id: drop.id, can_ingest: canIngest ? 1 : 0, can_query: existing?.can_query ?? 0 }];
                                          });
                                        }}
                                      />
                                      Ingest
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#ccc' }}>
                                      <input
                                        type="checkbox"
                                        checked={Boolean(existing?.can_query)}
                                        onChange={(e) => {
                                          const canQuery = e.target.checked;
                                          setUserPermissions((prev) => {
                                            const rest = prev.filter((p) => p.drop_id !== drop.id);
                                            return [...rest, { drop_id: drop.id, can_ingest: existing?.can_ingest ?? 0, can_query: canQuery ? 1 : 0 }];
                                          });
                                        }}
                                      />
                                      Query
                                    </label>
                                  </div>
                                </div>
                              );
                            })}
                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                              <button style={styles.button} onClick={handleSaveUserPermissions} disabled={userSaving}>
                                {userSaving ? 'Saving…' : 'Save Permissions'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {settingsTab === 'auth' && (
                <div style={{ display: 'grid', gap: '16px' }}>
                  {authActive && !isAdmin ? (
                    <div style={styles.pane}>
                      <div style={styles.paneHeader}>
                        <span style={styles.paneTitle}>Auth</span>
                        <span style={styles.tiny}>Admin only</span>
                      </div>
                      <div style={styles.paneBody}>
                        <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6 }}>
                          Only admins can manage auth policy.
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={styles.pane}>
                        <div style={styles.paneHeader}>
                          <span style={styles.paneTitle}>Auth</span>
                          <span style={styles.tiny}>Providers and policy</span>
                        </div>
                        <div style={styles.paneBody}>
                          <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6 }}>
                            Providers appear automatically based on server env vars. OAuth allowlist is enforced only when email/password is disabled.
                          </div>
                          <div style={{ marginTop: '10px', display: 'grid', gap: '8px' }}>
                            <div style={styles.pill}>
                              Mode:
                              <span style={{ color: '#fff' }}>{authMode}</span>
                            </div>
                            <div style={styles.pill}>
                              Providers:
                              <span style={{ color: '#fff' }}>
                                {authProviders.length === 0 ? 'none' : authProviders.map((p) => p.label).join(', ')}
                              </span>
                            </div>
                            <div style={styles.pill}>
                              Email/password:
                              <span style={{ color: '#fff' }}>{authEmailPasswordEnabled ? 'enabled' : 'disabled'}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div style={styles.pane}>
                        <div style={styles.paneHeader}>
                          <span style={styles.paneTitle}>OAuth Allowlist</span>
                          <span style={styles.tiny}>OAuth-only mode</span>
                        </div>
                        <div style={styles.paneBody}>
                          {authMode !== 'oauth_only' ? (
                            <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6 }}>
                              Allowlist is only enforced in <span style={styles.mono}>oauth_only</span> mode. Disable email/password login to enable enforcement.
                            </div>
                          ) : (
                            <>
                              <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.6, marginBottom: '12px' }}>
                                Policy is <b>OR</b>: allow if email matches or domain matches. If both lists are empty, all OAuth users are allowed. <span style={styles.mono}>RAPHAEL_ADMIN_EMAIL</span> is always allowed.
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', alignItems: 'start' }}>
                                <div>
                                  <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Allowed domains</div>
                                  <textarea
                                    style={{ ...styles.filterInput, height: '120px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
                                    value={authPolicyDomains}
                                    onChange={(e) => setAuthPolicyDomains(e.target.value)}
                                    placeholder="example.com\nmycompany.com"
                                  />
                                </div>
                                <div>
                                  <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Allowed emails</div>
                                  <textarea
                                    style={{ ...styles.filterInput, height: '120px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}
                                    value={authPolicyEmails}
                                    onChange={(e) => setAuthPolicyEmails(e.target.value)}
                                    placeholder="alice@example.com\nbob@mycompany.com"
                                  />
                                </div>
                              </div>
                              <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid #222' }}>
                                <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Default permissions</div>
                                <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.6, marginBottom: '10px' }}>
                                  Applied on first sign-in for allowed OAuth users that do not have any drop permissions yet.
                                </div>
                                {drops.length === 0 ? (
                                  <div style={styles.tiny}>No drops available.</div>
                                ) : (
                                  <div style={{ display: 'grid', gap: '10px' }}>
                                    {drops.map((drop) => {
                                      const existing = authPolicyDefaultPermissions.find((p) => p.drop_id === drop.id);
                                      return (
                                        <div
                                          key={drop.id}
                                          style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            border: '1px solid #222',
                                            padding: '8px 10px',
                                            borderRadius: '8px',
                                          }}
                                        >
                                          <div style={{ color: '#fff' }}>{formatDropDisplay(drop)}</div>
                                          <div style={{ display: 'flex', gap: '12px' }}>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#ccc' }}>
                                              <input
                                                type="checkbox"
                                                checked={Boolean(existing?.can_ingest)}
                                                onChange={(e) => {
                                                  const canIngest = e.target.checked;
                                                  setAuthPolicyDefaultPermissions((prev) => {
                                                    const rest = prev.filter((p) => p.drop_id !== drop.id);
                                                    const next = { drop_id: drop.id, can_ingest: canIngest, can_query: Boolean(existing?.can_query) };
                                                    if (!next.can_ingest && !next.can_query) return rest;
                                                    return [...rest, next];
                                                  });
                                                }}
                                              />
                                              Ingest
                                            </label>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#ccc' }}>
                                              <input
                                                type="checkbox"
                                                checked={Boolean(existing?.can_query)}
                                                onChange={(e) => {
                                                  const canQuery = e.target.checked;
                                                  setAuthPolicyDefaultPermissions((prev) => {
                                                    const rest = prev.filter((p) => p.drop_id !== drop.id);
                                                    const next = { drop_id: drop.id, can_ingest: Boolean(existing?.can_ingest), can_query: canQuery };
                                                    if (!next.can_ingest && !next.can_query) return rest;
                                                    return [...rest, next];
                                                  });
                                                }}
                                              />
                                              Query
                                            </label>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                              {authPolicyError && (
                                <div style={{ marginTop: '10px', color: '#fecaca', fontSize: '12px' }}>
                                  {authPolicyError}
                                </div>
                              )}
                              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px', gap: '10px' }}>
                                <button style={styles.button} onClick={fetchAuthPolicy} disabled={authPolicySaving}>
                                  Refresh
                                </button>
                                <button style={styles.button} onClick={saveAuthPolicy} disabled={authPolicySaving}>
                                  {authPolicySaving ? 'Saving…' : 'Save'}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {settingsTab === 'integrations' && (
                <div style={{ display: 'grid', gap: '16px' }}>
                  {authActive && !isAdmin ? (
                    <div style={styles.pane}>
                      <div style={styles.paneHeader}>
                        <span style={styles.paneTitle}>Integrations</span>
                        <span style={styles.tiny}>Admin only</span>
                      </div>
                      <div style={styles.paneBody}>
                        <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6 }}>
                          Only admins can configure integrations.
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div style={styles.pane}>
                      <div style={styles.paneHeader}>
                        <span style={styles.paneTitle}>Integrations</span>
                        <span style={styles.tiny}>Optional</span>
                      </div>
                      <div style={styles.paneBody}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', alignItems: 'start' }}>
                          <div>
                            <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6, marginBottom: '10px' }}>
                              Configure OpenRouter for AI dashboard generation. Values are stored locally (API key is encrypted at rest).
                            </div>
                            <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Model</div>
                            <input
                              style={styles.filterInput}
                              placeholder="openai/gpt-4o-mini"
                              value={openRouterModel}
                              onChange={(e) => setOpenRouterModel(e.target.value)}
                            />
                            <div style={{ ...styles.metaLabel, marginTop: '12px', marginBottom: '6px' }}>API key</div>
                            <input
                              style={styles.filterInput}
                              type="password"
                              placeholder={openRouterApiKeySet ? '•••••••• (set)' : 'Paste OPENROUTER_API_KEY'}
                              value={openRouterApiKey}
                              onChange={(e) => setOpenRouterApiKey(e.target.value)}
                            />
                            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '12px' }}>
                              {openRouterApiKeySet && (
                                <button style={{ ...styles.button, ...styles.buttonDanger }} onClick={clearOpenRouterKey} disabled={openRouterSaving}>
                                  Clear key
                                </button>
                              )}
                              <button style={styles.button} onClick={saveOpenRouterSettings} disabled={openRouterSaving}>
                                {openRouterSaving ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </div>

                          <div>
                            <div style={styles.pill}>
                              Status:
                              <span style={{ color: '#fff' }}>{openRouterApiKeySet ? 'API key set' : 'No API key'}</span>
                            </div>
                            <div style={{ marginTop: '12px', color: '#888', fontSize: '13px', lineHeight: 1.6 }}>
                              Notes:
                              <ul style={{ marginTop: '8px', paddingLeft: '18px', color: '#aaa' }}>
                                <li>Key is never returned to the browser once saved.</li>
                                <li>You can still override via server env vars if you want.</li>
                              </ul>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : dataLocked ? (
            <div style={{ ...styles.empty, textAlign: 'left' as const, maxWidth: '760px' }}>
              <div style={{ color: '#fff', fontWeight: 800, marginBottom: '8px' }}>You do not have permissions to view this resource</div>
              <div style={{ color: '#bbb', fontSize: '13px', lineHeight: 1.6 }}>
                This account does not have <span style={styles.mono}>query</span> access to any drop, so telemetry views are disabled.
                Ask an admin to grant query permissions in <span style={styles.mono}>Settings → Users</span>.
              </div>
              <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                <button
                  style={styles.button}
                  onClick={() => {
                    setTab('settings');
                    setSettingsTab('account');
                  }}
                >
                  Open Settings
                </button>
              </div>
            </div>
          ) : tab === 'events' ? (
            <EventsTable
              allEvents={events}
              visibleEvents={visibleEvents}
              onSelect={(event) => setSelected({ type: 'event', event })}
            />
          ) : (
            <TracesTable
              allTraces={traces}
              visibleTraces={visibleTraces}
              onSelect={(trace) => setSelected({ type: 'trace', traceId: trace.trace_id, focusSpanId: trace.span_id })}
            />
          )}
          {tab !== 'dashboards' && tab !== 'settings' && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', padding: '16px' }}>
              <button
                style={styles.button}
                onClick={fetchMoreListRows}
                disabled={listLoading || (tab === 'events' ? !eventNextCursor : !traceNextCursor) || Boolean(search.trim())}
                title={search.trim() ? 'Clear search to page through the latest rows' : undefined}
              >
                {listLoading
                  ? 'Loading...'
                  : tab === 'events'
                    ? eventNextCursor
                      ? 'Load older events'
                      : 'No more loaded pages'
                    : traceNextCursor
                      ? 'Load older traces'
                      : 'No more loaded pages'}
              </button>
              <button style={styles.button} onClick={fetchData} disabled={listLoading}>
                Refresh latest {LIST_PAGE_SIZE}
              </button>
            </div>
          )}
        </div>
      </main>

      {showNewDashboard && (
        <div style={styles.modal} onClick={() => setShowNewDashboard(false)}>
          <div style={styles.modalSmallContent} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>Create Dashboard</span>
              <div style={styles.modalActions}>
                <button style={styles.button} onClick={() => setShowNewDashboard(false)}>
                  Close
                </button>
              </div>
            </div>
            <div style={styles.modalBody}>
              <div style={{ color: '#888', fontSize: '13px', marginBottom: '10px' }}>
                Creates an editable dashboard for the current Drop.
              </div>
              <input
                style={styles.filterInput}
                value={newDashboardName}
                onChange={(e) => setNewDashboardName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createNewDashboard()}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '12px' }}>
                <button style={styles.button} onClick={() => setShowNewDashboard(false)}>
                  Cancel
                </button>
                <button style={styles.button} onClick={createNewDashboard} disabled={!newDashboardName.trim()}>
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showGenerateDashboard && (
        <div style={styles.modal} onClick={() => setShowGenerateDashboard(false)}>
          <div style={styles.modalSmallContent} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>Generate Dashboard</span>
              <div style={styles.modalActions}>
                <button style={styles.button} onClick={() => setShowGenerateDashboard(false)}>
                  Close
                </button>
              </div>
            </div>
            <div style={styles.modalBody}>
              <div style={{ color: '#888', fontSize: '13px', marginBottom: '12px' }}>
                Builds a dashboard spec by studying field cardinality in the last N wide events.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', alignItems: 'end' }}>
                <div>
                  <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Sample size (N)</div>
                  <input
                    style={styles.filterInput}
                    inputMode="numeric"
                    value={generateLimit}
                    onChange={(e) => setGenerateLimit(e.target.value)}
                  />
                </div>
                <label style={{ display: 'flex', gap: '10px', alignItems: 'center', color: '#ddd', fontSize: '13px' }}>
                  <input type="checkbox" checked={generateUseAi} onChange={(e) => setGenerateUseAi(e.target.checked)} />
                  Use AI (OpenRouter)
                </label>
              </div>
              {generateUseAi && (
                <div style={{ ...styles.tiny, marginTop: '10px' }}>
                  Configure OpenRouter in the <span style={styles.mono}>Settings</span> tab (or via server env vars).
                </div>
              )}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px' }}>
                <button style={styles.button} onClick={() => setShowGenerateDashboard(false)}>
                  Cancel
                </button>
                <button style={styles.button} onClick={generateDashboard} disabled={dropId === null}>
                  Generate
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showApiKeyModal && generatedApiKey && (
        <div style={styles.modal} onClick={() => setShowApiKeyModal(false)}>
          <div style={styles.modalSmallContent} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>API Key Created</span>
              <div style={styles.modalActions}>
                <button style={styles.button} onClick={() => setShowApiKeyModal(false)}>
                  Close
                </button>
              </div>
            </div>
            <div style={styles.modalBody}>
              <div style={{ color: '#888', fontSize: '13px', marginBottom: '10px' }}>
                This key is shown once. Copy it now and store it securely.
              </div>
              {generatedApiKeyMeta && <div style={{ ...styles.tiny, marginBottom: '8px' }}>{generatedApiKeyMeta}</div>}
              <div style={{ ...styles.metaValue, background: '#0f0f0f', border: '1px solid #222', borderRadius: '8px', padding: '10px' }}>
                {generatedApiKey}
              </div>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '12px' }}>
                <button
                  style={styles.button}
                  onClick={() => {
                    navigator.clipboard.writeText(generatedApiKey);
                    setAppToast('API key copied');
                  }}
                >
                  Copy
                </button>
                <button
                  style={styles.button}
                  onClick={() => {
                    setShowApiKeyModal(false);
                    setGeneratedApiKey(null);
                    setGeneratedApiKeyMeta(null);
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showAddUserModal && (
        <div style={styles.modal} onClick={closeAddUserModal}>
          <div style={styles.modalSmallContent} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>Add User</span>
              <div style={styles.modalActions}>
                <button style={styles.button} onClick={closeAddUserModal} disabled={newUserCreating}>
                  Close
                </button>
              </div>
            </div>
            <div style={styles.modalBody}>
              {createdUserCreds ? (
                <>
                  <div style={{ color: '#888', fontSize: '13px', marginBottom: '10px' }}>
                    User created. Share these credentials with the user.
                  </div>
                  <div style={{ display: 'grid', gap: '10px' }}>
                    <div>
                      <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Email</div>
                      <div style={{ ...styles.metaValue, background: '#0f0f0f', border: '1px solid #222', borderRadius: '8px', padding: '10px' }}>
                        {createdUserCreds.email}
                      </div>
                    </div>
                    <div>
                      <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Password</div>
                      <div style={{ ...styles.metaValue, background: '#0f0f0f', border: '1px solid #222', borderRadius: '8px', padding: '10px' }}>
                        {createdUserCreds.password}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                      <button
                        style={styles.button}
                        onClick={() => {
                          navigator.clipboard.writeText(`${createdUserCreds.email}\n${createdUserCreds.password}`);
                          setAppToast('Credentials copied');
                        }}
                      >
                        Copy credentials
                      </button>
                      <button
                        style={styles.button}
                        onClick={() => {
                          setCreatedUserCreds(null);
                          setNewUserEmail('');
                          setNewUserPassword('');
                          setNewUserRole('member');
                          const defaultDropId = dropId ?? drops[0]?.id ?? null;
                          setNewUserPermissions(defaultDropId ? [{ drop_id: defaultDropId, can_ingest: false, can_query: true }] : []);
                        }}
                      >
                        Create another
                      </button>
                      <button style={styles.button} onClick={closeAddUserModal}>
                        Done
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.6, marginBottom: '12px' }}>
                    In <span style={styles.mono}>password_only</span> mode there is no self-service sign-up. Admins must create users.
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', alignItems: 'end' }}>
                    <div>
                      <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Email</div>
                      <input
                        style={styles.filterInput}
                        placeholder="user@company.com"
                        value={newUserEmail}
                        onChange={(e) => setNewUserEmail(e.target.value)}
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Role</div>
                      <select
                        style={styles.select}
                        value={newUserRole}
                        onChange={(e) => setNewUserRole(e.target.value === 'admin' ? 'admin' : 'member')}
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Password</div>
                        <button style={{ ...styles.button, padding: '6px 10px' }} onClick={generatePassword} type="button">
                          Generate
                        </button>
                      </div>
                      <input
                        style={styles.filterInput}
                        type="text"
                        placeholder="Set an initial password"
                        value={newUserPassword}
                        onChange={(e) => setNewUserPassword(e.target.value)}
                        autoComplete="off"
                      />
                      <div style={{ ...styles.tiny, marginTop: '6px' }}>
                        The password is never stored in Raphael. This is only used to create the credential in BetterAuth.
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid #222' }}>
                    <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Initial permissions</div>
                    <div style={{ color: '#888', fontSize: '13px', lineHeight: 1.6, marginBottom: '10px' }}>
                      Assign at least one drop permission. <b>Query</b> is required to view Events, Traces, and Dashboards.
                    </div>
                    {drops.length === 0 ? (
                      <div style={styles.tiny}>No drops available.</div>
                    ) : (
                      <div style={{ display: 'grid', gap: '10px' }}>
                        {drops.map((drop) => {
                          const existing = newUserPermissions.find((p) => p.drop_id === drop.id);
                          return (
                            <div
                              key={drop.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                border: '1px solid #222',
                                padding: '8px 10px',
                                borderRadius: '8px',
                              }}
                            >
                              <div style={{ color: '#fff' }}>{formatDropDisplay(drop)}</div>
                              <div style={{ display: 'flex', gap: '12px' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#ccc' }}>
                                  <input
                                    type="checkbox"
                                    checked={Boolean(existing?.can_ingest)}
                                    onChange={(e) => {
                                      const canIngest = e.target.checked;
                                      setNewUserPermissions((prev) => {
                                        const rest = prev.filter((p) => p.drop_id !== drop.id);
                                        const next = { drop_id: drop.id, can_ingest: canIngest, can_query: Boolean(existing?.can_query) };
                                        if (!next.can_ingest && !next.can_query) return rest;
                                        return [...rest, next];
                                      });
                                    }}
                                  />
                                  Ingest
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#ccc' }}>
                                  <input
                                    type="checkbox"
                                    checked={Boolean(existing?.can_query)}
                                    onChange={(e) => {
                                      const canQuery = e.target.checked;
                                      setNewUserPermissions((prev) => {
                                        const rest = prev.filter((p) => p.drop_id !== drop.id);
                                        const next = { drop_id: drop.id, can_ingest: Boolean(existing?.can_ingest), can_query: canQuery };
                                        if (!next.can_ingest && !next.can_query) return rest;
                                        return [...rest, next];
                                      });
                                    }}
                                  />
                                  Query
                                </label>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {newUserRole !== 'admin' &&
                      newUserPermissions.filter((p) => p.can_ingest || p.can_query).length === 0 && (
                        <div style={{ marginTop: '10px', color: '#fecaca', fontSize: '12px' }}>
                          Member users must be created with at least one permission.
                        </div>
                      )}
                  </div>

                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '12px' }}>
                    <button style={styles.button} onClick={closeAddUserModal} disabled={newUserCreating}>
                      Cancel
                    </button>
                    <button
                      style={styles.button}
                      onClick={handleCreateUser}
                      disabled={
                        newUserCreating ||
                        !newUserEmail.trim() ||
                        !newUserPassword.trim() ||
                        (newUserRole !== 'admin' && newUserPermissions.filter((p) => p.can_ingest || p.can_query).length === 0)
                      }
                    >
                      {newUserCreating ? 'Creating…' : 'Create user'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {selected?.type === 'event' && (
        <EventDetailModal
          event={selected.event}
          onClose={() => setSelected(null)}
          onOpenTrace={(traceId) => setSelected({ type: 'trace', traceId })}
        />
      )}
      {selected?.type === 'trace' && (
        <TraceDetailModal
          traceId={selected.traceId}
          dropId={dropIdRef.current ?? 1}
          focusSpanId={selected.focusSpanId}
          onClose={() => setSelected(null)}
        />
      )}

      {appToast && <div style={styles.toast}>{appToast}</div>}
    </div>
  );
}
