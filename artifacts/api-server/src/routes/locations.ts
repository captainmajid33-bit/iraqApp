import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { locationsTable, insertLocationSchema, driversOnlineTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAdmin, isValidAdminToken } from "./admin";
import { broadcastLocationUpdate, broadcastDriverUpdate } from "../lib/sse";

const router: IRouter = Router();

// ── Auth constants ─────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin2026";
const PARTNER_KEY    = process.env.PARTNER_KEY    ?? "partner-diyala-2026";

// ── Helper: strip merchantKey before sending to clients ───────────────────────
function safe(row: any): Record<string, unknown> {
  if (!row) return row;
  const { merchantKey: _a, merchant_key: _b, ...rest } = row;
  return rest;
}

// ── GET all locations (public — merchantKey excluded) ─────────────────────────
router.get("/locations", async (req, res) => {
  try {
    const { category } = req.query;
    const items = category
      ? await db.select().from(locationsTable)
          .where(eq(locationsTable.category, String(category)))
          .orderBy(asc(locationsTable.createdAt))
      : await db.select().from(locationsTable)
          .orderBy(asc(locationsTable.createdAt));
    res.json(items.map(safe));
  } catch (err) {
    console.error("[GET /locations] DB error:", err);
    res.status(500).json({ error: "Failed to fetch locations" });
  }
});

// ── GET single location (public — merchantKey excluded) ───────────────────────
router.get("/locations/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [item] = await db.select().from(locationsTable).where(eq(locationsTable.id, id));
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    res.json(safe(item));
  } catch (err) {
    console.error("[GET /locations/:id] DB error:", err);
    res.status(500).json({ error: "Failed to fetch location" });
  }
});

// ── POST create — admin only ───────────────────────────────────────────────────
router.post("/locations", requireAdmin, async (req, res) => {
  try {
    const data = insertLocationSchema.parse(req.body);
    const [item] = await db.insert(locationsTable).values(data).returning();
    broadcastLocationUpdate(safe(item));
    res.status(201).json(safe(item));
  } catch (err: any) {
    console.error("[POST /locations] error:", err);
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// ── PATCH /api/locations (no ID) — partner hub sends empty ID gracefully ───────
// The partner hub sometimes sends PATCH /api/locations/ (trailing slash, no ID)
// because it doesn't know its integer locationId. Return 200 silently so the
// partner app doesn't treat it as a fatal error.
router.patch("/locations", (req, res) => {
  console.warn("[PATCH /locations no-id] body:", JSON.stringify(req.body ?? {}).slice(0, 120));
  res.json({ ok: true, note: "no locationId — ignored" });
});

// ── PATCH update ───────────────────────────────────────────────────────────────
// Auth priority (stateless — survives server restarts):
//   1. x-admin-password == ADMIN_PASSWORD              → full update
//   2. x-admin-token    (session token)                → full update
//   3. x-partner-key OR Authorization: Bearer <key>   → status only
//   4. x-merchant-key OR Authorization: Bearer <key>  → status only (per-location)
router.patch("/locations/:id", async (req, res) => {
  const adminPassword = (req.headers["x-admin-password"] as string | undefined) ?? "";
  const adminToken    = (req.headers["x-admin-token"]    as string | undefined) ?? "";
  // Support both x-partner-key and Authorization: Bearer <key>
  const authBearer    = ((req.headers["authorization"] as string | undefined) ?? "")
                          .replace(/^Bearer\s+/i, "").trim();
  const partnerKey    = (req.headers["x-partner-key"]  as string | undefined) || authBearer || "";
  const merchantKey   = (req.headers["x-merchant-key"] as string | undefined) || authBearer || "";

  // ── Determine identity ──────────────────────────────────────────────────────
  const isAdmin   = (adminPassword === ADMIN_PASSWORD) || isValidAdminToken(adminToken);
  const isPartner = !isAdmin && (partnerKey === PARTNER_KEY);

  // Per-location merchant key check
  let isMerchant = false;
  if (!isAdmin && !isPartner && merchantKey) {
    try {
      const locId = Number(req.params.id);
      if (!isNaN(locId)) {
        const [loc] = await db
          .select({ mKey: locationsTable.merchantKey })
          .from(locationsTable)
          .where(eq(locationsTable.id, locId));
        if (loc?.mKey && loc.mKey === merchantKey) {
          isMerchant = true;
        }
      }
    } catch (err) {
      console.error("[PATCH] merchant-key DB lookup error:", err);
    }
  }

  // ── Reject if no valid auth — log ALL headers to help diagnose ─────────────
  if (!isAdmin && !isPartner && !isMerchant) {
    const relevantHeaders = {
      "x-admin-password" : req.headers["x-admin-password"],
      "x-admin-token"    : req.headers["x-admin-token"],
      "x-partner-key"    : req.headers["x-partner-key"],
      "x-merchant-key"   : req.headers["x-merchant-key"],
      "authorization"    : req.headers["authorization"],
      "origin"           : req.headers["origin"],
    };
    const why =
      adminPassword ? `wrong admin password` :
      adminToken    ? "expired/invalid admin token — please re-login" :
      partnerKey    ? `wrong partner key (got: "${partnerKey.slice(0,8)}...")` :
      merchantKey   ? "merchant key does not match this location" :
      "no auth header provided";
    console.warn(
      `[PATCH /locations/${req.params.id}] 401 — ${why}`,
      "\nHeaders received:", JSON.stringify(relevantHeaders),
    );
    res.status(401).json({
      error: "Unauthorized",
      hint: why,
    });
    return;
  }

  // ── Non-admins: status field only ──────────────────────────────────────────
  if (!isAdmin) {
    const keys = Object.keys(req.body ?? {});
    if (keys.length === 0 || !keys.every(k => k === "status")) {
      console.warn(`[PATCH /locations/${req.params.id}] 403 — non-admin tried to change: ${keys.join(", ")}`);
      res.status(403).json({ error: "يمكن تعديل حقل 'status' فقط" });
      return;
    }
  }

  // ── Apply update ────────────────────────────────────────────────────────────
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid location ID" }); return; }

    let data: Record<string, unknown>;
    if (isAdmin) {
      // Full update — parse with partial schema (all fields optional)
      // Use loose schema to accept Arabic status values without strict enum checks
      const parsed = insertLocationSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        const msg = parsed.error?.message ?? "Validation error";
        console.error(`[PATCH /locations/${id}] Zod validation failed:`, parsed.error);
        res.status(400).json({ error: msg, details: parsed.error?.issues });
        return;
      }
      data = parsed.data as Record<string, unknown>;
    } else {
      // Non-admin: only status — bypass schema, accept any string value
      const status = String(req.body?.status ?? "").trim();
      if (!status) { res.status(400).json({ error: "status field is required" }); return; }
      data = { status };
    }

    console.log(`[PATCH /locations/${id}] updating with:`, data, `| auth: ${isAdmin ? "ADMIN" : isPartner ? "PARTNER" : "MERCHANT"}`);

    const [updated] = await db
      .update(locationsTable)
      .set(data)
      .where(eq(locationsTable.id, id))
      .returning();

    if (!updated) {
      console.warn(`[PATCH /locations/${id}] location not found in DB`);
      res.status(404).json({ error: "Location not found" });
      return;
    }

    console.log(`[PATCH /locations/${id}] success — new status: ${updated.status}`);
    const out = safe(updated);
    broadcastLocationUpdate(out);

    // ── Auto-offline: if location is now closed, force driver offline too ──────
    // Prevents closed drivers from appearing in customer taxi search
    const isClosed = updated.status === 'مغلق' || updated.status === 'closed';
    if (isClosed) {
      try {
        const [driverRow] = await db
          .update(driversOnlineTable)
          .set({ isOnline: false, isBusy: false, updatedAt: new Date() })
          .where(eq(driversOnlineTable.locationId, id))
          .returning();
        if (driverRow) {
          broadcastDriverUpdate({ locationId: id, isOnline: false, isBusy: false });
          console.log(`[PATCH /locations/${id}] auto-offline driver (location closed)`);
        }
      } catch (e: any) {
        // Non-fatal — location update already succeeded
        console.warn(`[PATCH /locations/${id}] auto-offline driver failed:`, e?.message);
      }
    }

    // Return the location directly (same shape as POST) so r.id is always available
    res.status(200).json(out);

  } catch (err: any) {
    console.error(`[PATCH /locations/${req.params.id}] DB update error:`, err);
    res.status(500).json({ error: "Database update failed", detail: err?.message ?? String(err) });
  }
});

// ── DELETE — admin only ────────────────────────────────────────────────────────
router.delete("/locations/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.delete(locationsTable).where(eq(locationsTable.id, id));
    broadcastLocationUpdate({ id, _deleted: true });
    res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /locations/:id] error:", err);
    res.status(500).json({ error: "Failed to delete location" });
  }
});

