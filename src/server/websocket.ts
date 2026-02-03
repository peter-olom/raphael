import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { DEFAULT_DROP_ID, ensureDrop } from './db/sqlite.js';

let wss: WebSocketServer;
const subscriptions = new WeakMap<WebSocket, number>();

export function setupWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('Client connected');
    subscriptions.set(ws, DEFAULT_DROP_ID);

    ws.on('close', () => {
      console.log('Client disconnected');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === 'subscribe') {
          const dropId = ensureDrop(msg.dropId?.toString?.() ?? msg.drop?.toString?.());
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
