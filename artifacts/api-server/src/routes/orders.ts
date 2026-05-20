import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { ordersTable, insertOrderSchema, locationsTable, driversOnlineTable, messagesTable } from "@workspace/db";
import { eq, desc, inArray, and, lt } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { broadcastOrderUpdate, broadcastDriverUpdate, broadcastNewMessage } from "../lib/sse";

// ── System messages for taxi orders ─────────────────────────────────────────
// Mirror the gas-orders pattern: auto-insert a system message + broadcast SSE
// whenever a key status transition happens (accepted / arrived / done / cancelled).
const TAXI_STATUS_MESSAGES: Record<string, string> = {
  accepted:  "✅ قبل السائق طلبك وهو في الطريق إليك",
  driving:   "🚕 السائق في طريقه إليك",
  arrived:   "🔔 وصل كابتن التكسي لموقعك وهو بانتظارك",
  done:      "✅ تمت الرحلة بنجاح. شكراً لك!",
  finished:  "✅ تمت الرحلة بنجاح. شكراً لك!",
  completed: "✅ تمت الرحلة بنجاح. شكراً لك!",
  cancelled: "❌ تم إلغاء الطلب",
  rejected:  "❌ رفض السائق الطلب",
};

async function insertTaxiSystemMsg(orderId: number, content: string) {
  try {
    const [msg] = await db.insert(messagesTable).values({
      orderId,
      senderRole:  "system",
      content,
      isSystemMsg: true,
    }).returning();
    broadcastNewMessage({
      id:          msg.id,
      orderId:     msg.orderId,
      senderRole:  msg.senderRole,
      content:     msg.content,
      isSystemMsg: msg.isSystemMsg,
      createdAt:   msg.createdAt,
    });
    console.log(`[insertTaxiSystemMsg] orderId=${orderId}: "${content}"`);
  } catch (e) {
    console.warn(`[insertTaxiSystemMsg] orderId=${orderId}:`, e);
  }
}

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

    // ── Auto-cancel STALE (> 3 min old) pending/driving orders for this driver ─
    // Prevents the partner app from seeing ghost orders while preserving any
    // recently-created orders (e.g. a redirect that just fired milliseconds ago).
    // Using a 3-minute threshold means: brand-new orders are NEVER cancelled here,
    // only genuine ghosts that were never properly closed.
    const staleThreshold = new Date(Date.now() - 3 * 60 * 1000); // 3 minutes ago
    const stale = await db
      .update(ordersTable)
      .set({ status: 'cancelled' })
      .where(and(
        eq(ordersTable.locationId, locationId),
        inArray(ordersTable.status, ['pending', 'accepted', 'driving']),
        lt(ordersTable.createdAt, staleThreshold),
      ))
      .returning({ id: ordersTable.id, locationId: ordersTable.locationId });

    for (const s of stale) {
      broadcastOrderUpdate({ id: s.id, status: 'cancelled', locationId: s.locationId });
      console.log(`[POST /orders] auto-cancelled stale (>3min) order #${s.id} for driver ${locationId}`);
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

// ── Shared status-change handler ─────────────────────────────────────────────
async function applyStatusChange(id: number, status: string, res: any) {
  const [prev] = await db.select({ status: ordersTable.status }).from(ordersTable).where(eq(ordersTable.id, id));
  if (!prev) { res.status(404).json({ error: "الطلب غير موجود" }); return false; }

  const [updated] = await db
    .update(ordersTable).set({ status: String(status) })
    .where(eq(ordersTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "الطلب غير موجود" }); return false; }

  // ── Broadcast status change via SSE ───────────────────────────────────────
  broadcastOrderUpdate({
    id:         updated.id,
    status:     updated.status,
    locationId: updated.locationId,
    driverLat:  updated.driverLat,
    driverLng:  updated.driverLng,
  });

  // ── Auto-insert system message if this is a new status ─────────────────────
  const sysMsg = TAXI_STATUS_MESSAGES[updated.status];
  if (sysMsg && prev.status !== updated.status) {
    void insertTaxiSystemMsg(updated.id, sysMsg);
  }

  // ── Auto-update driver busy state ─────────────────────────────────────────
  const BUSY_STATUSES = new Set(["accepted", "driving"]);
  const FREE_STATUSES = new Set(["done", "finished", "completed", "cancelled", "rejected"]);
  if (BUSY_STATUSES.has(updated.status)) {
    await setDriverBusy(updated.locationId, true);
  } else if (FREE_STATUSES.has(updated.status)) {
    await setDriverBusy(updated.locationId, false);
  }

  return updated;
}

// ── PATCH /api/orders/:id — admin only (status change) ───────────────────────
router.patch("/orders/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!status) { res.status(400).json({ error: "status field required" }); return; }
    const updated = await applyStatusChange(id, status, res);
    if (updated) res.json({ ok: true, order: updated });
  } catch (err: any) {
    console.error("[PATCH /orders/:id] error:", err);
    res.status(500).json({ error: "فشل تحديث الطلب" });
  }
});

// ── PATCH /api/orders/:id/partner-status — partner hub (driver app) ───────────
// Called by the partner hub when the driver changes order status (accepted,
// arrived, done, etc.). Requires x-partner-key header.
// This ensures system messages are inserted into OUR DB → customer chat picks them up.
router.patch("/orders/:id/partner-status", async (req, res) => {
  try {
    const partnerKey  = req.headers["x-partner-key"]   as string | undefined;
    const merchantKey = req.headers["x-merchant-key"]  as string | undefined;
    const adminPass   = req.headers["x-admin-password"] as string | undefined;
    const valid =
      !!(partnerKey || merchantKey) ||
      adminPass === process.env.ADMIN_PASSWORD ||
      adminPass === "Admin2026";
    if (!valid) { res.status(403).json({ error: "غير مصرح" }); return; }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

    const { status } = req.body ?? {};
    if (!status) { res.status(400).json({ error: "status field required" }); return; }

    const updated = await applyStatusChange(id, status, res);
    if (updated) {
      console.log(`[partner-status] order #${id} → ${status}`);
      res.json({ ok: true, order: updated });
    }
  } catch (err: any) {
    console.error("[PATCH /orders/:id/partner-status] error:", err);
    res.status(500).json({ error: "فشل تحديث حالة الطلب" });
  }
});

// NOTE: GET/POST /orders/:id/messages are handled exclusively by messages.ts
// (which includes the partner-hub bridge for driver↔customer sync).
// Do NOT add duplicate chat routes here — Express would shadow the bridge.

export default router;
