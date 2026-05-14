import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { ordersTable, insertOrderSchema, locationsTable, driversOnlineTable, messagesTable, insertMessageSchema } from "@workspace/db";
import { eq, desc, asc, inArray, and, ne } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { broadcastOrderUpdate, broadcastDriverUpdate, broadcastNewMessage } from "../lib/sse";

const router: IRouter = Router();

// ── Helper: update isBusy for a driver and broadcast ─────────────────────────
async function setDriverBusy(locationId: number, busy: boolean) {
  try {
    const [updated] = await db
      .update(driversOnlineTable)
      .set({ isBusy: busy, updatedAt: new Date() })
      .where(eq(driversOnlineTable.locationId, locationId))
      .returning();
    if (updated) {
      broadcastDriverUpdate(updated as Record<string, unknown>);
      console.log(`[BUSY-AUTO] driver ${locationId} → isBusy=${busy}`);
    }
  } catch (err) {
    // Non-fatal — driver may not be in drivers_online table yet
    console.warn(`[BUSY-AUTO] could not update isBusy for driver ${locationId}:`, err);
  }
}

// ── POST /api/orders — public, place a taxi order ────────────────────────────
router.post("/orders", async (req, res) => {
  try {
    const parsed = insertOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error?.issues });
      return;
    }
    const {
      locationId, userName, phone, destination,
      fromLat, fromLng, toLat, toLng, estimatedPrice,
      lat, lng,
    } = parsed.data;

    // ── Fetch driver's location profile (optional — partner app may use a different locationId) ──
    const [loc] = await db
      .select({ id: locationsTable.id, name: locationsTable.name, status: locationsTable.status })
      .from(locationsTable)
      .where(eq(locationsTable.id, locationId));

    if (loc?.status === "معطّل") {
      res.status(409).json({ error: "هذا السائق غير متاح حالياً" });
      return;
    }

    // ── Fallback: get driver name from driversOnline table if location not found ─
    const [onlineRow] = await db
      .select({ isBusy: driversOnlineTable.isBusy, isOnline: driversOnlineTable.isOnline, driverName: driversOnlineTable.driverName })
      .from(driversOnlineTable)
      .where(eq(driversOnlineTable.locationId, locationId));

    if (!loc && !onlineRow) {
      res.status(404).json({ error: "لم يتم العثور على السائق" });
      return;
    }

    if (onlineRow?.isBusy) {
      res.status(409).json({ error: "السائق مشغول حالياً في رحلة أخرى، يرجى اختيار سائق آخر" });
      return;
    }

    const driverLabel = loc?.name ?? onlineRow?.driverName ?? `driver#${locationId}`;

    // ── Auto-cancel stale pending/accepted orders for this driver ─────────────
    // Prevents the partner app from seeing old ghost orders and showing "في رحلة"
    // when a new order arrives. Any order that wasn't properly closed gets cancelled here.
    const stale = await db
      .update(ordersTable)
      .set({ status: 'cancelled' })
      .where(and(
        eq(ordersTable.locationId, locationId),
        inArray(ordersTable.status, ['pending', 'accepted', 'driving']),
      ))
      .returning({ id: ordersTable.id, locationId: ordersTable.locationId });

    for (const s of stale) {
      broadcastOrderUpdate({ id: s.id, status: 'cancelled', locationId: s.locationId });
      console.log(`[POST /orders] auto-cancelled stale order #${s.id} for driver ${locationId}`);
    }
    // Also ensure driver is not stuck as busy before new order
    await setDriverBusy(locationId, false);

    // ── Insert order ──────────────────────────────────────────────────────────
    const [order] = await db
      .insert(ordersTable)
      .values({
        locationId,
        userName:       userName ?? null,
        phone,
        destination,
        fromLat:        fromLat ?? null,
        fromLng:        fromLng ?? null,
        toLat:          toLat   ?? null,
        toLng:          toLng   ?? null,
        estimatedPrice: estimatedPrice ?? null,
        lat:            lat ?? null,
        lng:            lng ?? null,
      })
      .returning();

    console.log(
      `[POST /orders] #${order.id} → ${driverLabel} (locId=${locationId}) | user:${userName ?? '?'} | phone:${phone} | dest:${destination} | price:${estimatedPrice ?? '?'} IQD`
    );
    res.status(201).json({ ok: true, orderId: order.id, status: order.status });
  } catch (err: any) {
    console.error("[POST /orders] error:", err);
    res.status(500).json({ error: "فشل حفظ الطلب", detail: err?.message });
  }
});

