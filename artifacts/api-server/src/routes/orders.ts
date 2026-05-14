import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { ordersTable, insertOrderSchema, locationsTable, driversOnlineTable, gasOrdersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { broadcastOrderUpdate, broadcastDriverUpdate, addOrdersStreamClient, removeOrdersStreamClient, broadcastGasOrdersToOrdersStream } from "../lib/sse";

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

// ── Helper: map a gas order to the shape the partner app expects ──────────────
function gasOrderToOrderShape(o: typeof gasOrdersTable.$inferSelect, locationId?: string | null) {
  return {
    id:             `gas_${o.id}`,
    type:           "gas",
    locationId:     locationId ?? null,
    userName:       o.userName,
    phone:          o.phone,
    destination:    o.locationAddress,
    toLat:          null,
    toLng:          null,
    estimatedPrice: null,
    lat:            o.lat,
    lng:            o.lng,
    driverLat:      null,
    driverLng:      null,
    status:         o.status,
    createdAt:      o.createdAt,
  };
}

// ── GET /api/orders/stream — SSE for partner app gas-order notifications ──────
// MUST be registered before /orders/:id so Express doesn't treat "stream" as an id.
// Partner app connects: EventSource(`/api/orders/stream?locationId=24`)
// and listens via onmessage for: data: {"type":"gas_order_update","orders":[...]}
router.get("/orders/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(":connected\n\n");

  addOrdersStreamClient(res);

  const locationId = req.query.locationId as string | undefined;

  // Replay all pending gas orders immediately to this new client
  try {
    const pending = await db
      .select()
      .from(gasOrdersTable)
      .where(eq(gasOrdersTable.status, "pending"))
      .orderBy(desc(gasOrdersTable.createdAt));

    if (pending.length > 0) {
      const orders = pending.map(o => gasOrderToOrderShape(o, locationId));
      res.write(`data: ${JSON.stringify({ type: "gas_order_update", orders })}\n\n`);
      console.log(`[/orders/stream] locationId=${locationId ?? "?"} — replayed ${pending.length} pending gas order(s)`);
    }
  } catch (err) {
    console.warn("[/orders/stream] replay error:", err);
  }

  const hb = setInterval(() => {
    try { res.write(":heartbeat\n\n"); } catch { clearInterval(hb); }
  }, 25_000);

  req.on("close", () => {
    clearInterval(hb);
    removeOrdersStreamClient(res);
  });
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

// ── GET /api/orders — partners + admin: list orders, optionally by locationId ─
// When status=pending, gas orders for gas agents are merged in.
router.get("/orders", async (req, res) => {
  const partnerKey  = req.headers["x-partner-key"]    as string | undefined;
  const merchantKey = req.headers["x-merchant-key"]   as string | undefined;
  const adminPass   = req.headers["x-admin-password"] as string | undefined;
  const isAdmin =
    adminPass === process.env.ADMIN_PASSWORD ||
    adminPass === "Admin2026";
  const isPartner = !!(partnerKey || merchantKey);

  // Allow partners AND admins; block unauthenticated requests only if strict auth is on
  if (!isAdmin && !isPartner && process.env.ADMIN_PASSWORD) {
    res.status(403).json({ error: "غير مصرح" }); return;
  }

  try {
    const locationId = req.query.locationId ? Number(req.query.locationId) : null;
    const statusFilter = req.query.status as string | undefined;

    const rows = locationId
      ? await db.select().from(ordersTable).where(eq(ordersTable.locationId, locationId)).orderBy(desc(ordersTable.createdAt))
      : await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));

    // ── When fetching pending orders for a partner, also include pending gas orders ─
    let allRows: unknown[] = rows;
    if (statusFilter === "pending" || !statusFilter) {
      const gasRows = await db
        .select()
        .from(gasOrdersTable)
        .where(eq(gasOrdersTable.status, "pending"))
        .orderBy(desc(gasOrdersTable.createdAt));

      const mappedGas = gasRows.map(o => gasOrderToOrderShape(o, locationId ? String(locationId) : null));
      allRows = [...rows, ...mappedGas];
    }

    res.json(allRows);
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
    const FREE_STATUSES = new Set(["done", "finished", "cancelled", "rejected"]);

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

export default router;
