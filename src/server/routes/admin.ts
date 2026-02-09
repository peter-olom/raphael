import { Router, Request, Response } from 'express';
import {
  getAppSetting,
  getUserProfile,
  listUserDropPermissions,
  listUserProfiles,
  listDrops,
  resolveDropId,
  setUserDropPermissions,
  updateUserDisabled,
  updateUserRole,
  setAppSetting,
  createUserProfileIfMissing,
} from '../db/sqlite.js';
import { auth, authEnabled, requireAdmin, requireAuth } from '../auth.js';

export const adminRouter = Router();

function isTruthy(value: unknown) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeDomain(value: string) {
  return value.trim().toLowerCase().replace(/^@+/, '');
}

function isValidEmail(value: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function parseJsonArraySetting(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function parseDefaultPermissionsSetting(raw: string | undefined) {
  if (!raw) return [] as Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p) => ({
        drop_id: Number((p as any)?.drop_id),
        can_ingest: Boolean((p as any)?.can_ingest),
        can_query: Boolean((p as any)?.can_query),
      }))
      .filter((p) => Number.isFinite(p.drop_id) && (p.can_ingest || p.can_query));
  } catch {
    return [];
  }
}

function isProtectedAdminEmail(email: string) {
  const adminEmail = (process.env.RAPHAEL_ADMIN_EMAIL || '').trim().toLowerCase();
  return Boolean(adminEmail && normalizeEmail(email) === adminEmail);
}

adminRouter.get('/me', (req: Request, res: Response) => {
  if (!authEnabled()) {
    res.json({ enabled: false });
    return;
  }
  if (!requireAuth(req, res)) return;
  res.json({ enabled: true, user: req.auth?.user ?? null });
});

adminRouter.get('/users', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const rows = listUserProfiles();
  const withFlags = rows.map((u) => ({
    ...u,
    protected_admin: isProtectedAdminEmail(u.email),
  }));
  res.json(withFlags);
});

adminRouter.post('/users', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  if (!authEnabled() || !isTruthy(process.env.RAPHAEL_AUTH_EMAIL_PASSWORD_ENABLED)) {
    res.status(400).json({ error: 'Email/password auth must be enabled to create users' });
    return;
  }

  const email = normalizeEmail((req.body?.email ?? '').toString());
  const password = (req.body?.password ?? '').toString();
  const roleRaw = req.body?.role;
  const requestedRole = roleRaw === 'admin' ? 'admin' : roleRaw === 'member' ? 'member' : 'member';

  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Invalid email' });
    return;
  }
  if (!password) {
    res.status(400).json({ error: 'password is required' });
    return;
  }

  const adminEmail = (process.env.RAPHAEL_ADMIN_EMAIL || '').trim().toLowerCase();
  const role = adminEmail && email === adminEmail ? 'admin' : requestedRole;

  try {
    const nameRaw = (req.body?.name ?? '').toString().trim();
    const fallbackName = email.includes('@') ? email.split('@')[0] : email;
    const name = nameRaw || fallbackName;

    // Use the supported BetterAuth API for creating email/password users.
    // (auth.$context is a Promise and internalAdapter is not guaranteed to be stable across versions.)
    const created = await auth.api.signUpEmail({
      body: {
        email,
        password,
        name,
      },
    });

    const userId = (created as any)?.user?.id?.toString?.() ?? '';
    if (!userId) {
      res.status(500).json({ error: 'Failed to create user' });
      return;
    }

    const profile = createUserProfileIfMissing({ user_id: userId, email, role });

    // Assign initial permissions during account creation to avoid "user exists but cannot see anything".
    if (role !== 'admin') {
      const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
      const normalized = permissions
        .map((p: any) => {
          const rawDrop = p?.drop_id ?? p?.dropId ?? p?.drop;
          const drop_id = Number(rawDrop);
          if (!Number.isFinite(drop_id)) return null;
          const can_ingest = Boolean(p?.can_ingest ?? p?.ingest ?? false);
          const can_query = Boolean(p?.can_query ?? p?.query ?? false);
          if (!can_ingest && !can_query) return null;
          return { drop_id: Math.floor(drop_id), can_ingest, can_query };
        })
        .filter(Boolean) as Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>;

      const existing = new Set(listDrops().map((d) => d.id));
      for (const p of normalized) {
        if (!existing.has(p.drop_id)) {
          res.status(400).json({ error: `Unknown drop_id ${p.drop_id}` });
          return;
        }
      }

      if (normalized.length === 0) {
        res.status(400).json({ error: 'Member users must be created with at least one drop permission' });
        return;
      }

      if (normalized.length > 0) {
        setUserDropPermissions(userId, normalized);
      }
    }

    res.status(201).json(profile);
  } catch (error) {
    console.error('Failed to create user:', error);
    res.status(400).json({ error: (error as Error).message || 'Failed to create user' });
  }
});

