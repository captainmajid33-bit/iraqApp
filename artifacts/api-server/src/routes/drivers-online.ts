import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { driversOnlineTable, locationsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { broadcastDriverUpdate } from "../lib/sse";

const router: IRouter = Router();

// ── Auth helper ───────────────────────────────────────────────────────────────
function isAuthorised(req: any): boolean {
  const partnerKey  = req.headers["x-partner-key"]  as string | undefined;
  const merchantKey = req.headers["x-merchant-key"] as string | undefined;
  const adminPass   = req.headers["x-admin-password"] as string | undefined;
  const validAdmin  = adminPass === process.env.ADMIN_PASSWORD || adminPass === "Admin2026";
  return !!(validAdmin || partnerKey || merchantKey);
}

// ── GET /api/drivers-online ───────────────────────────────────────────────────
// Public — returns only drivers that are:
//   • isOnline  = true
//   • isBusy    = false   ← NEW: skip drivers currently on a ride
//   • location.status = 'مفتوح'  (not disabled / closed)
router.get("/drivers-online", async (_req, res) => {
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
      .innerJoin(locationsTable, eq(driversOnlineTable.locationId, locationsTable.id))
      .where(
        and(
          eq(driversOnlineTable.isOnline, true),
          eq(driversOnlineTable.isBusy,   false),
          eq(locationsTable.status,        "مفتوح"),
        )
      );

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

  const { lat, lng } = req.body ?? {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400).json({ error: "lat و lng مطلوبان" }); return;
  }

  try {
    const [loc] = await db
      .select({ name: locationsTable.name, phone: locationsTable.phone })
      .from(locationsTable)
      .where(eq(locationsTable.id, locationId));

    const driverName = loc?.name ?? "";
    const phone      = loc?.phone ?? "";

    const [row] = await db
      .insert(driversOnlineTable)
      .values({ locationId, driverName, phone, lat, lng, isOnline: true, isBusy: false, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: driversOnlineTable.locationId,
        set:    { lat, lng, isOnline: true, updatedAt: new Date() },
        // NOTE: isBusy is NOT reset on location update — preserve current busy state
      })
      .returning();

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
    await db
      .update(driversOnlineTable)
      .set({ isOnline: false, isBusy: false, updatedAt: new Date() })
      .where(eq(driversOnlineTable.locationId, locationId));

    broadcastDriverUpdate({ locationId, isOnline: false, isBusy: false });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[DELETE /drivers-online/:locationId] error:", err);
    res.status(500).json({ error: "فشل إيقاف السائق" });
  }
});

export default router;
