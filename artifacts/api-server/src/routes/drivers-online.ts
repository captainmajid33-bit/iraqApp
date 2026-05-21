import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { driversOnlineTable, locationsTable, ordersTable } from "@workspace/db";
import { eq, and, or, isNull, gt, lt } from "drizzle-orm";
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

// ── Shared GPS upsert logic — reused by no-ID and with-ID routes ─────────────
// Resolves locationId from: (1) explicit numeric id, (2) phone → locations,
// (3) phone → drivers_online, (4) Firebase-UID/IP hash (last resort).
async function resolveAndUpsertDriver(
  rawId:        string | null,    // from URL param or null when not provided
  lat:          number,
  lng:          number,
  bodyPhone:    string,
  bodyName:     string,
  bodyCategory: string,
  fallbackKey?: string,           // IP or user-agent for last-resort hash
): Promise<{ ok: boolean; driver?: unknown; error?: string }> {
  let locationId: number | null = null;
  let resolvedName  = bodyName.trim();
  let resolvedPhone = bodyPhone.trim();
  const category    = bodyCategory.trim() || "taxi";

  function strHash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return 900000 + Math.abs(h) % 99999;
  }

  if (rawId) {
    const numericId = Number(rawId);
    if (Number.isFinite(numericId)) {
      locationId = numericId;
    } else {
      // Firebase UID path — look up by phone first
      if (resolvedPhone) {
        const [loc] = await db
          .select({ id: locationsTable.id, name: locationsTable.name })
          .from(locationsTable)
          .where(eq(locationsTable.phone, resolvedPhone));
        if (loc) { locationId = loc.id; resolvedName = resolvedName || loc.name; }
      }
      if (!locationId && resolvedPhone) {
        const [existing] = await db
          .select({ locationId: driversOnlineTable.locationId, driverName: driversOnlineTable.driverName })
          .from(driversOnlineTable)
          .where(eq(driversOnlineTable.phone, resolvedPhone));
        if (existing) { locationId = existing.locationId; resolvedName = resolvedName || existing.driverName || ""; }
      }
      if (!locationId) {
        locationId = strHash(rawId);
        console.log(`[GPS upsert] Firebase UID ${rawId} → derived locationId=${locationId}`);
      }
    }
  } else {
    // No URL id — identify by phone first
    if (resolvedPhone) {
      const [loc] = await db
        .select({ id: locationsTable.id, name: locationsTable.name })
        .from(locationsTable)
        .where(eq(locationsTable.phone, resolvedPhone));
      if (loc) { locationId = loc.id; resolvedName = resolvedName || loc.name; }
    }
    if (!locationId && resolvedPhone) {
      const [existing] = await db
        .select({ locationId: driversOnlineTable.locationId, driverName: driversOnlineTable.driverName })
        .from(driversOnlineTable)
        .where(eq(driversOnlineTable.phone, resolvedPhone));
      if (existing) { locationId = existing.locationId; resolvedName = resolvedName || existing.driverName || ""; }
    }
    // Last resort: stable hash from phone or fallbackKey (IP/UA)
    if (!locationId) {
      const seed = resolvedPhone || fallbackKey || "unknown";
      locationId = strHash(seed);
      console.log(`[GPS upsert] no-id fallback key="${seed}" → derived locationId=${locationId}`);
    }
  }

  const [row] = await db
    .insert(driversOnlineTable)
    .values({ locationId: locationId!, driverName: resolvedName, phone: resolvedPhone,
              lat, lng, isOnline: true, isBusy: false, category, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: driversOnlineTable.locationId,
      set: { lat, lng, isOnline: true, updatedAt: new Date(),
             ...(resolvedName  ? { driverName: resolvedName } : {}),
             ...(resolvedPhone ? { phone: resolvedPhone }     : {}),
             ...(category      ? { category }                 : {}) },
    })
    .returning();

  console.log(`[GPS upsert] ✅ driver locationId=${locationId} (${resolvedName || rawId || resolvedPhone}) → lat=${lat} lng=${lng}`);
  broadcastDriverUpdate(row as Record<string, unknown>);
  return { ok: true, driver: row };
}

