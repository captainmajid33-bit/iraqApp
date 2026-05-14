import type { Response } from "express";

const clients = new Set<Response>();

// ── Separate client set for /api/orders/stream (partner app gas orders) ───────
const ordersStreamClients = new Set<Response>();

export function addOrdersStreamClient(res: Response) {
  ordersStreamClients.add(res);
}

export function removeOrdersStreamClient(res: Response) {
  ordersStreamClients.delete(res);
}

/** Broadcast pending gas orders to all /api/orders/stream clients.
 *  Format: data: {"type":"gas_order_update","orders":[...]}  (NO event: line)
 *  Partner app uses onmessage (not addEventListener) so must be a plain data message.
 */
export function broadcastGasOrdersToOrdersStream(orders: Record<string, unknown>[]) {
  if (ordersStreamClients.size === 0 || orders.length === 0) return;
  const raw = `data: ${JSON.stringify({ type: "gas_order_update", orders })}\n\n`;
  for (const res of ordersStreamClients) {
    try { res.write(raw); } catch { ordersStreamClients.delete(res); }
  }
}

export function addSseClient(res: Response) {
  clients.add(res);
}

export function removeSseClient(res: Response) {
  clients.delete(res);
}

/** Send a single SSE event to ONE specific client (used for on-connect replays) */
export function sendToClient(res: Response, eventName: string, payload: Record<string, unknown>) {
  try {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    clients.delete(res);
  }
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

/** Fired when a gas order is created, accepted, or status-changed */
export function broadcastGasOrderUpdate(order: Record<string, unknown>) {
  broadcast("gas_order_update", { order });
}

export function sseClientCount() {
  return clients.size;
}
