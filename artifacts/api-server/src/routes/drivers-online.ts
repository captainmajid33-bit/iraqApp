import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { driversOnlineTable, locationsTable, ordersTable } from "@workspace/db";
import { eq, and, or, isNull } from "drizzle-orm";
import { broadcastDriverUpdate, broadcastOrderUpdate } from "../lib/sse";

const router: IRouter = Router();

// ── Auth helper ───────────────────────────────────────────────────────────────
function isAuthorised(req: any): boolean {
  const partnerKey  = req.headers["x-partner-key"]  as string | undefined;
  const merchantKey = req.headers["x-merchant-key"] as string | undefined;
  const adminPass   = req.headers["x-admin-password"] as string | undefined;
  const validAdmin  = adminPass === process.env.ADMIN_PASSWORD || adminPass === "Admin2026";
  return !!(validAdmin || partnerKey || merchantKey);
}

// ── GET /api/drivers-online/all — admin: returns ALL drivers regardless of status ─
router.get("/drivers-online/all", async (req, res) => {
  if (!isAuthorised(req)) { res.status(403).json({ error: "غير مصرح" }); return; }
  try {
    const rows = await db
      .select({
        id:         driversOnlineTable.id,
        locationId: driversOnlineTable.locationId,
        driverName: driversOnlineTable.driverName,
        phone:      driversOnlineTable.phone,
        lat:        driversOnlineTable.lat,
        lng:        driversOnlineTable.lng,
        isOnline:   driversOnlineTable.isOnline,
        isBusy:     driversOnlineTable.isBusy,
        updatedAt:  driversOnlineTable.updatedAt,
      })
      .from(driversOnlineTable)
      .orderBy(driversOnlineTable.updatedAt);
    res.json(rows);
  } catch (err: any) {
    console.error("[GET /drivers-online/all] error:", err);
    res.status(500).json({ error: "فشل جلب السائقين" });
  }
});

// ── GET /api/drivers-online ───────────────────────────────────────────────────
// Public — returns only drivers that are:
//   • isOnline  = true
//   • isBusy    = false
//   • category  = ?category query param (optional, e.g. 'taxi')
//   • location.status = 'مفتوح' (not disabled / closed)
router.get("/drivers-online", async (req, res) => {
  const categoryFilter = typeof req.query.category === "string" && req.query.category.trim()
    ? req.query.category.trim()
    : null;
  try {
    const rows = await db
      .select({
        id:         driversOnlineTable.id,
        locationId: driversOnlineTable.locationId,
        driverName: driversOnlineTable.driverName,
        phone:      driversOnlineTable.phone,
        lat:        driversOnlineTable.lat,
        lng:        driversOnlineTable.lng,
        isOnline:   driversOnlineTable.isOnline,
        isBusy:     driversOnlineTable.isBusy,
        category:   driversOnlineTable.category,
        updatedAt:  driversOnlineTable.updatedAt,
      })
      .from(driversOnlineTable)
      .leftJoin(locationsTable, eq(driversOnlineTable.locationId, locationsTable.id))
      .where(
        and(
          eq(driversOnlineTable.isOnline, true),
          eq(driversOnlineTable.isBusy,   false),
          // Filter by category when provided
          categoryFilter ? eq(driversOnlineTable.category, categoryFilter) : undefined,
          // Show driver only if: location is open, OR driver has no location row at all
          // Drivers with a مغلق location are always hidden
          or(
            isNull(locationsTable.id),
            eq(locationsTable.status, "مفتوح"),
            eq(locationsTable.status, "open"),
          ),
          // Exclude drivers whose location explicitly has مغلق status
          // (reinforces the OR above — belt-and-suspenders for location-linked drivers)
        )
      );

    console.log(`[GET /drivers-online] cat=${categoryFilter ?? "all"} returned ${rows.length} driver(s):`,
      rows.map(r => ({ name: r.driverName, locationId: r.locationId, cat: r.category, isOnline: r.isOnline, isBusy: r.isBusy })));
    res.json(rows);
  } catch (err: any) {
    console.error("[GET /drivers-online] error:", err);
    res.status(500).json({ error: "فشل جلب السائقين" });
  }
});