// ── PATCH /api/drivers-online  ← NO ID in URL (partner-hub sends this form) ──
// Partner app sends PATCH /api/drivers-online/ with body {lat,lng,phone,...}
// — the locationId is missing from the URL. We resolve it from the body.
router.patch("/drivers-online", async (req, res) => {
  if (!isAuthorised(req)) { res.status(403).json({ error: "غير مصرح" }); return; }
  const body = req.body ?? {};
  const { lat, lng, phone: bodyPhone = "", driverName: bodyName = "", category: bodyCategory = "taxi", uid } = body;
  // Log full body so we can see what the partner hub actually sends
  console.log("[PATCH /drivers-online no-id] body keys:", Object.keys(body), "| phone:", bodyPhone, "| uid:", uid, "| lat:", lat, "| lng:", lng);
  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400).json({ error: "lat و lng مطلوبان" }); return;
  }
  try {
    const rawId = typeof uid === "string" && uid.trim() ? uid.trim() : null;
    const ip = (req.headers["x-forwarded-for"] as string || req.socket?.remoteAddress || "").split(",")[0].trim();
    const result = await resolveAndUpsertDriver(rawId, lat, lng, bodyPhone, bodyName, bodyCategory, ip);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    res.json({ ok: true, driver: result.driver });
  } catch (err: any) {
    console.error("[PATCH /drivers-online (no-id)] error:", err);
    res.status(500).json({ error: "فشل تحديث موقع السائق" });
  }
});

// ── PUT /api/drivers-online  ← NO ID in URL (same body-only form) ────────────
router.put("/drivers-online", async (req, res) => {
  if (!isAuthorised(req)) { res.status(403).json({ error: "غير مصرح" }); return; }
  const body = req.body ?? {};
  const { lat, lng, phone: bodyPhone = "", driverName: bodyName = "", category: bodyCategory = "taxi", uid } = body;
  console.log("[PUT /drivers-online no-id] body keys:", Object.keys(body), "| phone:", bodyPhone, "| uid:", uid, "| lat:", lat, "| lng:", lng);
  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400).json({ error: "lat و lng مطلوبان" }); return;
  }
  try {
    const rawId = typeof uid === "string" && uid.trim() ? uid.trim() : null;
    const ip = (req.headers["x-forwarded-for"] as string || req.socket?.remoteAddress || "").split(",")[0].trim();
    const result = await resolveAndUpsertDriver(rawId, lat, lng, bodyPhone, bodyName, bodyCategory, ip);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    res.json({ ok: true, driver: result.driver });
  } catch (err: any) {
    console.error("[PUT /drivers-online (no-id)] error:", err);
    res.status(500).json({ error: "فشل تحديث موقع السائق" });
  }
});

// ── PUT /api/drivers-online/:locationId — partner app: go online / update GPS ─
// Handles both numeric locationIds AND Firebase UIDs (non-numeric strings).
// Firebase UIDs are resolved the same way as the no-ID route: phone lookup → IP hash.
router.put("/drivers-online/:locationId", async (req, res) => {
  if (!isAuthorised(req)) { res.status(403).json({ error: "غير مصرح" }); return; }

  const rawParam  = req.params.locationId;
  const numericId = Number(rawParam);
  const { lat, lng, driverName: bodyName, phone: bodyPhone, category: bodyCategory } = req.body ?? {};

  console.log(`[PUT /drivers-online/:id] rawParam=${rawParam} | lat=${lat} | lng=${lng} | phone=${bodyPhone}`);

  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400).json({ error: "lat و lng مطلوبان" }); return;
  }

  // ── Case 1: Non-numeric ID (Firebase UID) → resolve via phone / IP hash ──
  if (!Number.isFinite(numericId)) {
    try {
      const ip = (req.headers["x-forwarded-for"] as string || req.socket?.remoteAddress || "").split(",")[0].trim();
      const result = await resolveAndUpsertDriver(rawParam, lat, lng,
        typeof bodyPhone === "string" ? bodyPhone : "",
        typeof bodyName  === "string" ? bodyName  : "",
        typeof bodyCategory === "string" && bodyCategory.trim() ? bodyCategory.trim() : "taxi",
        ip);
      if (!result.ok) { res.status(400).json({ error: result.error }); return; }
      console.log(`[PUT /drivers-online] ✅ uid=${rawParam} resolved→locId=${result.driver?.locationId}`);
      broadcastDriverUpdate(result.driver as Record<string, unknown>);
      res.json({ ok: true, driver: result.driver });
    } catch (err: any) {
      console.error("[PUT /drivers-online/:locationId] uid-path error:", err);
      res.status(500).json({ error: "فشل تحديث موقع السائق" });
    }
    return;
  }

  // ── Case 2: Numeric locationId → standard upsert ──────────────────────────
  try {
    const [loc] = await db
      .select({ name: locationsTable.name, phone: locationsTable.phone })
      .from(locationsTable)
      .where(eq(locationsTable.id, numericId));

    const driverName = loc?.name ?? (typeof bodyName === "string" ? bodyName : "") ?? "";
    const phone      = loc?.phone ?? (typeof bodyPhone === "string" ? bodyPhone : "") ?? "";
    const category   = typeof bodyCategory === "string" && bodyCategory.trim() ? bodyCategory.trim() : "taxi";

    const [row] = await db
      .insert(driversOnlineTable)
      .values({ locationId: numericId, driverName, phone, lat, lng, isOnline: true, isBusy: false, category, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: driversOnlineTable.locationId,
        set:    { lat, lng, isOnline: true, updatedAt: new Date(),
                  ...(driverName ? { driverName } : {}),
                  ...(phone      ? { phone }      : {}),
                  ...(category   ? { category }   : {}) },
      })
      .returning();

    const origin = req.headers["origin"] || req.headers["referer"] || "unknown";
    console.log(`[PUT /drivers-online] ✅ driver ${numericId} (${driverName}) online | origin=${origin} | lat=${lat} lng=${lng}`);
    broadcastDriverUpdate(row as Record<string, unknown>);
    res.json({ ok: true, driver: row });
  } catch (err: any) {
    console.error("[PUT /drivers-online/:locationId] error:", err);
    res.status(500).json({ error: "فشل تحديث موقع السائق" });
  }
});