// ── GET /api/admin/locations/:id/merchant-key ─────────────────────────────────
router.get("/admin/locations/:id/merchant-key", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [loc] = await db
      .select({ id: locationsTable.id, name: locationsTable.name, merchantKey: locationsTable.merchantKey })
      .from(locationsTable).where(eq(locationsTable.id, id));
    if (!loc) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ id: loc.id, name: loc.name, merchantKey: loc.merchantKey ?? null });
  } catch (err) {
    console.error("[GET merchant-key] error:", err);
    res.status(500).json({ error: "Failed to fetch merchant key" });
  }
});

// ── POST /api/admin/locations/:id/merchant-key — generate or set ──────────────
router.post("/admin/locations/:id/merchant-key", requireAdmin, async (req, res) => {
  try {
    const id     = Number(req.params.id);
    const newKey = (req.body?.key && String(req.body.key).trim())
      ? String(req.body.key).trim()
      : randomBytes(16).toString("hex");

    const [item] = await db
      .update(locationsTable)
      .set({ merchantKey: newKey })
      .where(eq(locationsTable.id, id))
      .returning({ id: locationsTable.id, name: locationsTable.name, merchantKey: locationsTable.merchantKey });
    if (!item) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ok: true, id: item.id, name: item.name, merchantKey: item.merchantKey });
  } catch (err) {
    console.error("[POST merchant-key] error:", err);
    res.status(500).json({ error: "Failed to set merchant key" });
  }
});

// ── DELETE /api/admin/locations/:id/merchant-key — revoke ────────────────────
router.delete("/admin/locations/:id/merchant-key", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.update(locationsTable).set({ merchantKey: null }).where(eq(locationsTable.id, id));
    res.json({ ok: true, merchantKey: null });
  } catch (err) {
    console.error("[DELETE merchant-key] error:", err);
    res.status(500).json({ error: "Failed to revoke merchant key" });
  }
});

export default router;