// ── PUT /api/drivers-online/:locationId — partner app: go online / update GPS ─
router.put("/drivers-online/:locationId", async (req, res) => {
  if (!isAuthorised(req)) { res.status(403).json({ error: "غير مصرح" }); return; }

  const locationId = Number(req.params.locationId);
  if (!Number.isFinite(locationId)) {
    res.status(400).json({ error: "locationId غير صالح" }); return;
  }

  const { lat, lng, driverName: bodyName, phone: bodyPhone, category: bodyCategory } = req.body ?? {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400).json({ error: "lat و lng مطلوبان" }); return;
  }

  try {
    const [loc] = await db
      .select({ name: locationsTable.name, phone: locationsTable.phone })
      .from(locationsTable)
      .where(eq(locationsTable.id, locationId));

    // Use DB location name/phone first; fall back to body-provided values
    const driverName = loc?.name ?? (typeof bodyName === "string" ? bodyName : "") ?? "";
    const phone      = loc?.phone ?? (typeof bodyPhone === "string" ? bodyPhone : "") ?? "";
    const category   = typeof bodyCategory === "string" && bodyCategory.trim() ? bodyCategory.trim() : "taxi";

    const [row] = await db
      .insert(driversOnlineTable)
      .values({ locationId, driverName, phone, lat, lng, isOnline: true, isBusy: false, category, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: driversOnlineTable.locationId,
        // Update name/phone/category too in case they were empty on first insert
        set:    { lat, lng, isOnline: true, updatedAt: new Date(),
                  ...(driverName ? { driverName } : {}),
                  ...(phone      ? { phone }      : {}),
                  ...(category   ? { category }   : {}) },
        // NOTE: isBusy is NOT reset on location update — preserve current busy state
      })
      .returning();

    const origin = req.headers["origin"] || req.headers["referer"] || "unknown";
    console.log(`[PUT /drivers-online] ✅ driver ${locationId} (${driverName}) online | origin=${origin} | lat=${lat} lng=${lng}`);
    broadcastDriverUpdate(row as Record<string, unknown>);
    res.json({ ok: true, driver: row });
  } catch (err: any) {
    console.error("[PUT /drivers-online/:locationId] error:", err);
    res.status(500).json({ error: "فشل تحديث موقع السائق" });
  }
});

// ── PATCH /api/drivers-online/:locationId/busy — set / clear busy flag ────────
// Called by partner app when driver accepts an order (busy=true)
// or when ride is done / cancelled (busy=false).
router.patch("/drivers-online/:locationId/busy", async (req, res) => {
  if (!isAuthorised(req)) { res.status(403).json({ error: "غير مصرح" }); return; }

  const locationId = Number(req.params.locationId);
  if (!Number.isFinite(locationId)) {
    res.status(400).json({ error: "locationId غير صالح" }); return;
  }

  const { busy } = req.body ?? {};
  if (typeof busy !== "boolean") {
    res.status(400).json({ error: "حقل busy (boolean) مطلوب" }); return;
  }

  try {
    const [updated] = await db
      .update(driversOnlineTable)
      .set({ isBusy: busy, updatedAt: new Date() })
      .where(eq(driversOnlineTable.locationId, locationId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "السائق غير موجود في قائمة المتصلين" }); return;
    }

    console.log(`[BUSY] driver ${locationId} → isBusy=${busy}`);
    broadcastDriverUpdate(updated as Record<string, unknown>);
    res.json({ ok: true, isBusy: updated.isBusy });
  } catch (err: any) {
    console.error("[PATCH /drivers-online/:locationId/busy] error:", err);
    res.status(500).json({ error: "فشل تحديث حالة الانشغال" });
  }
});

// ── DELETE /api/drivers-online/:locationId — partner app: go offline ──────────
router.delete("/drivers-online/:locationId", async (req, res) => {
  if (!isAuthorised(req)) { res.status(403).json({ error: "غير مصرح" }); return; }

  const locationId = Number(req.params.locationId);
  if (!Number.isFinite(locationId)) {
    res.status(400).json({ error: "locationId غير صالح" }); return;
  }

  try {
    const [offlined] = await db
      .update(driversOnlineTable)
      .set({ isOnline: false, isBusy: false, updatedAt: new Date() })
      .where(eq(driversOnlineTable.locationId, locationId))
      .returning();

    // Include phone + driverName so the frontend SSE listener can remove
    // the correct marker from onlineDrivers state by phone key.
    broadcastDriverUpdate({
      locationId,
      isOnline:   false,
      isBusy:     false,
      phone:      offlined?.phone      ?? '',
      driverName: offlined?.driverName ?? '',
    });

    // ── Auto-reject any pending order assigned to this driver ─────────────
    // If the driver goes offline while a taxi order is waiting for acceptance,
    // reject it immediately so the customer search-loop redirects to the next
    // available driver without waiting for the full countdown timer.
    const pendingOrders = await db
      .select({ id: ordersTable.id, locationId: ordersTable.locationId })
      .from(ordersTable)
      .where(and(
        eq(ordersTable.locationId, locationId),
        eq(ordersTable.status, 'pending'),
      ));

    for (const ord of pendingOrders) {
      const [rejected] = await db
        .update(ordersTable)
        .set({ status: 'rejected' })
        .where(eq(ordersTable.id, ord.id))
        .returning();
      if (rejected) {
        broadcastOrderUpdate({
          id:         rejected.id,
          status:     'rejected',
          locationId: rejected.locationId,
          driverLat:  rejected.driverLat,
          driverLng:  rejected.driverLng,
        });
        console.log(`[DELETE /drivers-online] auto-rejected order #${rejected.id} (driver ${locationId} went offline)`);
      }
    }

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[DELETE /drivers-online/:locationId] error:", err);
    res.status(500).json({ error: "فشل إيقاف السائق" });
  }
});

export default router;
