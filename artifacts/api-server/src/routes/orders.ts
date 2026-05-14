import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { ordersTable, insertOrderSchema, locationsTable, driversOnlineTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { broadcastOrderUpdate, broadcastDriverUpdate } from "../lib/sse";

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

    // ── Fetch driver's location profile ───────────────────────────────────────
    const [loc] = await db
      .select({ id: locationsTable.id, name: locationsTable.name, status: locationsTable.status })
      .from(locationsTable)
      .where(eq(locationsTable.id, locationId));

    if (!loc) {
      res.status(404).json({ error: "لم يتم العثور على السائق" });
      return;
    }
    if (loc.status === "معطّل") {
      res.status(409).json({ error: "هذا السائق غير متاح حالياً" });
      return;
    }

    // ── Check isBusy: reject if driver is already on a ride ───────────────────
    const [onlineRow] = await db
      .select({ isBusy: driversOnlineTable.isBusy, isOnline: driversOnlineTable.isOnline })
      .from(driversOnlineTable)
      .where(eq(driversOnlineTable.locationId, locationId));

    if (onlineRow?.isBusy) {
      res.status(409).json({ error: "السائق مشغول حالياً في رحلة أخرى، يرجى اختيار سائق آخر" });
      return;
    }

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
      `[POST /orders] #${order.id} → ${loc.name} | user:${userName ?? '?'} | phone:${phone} | dest:${destination} | price:${estimatedPrice ?? '?'} IQD`
    );
    res.status(201).json({ ok: true, orderId: order.id, status: order.status });
  } catch (err: any) {
    console.error("[POST /orders] error:", err);
    res.status(500).json({ error: "فشل حفظ الطلب", detail: err?.message });
  }
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

// ── GET /api/orders — admin only ─────────────────────────────────────────────
router.get("/orders", requireAdmin, async (req, res) => {
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
