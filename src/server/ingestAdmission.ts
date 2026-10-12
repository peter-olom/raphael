import type { Request, Response, NextFunction } from 'express';
import { isIngestRequest, retryMaintenance } from './maintenanceGate.js';
import { maintenanceConfig } from './maintenanceConfig.js';

let occupied = 0;
const reservations = new WeakMap<Request, { release: () => void; handlers: number }>();
// Each parser can allocate up to 10MiB, regardless of a client's declared Content-Length.
const perRequest = 10 * 1024 * 1024;
export function ingestAdmission(req: Request, res: Response, next: NextFunction) {
  if (!isIngestRequest(req)) return next();
  const limit = Math.max(perRequest, maintenanceConfig.queue_max_inflight_bytes);
  if (occupied + perRequest > limit) return retryMaintenance(res, 'Concurrent ingestion capacity reached; retry shortly');
  occupied += perRequest;
  let done = false;
  const release = () => { if (!done) { done = true; occupied -= perRequest; reservations.delete(req); } };
  reservations.set(req, { release, handlers: 0 });
  res.once('finish', release);
  res.once('close', () => { if (!reservations.get(req)?.handlers) release(); });
  req.once('aborted', () => { if (!reservations.get(req)?.handlers) release(); });
  next();
}
export function holdIngestRequest(req: Request) {
  const reservation = reservations.get(req);
  if (reservation) reservation.handlers++;
  return () => {
    if (!reservation) return;
    reservation.handlers--;
    if (reservation.handlers === 0 && req.destroyed) reservation.release();
  };
}
export function releaseAbandonedIngest(req: Request, res: Response) {
  const reservation = reservations.get(req);
  if (res.destroyed && !reservation?.handlers) reservation?.release();
}

export function normalizedIngestBudget() {
  let bytes = 4096;
  return (row: unknown) => {
    bytes += Buffer.byteLength(JSON.stringify(row));
    return bytes <= Math.min(perRequest, maintenanceConfig.queue_max_inflight_bytes);
  };
}