adminRouter.patch('/users/:id', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const userId = (req.params as any).id as string;
  const profile = getUserProfile(userId);
  if (!profile) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (isProtectedAdminEmail(profile.email)) {
    const wantsRole = req.body?.role !== undefined;
    const wantsDisabled = req.body?.disabled !== undefined;
    if (wantsRole || wantsDisabled) {
      res.status(400).json({ error: 'Protected admin user cannot be modified' });
      return;
    }
  }

  const roleRaw = req.body?.role;
  const disabledRaw = req.body?.disabled;

  if (roleRaw !== undefined) {
    const role = roleRaw === 'admin' ? 'admin' : roleRaw === 'member' ? 'member' : null;
    if (!role) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }
    updateUserRole(userId, role);
  }

  if (disabledRaw !== undefined) {
    updateUserDisabled(userId, Boolean(disabledRaw));
  }

  res.json(getUserProfile(userId));
});

adminRouter.get('/auth-policy', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const oauthOnly = authEnabled() && !isTruthy(process.env.RAPHAEL_AUTH_EMAIL_PASSWORD_ENABLED);
  const allowed_domains = parseJsonArraySetting(getAppSetting('raphael.auth.allowed_domains')).map(normalizeDomain).filter(Boolean);
  const allowed_emails = parseJsonArraySetting(getAppSetting('raphael.auth.allowed_emails')).map(normalizeEmail).filter(Boolean);
  const default_permissions = parseDefaultPermissionsSetting(getAppSetting('raphael.auth.oauth_default_permissions'));
  res.json({ oauth_only: oauthOnly, allowed_domains, allowed_emails, default_permissions });
});

adminRouter.put('/auth-policy', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const bodyDomains = Array.isArray(req.body?.allowed_domains) ? req.body.allowed_domains : [];
  const bodyEmails = Array.isArray(req.body?.allowed_emails) ? req.body.allowed_emails : [];

  const allowed_domains = Array.from(new Set(bodyDomains.map((d: any) => normalizeDomain(String(d))).filter(Boolean)));
  const allowed_emails = Array.from(new Set(bodyEmails.map((e: any) => normalizeEmail(String(e))).filter(Boolean)));

  const bodyDefaults = Array.isArray(req.body?.default_permissions) ? req.body.default_permissions : [];
  const default_permissions = bodyDefaults
    .map((p: any) => {
      const drop_id = Number(p?.drop_id ?? p?.dropId ?? p?.drop);
      if (!Number.isFinite(drop_id)) return null;
      const can_ingest = Boolean(p?.can_ingest ?? p?.ingest ?? false);
      const can_query = Boolean(p?.can_query ?? p?.query ?? false);
      if (!can_ingest && !can_query) return null;
      return { drop_id: Math.floor(drop_id), can_ingest, can_query };
    })
    .filter(Boolean) as Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>;

  const existing = new Set(listDrops().map((d) => d.id));
  for (const p of default_permissions) {
    if (!existing.has(p.drop_id)) {
      res.status(400).json({ error: `Unknown drop_id ${p.drop_id}` });
      return;
    }
  }

  const adminEmail = (process.env.RAPHAEL_ADMIN_EMAIL || '').trim().toLowerCase();
  const currentEmail = req.auth?.user?.email?.trim().toLowerCase() || '';

  function isAllowed(email: string) {
    if (!email) return false;
    if (adminEmail && email === adminEmail) return true;
    const domain = email.split('@')[1] || '';
    if (allowed_emails.includes(email)) return true;
    if (domain && allowed_domains.includes(domain)) return true;
    return allowed_domains.length === 0 && allowed_emails.length === 0;
  }

  if (!isAllowed(currentEmail)) {
    res.status(400).json({ error: 'Policy would lock out the current admin user' });
    return;
  }

  setAppSetting('raphael.auth.allowed_domains', JSON.stringify(allowed_domains));
  setAppSetting('raphael.auth.allowed_emails', JSON.stringify(allowed_emails));
  setAppSetting('raphael.auth.oauth_default_permissions', JSON.stringify(default_permissions));
  res.json({ allowed_domains, allowed_emails, default_permissions });
});

adminRouter.get('/users/:id/permissions', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const userId = (req.params as any).id as string;
  const profile = getUserProfile(userId);
  if (!profile) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(listUserDropPermissions(userId));
});

adminRouter.put('/users/:id/permissions', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const userId = (req.params as any).id as string;
  const profile = getUserProfile(userId);
  if (!profile) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const normalized = permissions
    .map((p: any) => {
      const dropRaw = p?.drop_id ?? p?.drop ?? p?.drop_name;
      const dropId = resolveDropId(dropRaw?.toString?.() ?? '', false);
      if (!dropId) return null;
      return {
        drop_id: dropId,
        can_ingest: Boolean(p?.can_ingest ?? p?.ingest ?? false),
        can_query: Boolean(p?.can_query ?? p?.query ?? false),
      };
    })
    .filter(Boolean) as Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>;

  setUserDropPermissions(userId, normalized);
  res.json(listUserDropPermissions(userId));
});
