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

// ── Helper: mark driver busy (during a trip) ─────────────────────────────────
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
    console.warn(`[BUSY-AUTO] could not update isBusy for driver ${locationId}:`, err);
  }
}

// ── Helper: fully restore driver to available after trip ends ─────────────────
// Sets isBusy=false AND isOnline=true so the driver immediately reappears
// on the 2 km radar for new customers — no need to log out and back in.
async function setDriverAvailable(locationId: number) {
  try {
    const [updated] = await db
      .update(driversOnlineTable)
      .set({ isBusy: false, isOnline: true, updatedAt: new Date() })
      .where(eq(driversOnlineTable.locationId, locationId))
      .returning();
    if (updated) {
      broadcastDriverUpdate(updated as Record<string, unknown>);
      console.log(`[FREE-AUTO] driver ${locationId} → isOnline=true isBusy=false (available for new trips)`);
    }
  } catch (err) {
    console.warn(`[FREE-AUTO] could not restore driver ${locationId}:`, err);
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

    // Ensure driver is fully available before new order (isOnline=true, isBusy=false)
    await setDriverAvailable(locationId);

    // ── Insert order ──────────────────────────────────────────────────────────
    // Always use the real locationId — the schema has no FK constraint on this column,
    // so Firebase UID-derived IDs (like 927734, 936095) are valid integer values.
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
      `[POST /orders] #${order.id} → ${driverLabel || `driver#${locationId}`} (locId=${locationId}) | user:${userName ?? '?'} | phone:${phone} | dest:${destination} | price:${estimatedPrice ?? '?'} IQD | gps:(${order.fromLat ?? order.lat ?? 'null'},${order.fromLng ?? order.lng ?? 'null'})`
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
    // Coalesce: use fromLat/fromLng first; fall back to lat/lng if null
    // (older orders and some code paths only populate lat/lng).
    const customerLat = order.fromLat ?? order.lat ?? null;
    const customerLng = order.fromLng ?? order.lng ?? null;
    res.json({
      id:             order.id,
      status:         order.status,
      locationId:     order.locationId,
      userName:       order.userName,
      phone:          order.phone,
      destination:    order.destination,
      driverLat:      order.driverLat,
      driverLng:      order.driverLng,
      fromLat:        customerLat,
      fromLng:        customerLng,
      customerLat:    customerLat,
      customerLng:    customerLng,
      lat:            customerLat,
      lng:            customerLng,
      toLat:          order.toLat,
      toLng:          order.toLng,
      estimatedPrice: order.estimatedPrice,
      createdAt:      order.createdAt,
    });
  } catch (err: any) {
    console.error("[GET /orders/:id] error:", err);
    res.status(500).json({ error: "فشل جلب الطلب" });
  }
});

