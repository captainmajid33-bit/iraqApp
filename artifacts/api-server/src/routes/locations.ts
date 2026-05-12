import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { locationsTable, insertLocationSchema } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAdmin, isValidAdminToken } from "./admin";
import { broadcastLocationUpdate } from "../lib/sse";

const router: IRouter = Router();

// Global partner key (legacy / partner-app fallback)
const PARTNER_KEY = process.env.PARTNER_KEY ?? "partner-diyala-2026";

// ── Helper: strip merchantKey before sending to clients ───────────────────────
function safe(item: Record<string, unknown>) {
  const { merchantKey: _mk, merchant_key: _mk2, ...rest } = item as any;
  return rest;
}

// ── GET all locations (public — merchantKey excluded) ─────────────────────────
router.get("/locations", async (req, res) => {
  try {
    const { category } = req.query;
    const items = await (category
      ? db.select().from(locationsTable)
          .where(eq(locationsTable.category, String(category)))
          .orderBy(asc(locationsTable.createdAt))
      : db.select().from(locationsTable)
          .orderBy(asc(locationsTable.createdAt)));
    res.json(items.map(safe));
  } catch {
    res.status(500).json({ error: "Failed to fetch locations" });
  }
});

// ── GET single location (public — merchantKey excluded) ───────────────────────
router.get("/locations/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [item] = await db.select().from(locationsTable).where(eq(locationsTable.id, id));
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(safe(item as any));
  } catch {
    res.status(500).json({ error: "Failed to fetch location" });
  }
});

// ── POST create — admin only ───────────────────────────────────────────────────
router.post("/locations", requireAdmin, async (req, res) => {
  try {
    const data = insertLocationSchema.parse(req.body);
    const [item] = await db.insert(locationsTable).values(data).returning();
    broadcastLocationUpdate(safe(item as any));
    res.status(201).json(safe(item as any));
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// ── PATCH update — three auth paths ───────────────────────────────────────────
//   1. Admin token  → full field update
//   2. Global partner key (x-partner-key) → status only (backward compat)
//   3. Per-merchant key (x-merchant-key)  → status only for that specific location
router.patch("/locations/:id", async (req, res) => {
  const adminToken  = req.headers["x-admin-token"]  as string | undefined;
  const partnerKey  = req.headers["x-partner-key"]  as string | undefined;
  const merchantKey = req.headers["x-merchant-key"] as string | undefined;

  const isAdmin   = isValidAdminToken(adminToken);
  const isPartner = !isAdmin && (partnerKey === PARTNER_KEY);

  // Per-merchant check: x-merchant-key must match the stored key for THIS location
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
    } catch { /* DB error → stay unauthorized */ }
  }

  if (!isAdmin && !isPartner && !isMerchant) {
    return res.status(401).json({
      error: "Unauthorized — provide x-admin-token, x-partner-key, or x-merchant-key",
    });
  }

  // Non-admins may ONLY change 'status'
  if (!isAdmin) {
    const keys = Object.keys(req.body ?? {});
    if (keys.length === 0 || !keys.every(k => k === "status")) {
      return res.status(403).json({ error: "يمكن تعديل حقل 'status' فقط" });
    }
  }

  try {
    const id = Number(req.params.id);
    const data = isAdmin
      ? insertLocationSchema.partial().parse(req.body)
      : { status: String(req.body.status) };

    const [item] = await db
      .update(locationsTable).set(data)
      .where(eq(locationsTable.id, id)).returning();
    if (!item) return res.status(404).json({ error: "Not found" });

    const out = safe(item as any);
    broadcastLocationUpdate(out);
    res.status(200).json({ success: true, location: out });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// ── DELETE — admin only ────────────────────────────────────────────────────────
router.delete("/locations/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.delete(locationsTable).where(eq(locationsTable.id, id));
    broadcastLocationUpdate({ id, _deleted: true });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete location" });
  }
});

// ── GET /api/admin/locations/:id/merchant-key — view key (admin only) ─────────
router.get("/admin/locations/:id/merchant-key", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [loc] = await db
      .select({ id: locationsTable.id, name: locationsTable.name, merchantKey: locationsTable.merchantKey })
      .from(locationsTable).where(eq(locationsTable.id, id));
    if (!loc) return res.status(404).json({ error: "Not found" });
    res.json({ id: loc.id, name: loc.name, merchantKey: loc.merchantKey ?? null });
  } catch {
    res.status(500).json({ error: "Failed to fetch merchant key" });
  }
});

// ── POST /api/admin/locations/:id/merchant-key — generate or set key ──────────
router.post("/admin/locations/:id/merchant-key", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    // Use provided key or generate a secure random one
    const newKey: string = (req.body?.key && String(req.body.key).trim())
      ? String(req.body.key).trim()
      : randomBytes(16).toString("hex");

    const [item] = await db
      .update(locationsTable).set({ merchantKey: newKey })
      .where(eq(locationsTable.id, id)).returning({ id: locationsTable.id, name: locationsTable.name, merchantKey: locationsTable.merchantKey });
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true, id: item.id, name: item.name, merchantKey: item.merchantKey });
  } catch {
    res.status(500).json({ error: "Failed to set merchant key" });
  }
});

// ── DELETE /api/admin/locations/:id/merchant-key — revoke key ─────────────────
router.delete("/admin/locations/:id/merchant-key", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.update(locationsTable).set({ merchantKey: null }).where(eq(locationsTable.id, id));
    res.json({ ok: true, merchantKey: null });
  } catch {
    res.status(500).json({ error: "Failed to revoke merchant key" });
  }
});

export default router;
