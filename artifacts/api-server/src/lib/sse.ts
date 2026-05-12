import type { Response } from "express";

const clients = new Set<Response>();

export function addSseClient(res: Response) {
  clients.add(res);
}

export function removeSseClient(res: Response) {
  clients.delete(res);
}

export function broadcastLocationUpdate(location: Record<string, unknown>) {
  const payload = `event: location_update\ndata: ${JSON.stringify({ location })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

export function sseClientCount() {
  return clients.size;
}
