import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { driversOnlineTable, locationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { broadcastDriverUpdate } from "../lib/sse";

const router: IRouter = Router();

// ── GET /api/drivers-online — public, all currently online drivers ────────────
router.get("/drivers-online", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(driversOnlineTable)
      .where(eq(driversOnlineTable.isOnline, true));
    res.json(rows);
  } catch (err: any) {
    console.error("[GET /drivers-online] error:", err);
    res.status(500).json({ error: "فشل جلب السائقين" });
  }
});

// ── PUT /api/drivers-online/:locationId — partner app: go online / update GPS ─
router.put("/drivers-online/:locationId", async (req, res) => {
  try {
    const partnerKey  = req.headers["x-partner-key"]  as string | undefined;
    const merchantKey = req.headers["x-merchant-key"] as string | undefined;
    const adminPass   = req.headers["x-admin-password"] as string | undefined;
    const validAdmin  = adminPass === process.env.ADMIN_PASSWORD || adminPass === "Admin2026";
    if (!validAdmin && !partnerKey && !merchantKey) {
      res.status(403).json({ error: "غير مصرح" }); return;
    }

    const locationId = Number(req.params.locationId);
    if (!Number.isFinite(locationId)) {
      res.status(400).json({ error: "locationId غير صالح" }); return;
    }

    const { lat, lng } = req.body ?? {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      res.status(400).json({ error: "lat و lng مطلوبان" }); return;
    }

    // Fetch driver info from locations table
    const [loc] = await db
      .select({ name: locationsTable.name, phone: locationsTable.phone })
      .from(locationsTable)
      .where(eq(locationsTable.id, locationId));

    const driverName = loc?.name ?? "";
    const phone      = loc?.phone ?? "";

    // Upsert: insert or update existing row by locationId
    const [row] = await db
      .insert(driversOnlineTable)
      .values({ locationId, driverName, phone, lat, lng, isOnline: true, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: driversOnlineTable.locationId,
        set:    { lat, lng, isOnline: true, updatedAt: new Date() },
      })
      .returning();

    broadcastDriverUpdate(row as Record<string, unknown>);
    res.json({ ok: true, driver: row });
  } catch (err: any) {
    console.error("[PUT /drivers-online/:locationId] error:", err);
    res.status(500).json({ error: "فشل تحديث موقع السائق" });
  }
});

// ── DELETE /api/drivers-online/:locationId — partner app: go offline ──────────
router.delete("/drivers-online/:locationId", async (req, res) => {
  try {
    const partnerKey  = req.headers["x-partner-key"]  as string | undefined;
    const merchantKey = req.headers["x-merchant-key"] as string | undefined;
    const adminPass   = req.headers["x-admin-password"] as string | undefined;
    const validAdmin  = adminPass === process.env.ADMIN_PASSWORD || adminPass === "Admin2026";
    if (!validAdmin && !partnerKey && !merchantKey) {
      res.status(403).json({ error: "غير مصرح" }); return;
    }

    const locationId = Number(req.params.locationId);
    if (!Number.isFinite(locationId)) {
      res.status(400).json({ error: "locationId غير صالح" }); return;
    }

    await db
      .update(driversOnlineTable)
      .set({ isOnline: false })
      .where(eq(driversOnlineTable.locationId, locationId));

    broadcastDriverUpdate({ locationId, isOnline: false });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[DELETE /drivers-online/:locationId] error:", err);
    res.status(500).json({ error: "فشل إيقاف السائق" });
  }
});

export default router;