// ── GET /api/orders/stream — SSE for partner app (TAXI orders only) ───────────
// MUST be registered before /orders/:id so Express doesn't treat "stream" as an id.
// Gas orders are handled separately via /api/events (gas_order_update events).
router.get("/orders/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(":connected\n\n");

  const hb = setInterval(() => {
    try { res.write(":heartbeat\n\n"); } catch { clearInterval(hb); }
  }, 25_000);

  req.on("close", () => clearInterval(hb));
});

// ── GET /api/orders/:id — public, customer polls for status + driver location ─
router.get("/orders/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
    res.json({
      id:          order.id,
      status:      order.status,
      driverLat:   order.driverLat,
      driverLng:   order.driverLng,
      fromLat:     order.fromLat,
      fromLng:     order.fromLng,
      toLat:       order.toLat,
      toLng:       order.toLng,
      estimatedPrice: order.estimatedPrice,
      createdAt:   order.createdAt,
    });
  } catch (err: any) {
    console.error("[GET /orders/:id] error:", err);
    res.status(500).json({ error: "فشل جلب الطلب" });
  }
});

// ── PATCH /api/orders/:id/driver-location — partner app sends GPS ────────────
router.patch("/orders/:id/driver-location", async (req, res) => {
  try {
    const partnerKey   = req.headers["x-partner-key"] as string | undefined;
    const merchantKey  = req.headers["x-merchant-key"] as string | undefined;
    const adminPass    = req.headers["x-admin-password"] as string | undefined;
    const validAdmin   = adminPass === process.env.ADMIN_PASSWORD || adminPass === "Admin2026";
    const validPartner = partnerKey || merchantKey;
    if (!validAdmin && !validPartner) {
      res.status(403).json({ error: "غير مصرح" }); return;
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

    const { lat, lng } = req.body ?? {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      res.status(400).json({ error: "lat و lng مطلوبان" }); return;
    }

    const [updated] = await db
      .update(ordersTable)
      .set({ driverLat: lat, driverLng: lng })
      .where(eq(ordersTable.id, id))
      .returning();

    if (!updated) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    broadcastOrderUpdate({
      id:        updated.id,
      status:    updated.status,
      driverLat: updated.driverLat,
      driverLng: updated.driverLng,
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[PATCH /orders/:id/driver-location] error:", err);
    res.status(500).json({ error: "فشل تحديث الموقع" });
  }
});

// ── PATCH /api/orders/:id/customer-cancel — public, customer cancels pending order ──
// Only works when order is still 'pending' (not accepted/driving)
router.patch("/orders/:id/customer-cancel", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    // Only cancellable while still pending (driver hasn't accepted yet)
    if (order.status !== 'pending') {
      res.status(409).json({ error: "لا يمكن إلغاء طلب قيد التنفيذ" }); return;
    }

    const [updated] = await db
      .update(ordersTable).set({ status: 'cancelled' })
      .where(eq(ordersTable.id, id)).returning();

    broadcastOrderUpdate({ id: updated.id, status: updated.status, locationId: updated.locationId });
    await setDriverBusy(updated.locationId, false);

    console.log(`[customer-cancel] order #${id} cancelled by customer`);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[PATCH /orders/:id/customer-cancel] error:", err);
    res.status(500).json({ error: "فشل إلغاء الطلب" });
  }
});

// ── GET /api/orders — partners + admin: TAXI orders only ─────────────────────
// Gas orders are served separately via GET /api/gas-orders/pending.
router.get("/orders", async (req, res) => {
  const partnerKey  = req.headers["x-partner-key"]    as string | undefined;
  const merchantKey = req.headers["x-merchant-key"]   as string | undefined;
  const adminPass   = req.headers["x-admin-password"] as string | undefined;
  const isAdmin =
    adminPass === process.env.ADMIN_PASSWORD ||
    adminPass === "Admin2026";
  const isPartner = !!(partnerKey || merchantKey);

  if (!isAdmin && !isPartner && process.env.ADMIN_PASSWORD) {
    res.status(403).json({ error: "غير مصرح" }); return;
  }

  try {
    const locationId = req.query.locationId ? Number(req.query.locationId) : null;

    const rows = locationId
      ? await db.select().from(ordersTable).where(eq(ordersTable.locationId, locationId)).orderBy(desc(ordersTable.createdAt))
      : await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));

    res.json(rows);
  } catch (err: any) {
    console.error("[GET /orders] error:", err);
    res.status(500).json({ error: "فشل جلب الطلبات" });
  }
});