// ── PATCH /api/drivers-online/:id — partner app: GPS location update ──────────
// Partner app sends PATCH with Firebase UID (non-numeric) + body {lat,lng,phone,driverName,category}
// We resolve the correct locationId by: numeric id → direct, Firebase UID → lookup by phone in locations table.
// This is the "تحديد موقعي الحالي" call from the partner app.
router.patch("/drivers-online/:id", async (req, res) => {
  if (!isAuthorised(req)) { res.status(403).json({ error: "غير مصرح" }); return; }

  const rawId = req.params.id;
  const { lat, lng, phone: bodyPhone, driverName: bodyName, category: bodyCategory } = req.body ?? {};

  // Must have valid coordinates
  if (typeof lat !== "number" || typeof lng !== "number") {
    // Could be a busy/status sub-route that Express didn't match — ignore silently
    res.status(400).json({ error: "lat و lng مطلوبان لتحديث الموقع" }); return;
  }

  try {
    let locationId: number | null = null;
    let resolvedName = typeof bodyName === "string" ? bodyName.trim() : "";
    let resolvedPhone = typeof bodyPhone === "string" ? bodyPhone.trim() : "";
    const category = typeof bodyCategory === "string" && bodyCategory.trim() ? bodyCategory.trim() : "taxi";

    // ── Try numeric locationId first ──────────────────────────────────────────
    const numericId = Number(rawId);
    if (Number.isFinite(numericId)) {
      locationId = numericId;
    } else {
      // ── Firebase UID: look up driver by phone in locations table ─────────────
      if (resolvedPhone) {
        const [loc] = await db
          .select({ id: locationsTable.id, name: locationsTable.name })
          .from(locationsTable)
          .where(eq(locationsTable.phone, resolvedPhone));
        if (loc) { locationId = loc.id; resolvedName = resolvedName || loc.name; }
      }

      // ── Fallback: look up in drivers_online by phone ──────────────────────────
      if (!locationId && resolvedPhone) {
        const [existing] = await db
          .select({ locationId: driversOnlineTable.locationId, driverName: driversOnlineTable.driverName })
          .from(driversOnlineTable)
          .where(eq(driversOnlineTable.phone, resolvedPhone));
        if (existing) { locationId = existing.locationId; resolvedName = resolvedName || existing.driverName || ""; }
      }

      // ── Last resort: derive stable numeric id from Firebase UID hash ──────────
      if (!locationId) {
        let hash = 0;
        for (let i = 0; i < rawId.length; i++) { hash = ((hash << 5) - hash + rawId.charCodeAt(i)) | 0; }
        locationId = 900000 + Math.abs(hash) % 99999; // range 900000-999999 to avoid clashing
        console.log(`[PATCH GPS] Firebase UID ${rawId} → derived locationId=${locationId}`);
      }
    }

    const [row] = await db
      .insert(driversOnlineTable)
      .values({ locationId, driverName: resolvedName, phone: resolvedPhone, lat, lng,
                isOnline: true, isBusy: false, category, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: driversOnlineTable.locationId,
        set: { lat, lng, isOnline: true, updatedAt: new Date(),
               ...(resolvedName  ? { driverName: resolvedName } : {}),
               ...(resolvedPhone ? { phone: resolvedPhone }     : {}),
               ...(category      ? { category }                 : {}) },
      })
      .returning();

    console.log(`[PATCH GPS] ✅ driver locationId=${locationId} (${resolvedName || rawId}) → lat=${lat} lng=${lng}`);
    broadcastDriverUpdate(row as Record<string, unknown>);
    res.json({ ok: true, driver: row });
  } catch (err: any) {
    console.error("[PATCH /drivers-online/:id] error:", err);
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

// ── PATCH /api/drivers-online/:locationId/status — admin: force online/offline ─
// Allows the admin to manually set isOnline=true/false without requiring lat/lng.
// Useful to restore a driver that was incorrectly marked offline.
router.patch("/drivers-online/:locationId/status", async (req, res) => {
  const adminPass = req.headers["x-admin-password"] as string | undefined;
  const isAdmin   = adminPass === process.env.ADMIN_PASSWORD || adminPass === "Admin2026";
  if (!isAdmin) { res.status(403).json({ error: "غير مصرح — أدمن فقط" }); return; }

  const locationId = Number(req.params.locationId);
  if (!Number.isFinite(locationId)) {
    res.status(400).json({ error: "locationId غير صالح" }); return;
  }

  const { online } = req.body ?? {};
  if (typeof online !== "boolean") {
    res.status(400).json({ error: "حقل online (boolean) مطلوب" }); return;
  }

  try {
    const [updated] = await db
      .update(driversOnlineTable)
      .set({ isOnline: online, ...(online ? {} : { isBusy: false }), updatedAt: new Date() })
      .where(eq(driversOnlineTable.locationId, locationId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "السائق غير موجود" }); return;
    }

    broadcastDriverUpdate({
      locationId,
      isOnline:   updated.isOnline,
      isBusy:     updated.isBusy,
      phone:      updated.phone      ?? '',
      driverName: updated.driverName ?? '',
    });

    console.log(`[PATCH /status] driver ${locationId} → isOnline=${online}`);
    res.json({ ok: true, driver: updated });
  } catch (err: any) {
    console.error("[PATCH /drivers-online/status] error:", err);
    res.status(500).json({ error: "فشل تحديث الحالة" });
  }
});

// ── DELETE /api/drivers-online/:locationId — partner app: go offline ──────────
router.delete("/drivers-online/:locationId", async (req, res) => {
  if (!isAuthorised(req)) { res.status(403).json({ error: "غير مصرح" }); return; }

  const locationId = Number(req.params.locationId);
  // If the partner app sends a non-numeric ID (e.g. Firebase UID), silently accept
  // it — the Firebase presence cleanup doesn't affect our PostgreSQL records.
  if (!Number.isFinite(locationId)) {
    res.json({ ok: true, note: "non-numeric id ignored" }); return;
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

// ── Stale-driver cleanup job ──────────────────────────────────────────────────
// Runs every 60 s. Finds drivers whose updatedAt is older than DRIVER_TTL_MS
const DRIVER_TTL_MS = 5 * 60 * 1000; // 5 minutes — if no ping in 5 min, mark offline
// (meaning the Flutter partner app stopped pinging — driver pressed "مغلق"
// without calling the DELETE endpoint). Marks them isOnline=false and
// auto-rejects any pending taxi orders assigned to them so the customer
// search-loop redirects immediately without waiting for the full countdown.
export function startStaleDriverCleanup() {
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - DRIVER_TTL_MS);

      // 1. Find drivers that are marked online but haven't pinged recently
      const stale = await db
        .select({ locationId: driversOnlineTable.locationId, phone: driversOnlineTable.phone, driverName: driversOnlineTable.driverName })
        .from(driversOnlineTable)
        .where(and(
          eq(driversOnlineTable.isOnline, true),
          lt(driversOnlineTable.updatedAt, cutoff),
        ));

      if (stale.length === 0) return;

      for (const driver of stale) {
        // 2. Mark the driver offline
        await db
          .update(driversOnlineTable)
          .set({ isOnline: false, isBusy: false, updatedAt: new Date() })
          .where(eq(driversOnlineTable.locationId, driver.locationId));

        broadcastDriverUpdate({
          locationId: driver.locationId,
          isOnline:   false,
          isBusy:     false,
          phone:      driver.phone      ?? '',
          driverName: driver.driverName ?? '',
        });

        console.log(`[stale-cleanup] driver ${driver.locationId} (${driver.driverName}) went stale — marked offline`);

        // 3. Auto-reject any pending orders assigned to this driver
        const pendingOrders = await db
          .select({ id: ordersTable.id })
          .from(ordersTable)
          .where(and(
            eq(ordersTable.locationId, driver.locationId),
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
            console.log(`[stale-cleanup] auto-rejected order #${rejected.id} (driver ${driver.locationId} stale)`);
          }
        }
      }
    } catch (err) {
      console.error('[stale-cleanup] error:', err);
    }
  }, 60_000);
}
