import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { DEFAULT_DROP_ID, getUserDropPermission, resolveDropId } from './db/sqlite.js';
import { authEnabled, ensureUserProfile, getAuth } from './auth.js';
import { fromNodeHeaders } from 'better-auth/node';

let wss: WebSocketServer;
const subscriptions = new WeakMap<WebSocket, number>();
const contexts = new WeakMap<WebSocket, { userId: string | null; role: 'admin' | 'member' | null }>();
const subscriberCounts = new Map<number, number>();

function incSubscribers(dropId: number) {
  subscriberCounts.set(dropId, (subscriberCounts.get(dropId) ?? 0) + 1);
}

function decSubscribers(dropId: number) {
  const next = (subscriberCounts.get(dropId) ?? 0) - 1;
  if (next <= 0) subscriberCounts.delete(dropId);
  else subscriberCounts.set(dropId, next);
}

export function hasSubscribers(dropId: number) {
  return (subscriberCounts.get(dropId) ?? 0) > 0;
}

export function setupWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    if (authEnabled()) {
      try {
        const session = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) });
        if (!session?.user) {
          ws.close(4401, 'Unauthorized');
          return;
        }
        const profile = await ensureUserProfile({ id: session.user.id, email: session.user.email });
        if (profile?.disabled) {
          ws.close(4403, 'Disabled');
          return;
        }
        contexts.set(ws, { userId: session.user.id, role: profile?.role ?? 'member' });
      } catch (error) {
        console.error('WebSocket auth failed:', error);
        ws.close(4401, 'Unauthorized');
        return;
      }
    } else {
      contexts.set(ws, { userId: null, role: null });
    }

    console.log('Client connected');
    subscriptions.set(ws, DEFAULT_DROP_ID);
    incSubscribers(DEFAULT_DROP_ID);

    ws.on('close', () => {
      const current = subscriptions.get(ws) ?? DEFAULT_DROP_ID;
      decSubscribers(current);
      console.log('Client disconnected');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === 'subscribe') {
          const ctx = contexts.get(ws) ?? { userId: null, role: null };
          const allowCreate = !authEnabled() || ctx.role === 'admin';
          const dropId = resolveDropId(msg.dropId?.toString?.() ?? msg.drop?.toString?.(), allowCreate);
          if (dropId === null) {
            ws.send(JSON.stringify({ type: 'error', error: 'Drop not found' }));
            return;
          }
          if (authEnabled() && ctx.role !== 'admin' && ctx.userId) {
            const perm = getUserDropPermission(ctx.userId, dropId);
            if (!perm?.can_query) {
              ws.send(JSON.stringify({ type: 'error', error: 'Drop access denied' }));
              return;
            }
          }
          const prev = subscriptions.get(ws) ?? DEFAULT_DROP_ID;
          if (prev !== dropId) {
            decSubscribers(prev);
            incSubscribers(dropId);
          }
          subscriptions.set(ws, dropId);
          ws.send(JSON.stringify({ type: 'subscribed', drop_id: dropId }));
        }
      } catch {
        // Ignore invalid messages
      }
    });

    // Send welcome message
    ws.send(JSON.stringify({ type: 'connected', message: 'Connected to Raphael' }));
  });

  return wss;
}

export function broadcast(message: unknown, dropId?: number) {
  if (!wss) return;

  const data = JSON.stringify(message);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (dropId !== undefined) {
        const subscribedDropId = subscriptions.get(client as WebSocket) ?? DEFAULT_DROP_ID;
        if (subscribedDropId !== dropId) return;
      }
      client.send(data);
    }
  });
}
