import type { Response } from "express";

const clients = new Set<Response>();

export function addSseClient(res: Response) {
  clients.add(res);
}

export function removeSseClient(res: Response) {
  clients.delete(res);
}

function broadcast(eventName: string, payload: Record<string, unknown>) {
  const raw = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(raw); } catch { clients.delete(res); }
  }
}

export function broadcastLocationUpdate(location: Record<string, unknown>) {
  broadcast("location_update", { location });
}

/** Fired when order status changes OR driver position updates */
export function broadcastOrderUpdate(order: Record<string, unknown>) {
  broadcast("order_update", { order });
}

/** Fired when a new chat message is saved */
export function broadcastNewMessage(message: Record<string, unknown>) {
  broadcast("new_message", { message });
}

/** Fired when an online driver updates their location or goes offline */
export function broadcastDriverUpdate(driver: Record<string, unknown>) {
  broadcast("driver_update", { driver });
}

/** Fired when a global setting (e.g. top_banner imageUrl) is changed */
export function broadcastSettingUpdate(key: string, value: string) {
  broadcast("setting_update", { key, value });
}

export function sseClientCount() {
  return clients.size;
}