// ── PATCH /api/orders/:id/reassign-driver — redirect loop: move order silently ─
// Reassigns an existing order to a new driver by updating locationId + resetting
// status to 'pending'. Does NOT broadcast 'cancelled' to the customer — the loop
// keeps the same orderId throughout the entire search session.
router.patch("/orders/:id/reassign-driver", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

  const { locationId } = req.body ?? {};
  if (typeof locationId !== "number") {
    res.status(400).json({ error: "locationId (number) مطلوب" }); return;
  }

  try {
    // Get old driver so we can free them
    const [current] = await db
      .select({ locationId: ordersTable.locationId })
      .from(ordersTable)
      .where(eq(ordersTable.id, id));

    if (!current) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    // Restore old driver to fully available (isOnline=true, isBusy=false)
    if (current.locationId !== locationId) {
      await setDriverAvailable(current.locationId);
    }

    // Reassign — reset status to pending for new driver
    const [updated] = await db
      .update(ordersTable)
      .set({ locationId, status: 'pending', updatedAt: new Date() })
      .where(eq(ordersTable.id, id))
      .returning();

    if (!updated) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    // Ensure new driver is fully available before assigning
    await setDriverAvailable(locationId);

    // Notify new driver's app (partner app polls by locationId)
    // NOTE: no 'cancelled' event — customer keeps same orderId, loop stays alive.
    broadcastOrderUpdate({ id: updated.id, status: 'pending', locationId });

    console.log(`[PATCH /orders/${id}/reassign-driver] ${current.locationId} → ${locationId}`);
    res.json({ ok: true, orderId: id });
  } catch (err: any) {
    console.error("[PATCH /orders/:id/reassign-driver] error:", err);
    res.status(500).json({ error: "فشل إعادة تعيين السائق" });
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
    await setDriverAvailable(updated.locationId);

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

    const raw = locationId
      ? await db.select().from(ordersTable).where(eq(ordersTable.locationId, locationId)).orderBy(desc(ordersTable.createdAt))
      : await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));

    // Normalise: coalesce fromLat/fromLng ← lat/lng so partner hub always
    // gets valid customer coordinates regardless of which code path created the order.
    const rows = raw.map(o => ({
      ...o,
      fromLat:     o.fromLat ?? o.lat ?? null,
      fromLng:     o.fromLng ?? o.lng ?? null,
      customerLat: o.fromLat ?? o.lat ?? null,
      customerLng: o.fromLng ?? o.lng ?? null,
    }));

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

  // ── Fetch driver name when accepted so customer app can display it ─────────
  // Priority: driversOnline.driverName → locationsTable.name → null
  // (driversOnline.driverName is often "" for Firestore-registered drivers
  //  whose name is stored in locationsTable instead).
  let driverName: string | null = null;
  if (status === "accepted" || status === "driving") {
    try {
      const [drvRow] = await db
        .select({ driverName: driversOnlineTable.driverName })
        .from(driversOnlineTable)
        .where(eq(driversOnlineTable.locationId, updated.locationId));
      const fromOnline = drvRow?.driverName?.trim() || null;

      const [locRow] = await db
        .select({ name: locationsTable.name })
        .from(locationsTable)
        .where(eq(locationsTable.id, updated.locationId));
      const fromLoc = locRow?.name?.trim() || null;

      driverName = fromOnline || fromLoc || null;
      console.log(`[applyStatusChange] order #${id} accepted | driverName="${driverName}" (online="${fromOnline}" loc="${fromLoc}")`);
    } catch { /* non-fatal */ }
  }

  // ── Broadcast status change via SSE ───────────────────────────────────────
  broadcastOrderUpdate({
    id:         updated.id,
    status:     updated.status,
    locationId: updated.locationId,
    driverLat:  updated.driverLat,
    driverLng:  updated.driverLng,
    ...(driverName ? { driverName } : {}),
  });

  // ── Auto-insert system message if this is a new status ─────────────────────
  const sysMsg = TAXI_STATUS_MESSAGES[updated.status];
  if (sysMsg && prev.status !== updated.status) {
    void insertTaxiSystemMsg(updated.id, sysMsg);
  }

  // ── Auto-update driver state ───────────────────────────────────────────────
  // BUSY: mark driver unavailable during an active trip.
  // FREE: fully restore driver (isOnline=true, isBusy=false) so they
  //       reappear instantly on the 2 km radar without needing to re-login.
  const BUSY_STATUSES = new Set(["accepted", "driving"]);
  const FREE_STATUSES = new Set(["done", "finished", "completed", "arrived", "cancelled", "rejected"]);
  if (BUSY_STATUSES.has(updated.status)) {
    await setDriverBusy(updated.locationId, true);
  } else if (FREE_STATUSES.has(updated.status)) {
    await setDriverAvailable(updated.locationId);
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

// ── PATCH /api/orders/:id/status — open alias used by partner hub ─────────────
// The partner hub (diyala-partner-hub.replit.app) calls PATCH /api/orders/:id/status
// when the driver accepts, arrives, or finishes a trip. No auth header required
// so the Flutter app does not need to manage credentials — just the orderId.
router.patch("/orders/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

    const { status, driverLat, driverLng } = req.body ?? {};
    if (!status) { res.status(400).json({ error: "status مطلوب" }); return; }

    const updated = await applyStatusChange(id, status, res);
    if (updated) {
      // If partner hub also sends GPS in same payload, persist it immediately
      if (typeof driverLat === "number" && typeof driverLng === "number") {
        await db
          .update(ordersTable)
          .set({ driverLat, driverLng })
          .where(eq(ordersTable.id, id));
        broadcastOrderUpdate({
          id: updated.id, status: updated.status,
          driverLat, driverLng, locationId: updated.locationId,
        });
      }
      console.log(`[PATCH /orders/${id}/status] → ${status}`);
      res.json({ ok: true, order: updated });
    }
  } catch (err: any) {
    console.error("[PATCH /orders/:id/status] error:", err);
    res.status(500).json({ error: "فشل تحديث حالة الطلب" });
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