// ── PATCH /api/orders/:id — admin only (status change) ───────────────────────
// Also auto-manages driver isBusy:
//   accepted / driving  → isBusy = true  (driver is now on a ride)
//   done / finished / cancelled → isBusy = false  (driver is free again)
router.patch("/orders/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!status) { res.status(400).json({ error: "status field required" }); return; }

    const [updated] = await db
      .update(ordersTable).set({ status: String(status) })
      .where(eq(ordersTable.id, id)).returning();
    if (!updated) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    // ── Broadcast status change so customer gets notified instantly ────────────
    broadcastOrderUpdate({
      id:         updated.id,
      status:     updated.status,
      locationId: updated.locationId,
      driverLat:  updated.driverLat,
      driverLng:  updated.driverLng,
    });

    // ── Auto-update driver busy state based on new order status ───────────────
    const BUSY_STATUSES = new Set(["accepted", "driving"]);
    const FREE_STATUSES = new Set(["done", "finished", "completed", "cancelled", "rejected"]);

    if (BUSY_STATUSES.has(updated.status)) {
      await setDriverBusy(updated.locationId, true);
    } else if (FREE_STATUSES.has(updated.status)) {
      await setDriverBusy(updated.locationId, false);
    }

    res.json({ ok: true, order: updated });
  } catch (err: any) {
    console.error("[PATCH /orders/:id] error:", err);
    res.status(500).json({ error: "فشل تحديث الطلب" });
  }
});

// ── GET /api/orders/:id/messages — public: fetch taxi chat messages ───────────
// Scoped to a single order_id — no cross-order or gas leakage possible.
router.get("/orders/:id/messages", async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    res.status(400).json({ error: "id غير صالح" }); return;
  }
  try {
    const msgs = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.orderId, orderId))
      .orderBy(asc(messagesTable.createdAt));
    res.json(msgs);
  } catch (err: any) {
    console.error(`[GET /orders/${orderId}/messages] error:`, err);
    res.status(500).json({ error: "فشل جلب الرسائل" });
  }
});

// ── POST /api/orders/:id/messages — public: send a taxi chat message ──────────
// Creates a message scoped to this order_id and broadcasts via SSE.
router.post("/orders/:id/messages", async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    res.status(400).json({ error: "id غير صالح" }); return;
  }
  const parsed = insertMessageSchema.safeParse({ ...req.body, orderId });
  if (!parsed.success) {
    res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error?.issues }); return;
  }
  try {
    const [msg] = await db.insert(messagesTable).values(parsed.data).returning();
    broadcastNewMessage({
      id:          msg.id,
      orderId:     msg.orderId,
      senderRole:  msg.senderRole,
      content:     msg.content,
      isSystemMsg: msg.isSystemMsg,
      createdAt:   msg.createdAt,
    });
    console.log(`[POST /orders/${orderId}/messages] role=${msg.senderRole} len=${msg.content.length}`);
    res.status(201).json(msg);
  } catch (err: any) {
    console.error(`[POST /orders/${orderId}/messages] error:`, err);
    res.status(500).json({ error: "فشل إرسال الرسالة" });
  }
});

export default router;
