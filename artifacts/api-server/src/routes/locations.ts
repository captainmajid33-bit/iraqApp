import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { locationsTable, insertLocationSchema } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAdmin, isValidAdminToken } from "./admin";
import { broadcastLocationUpdate } from "../lib/sse";

const router: IRouter = Router();

// Partner key — set via env var PARTNER_KEY, fallback to default
const PARTNER_KEY = process.env.PARTNER_KEY ?? "partner-diyala-2026";

// GET all locations (public)
router.get("/locations", async (req, res) => {
  try {
    const { category } = req.query;
    const items = await (category
      ? db.select().from(locationsTable).where(eq(locationsTable.category, String(category))).orderBy(asc(locationsTable.createdAt))
      : db.select().from(locationsTable).orderBy(asc(locationsTable.createdAt)));
    res.json(items);
  } catch {
    res.status(500).json({ error: "Failed to fetch locations" });
  }
});

// GET single location (public)
router.get("/locations/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [item] = await db.select().from(locationsTable).where(eq(locationsTable.id, id));
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch {
    res.status(500).json({ error: "Failed to fetch location" });
  }
});

// POST create — admin only
router.post("/locations", requireAdmin, async (req, res) => {
  try {
    const data = insertLocationSchema.parse(req.body);
    const [item] = await db.insert(locationsTable).values(data).returning();
    broadcastLocationUpdate(item as Record<string, unknown>);
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// PATCH update — accepts admin token (full update) OR partner key (status only)
router.patch("/locations/:id", async (req, res) => {
  const adminToken  = req.headers["x-admin-token"] as string | undefined;
  const partnerKey  = req.headers["x-partner-key"]  as string | undefined;
  const isAdmin     = isValidAdminToken(adminToken);
  const isPartner   = partnerKey === PARTNER_KEY;

  if (!isAdmin && !isPartner) {
    return res.status(401).json({ error: "Unauthorized — provide x-admin-token or x-partner-key" });
  }

  // Partners may only change the 'status' field
  if (isPartner && !isAdmin) {
    const allowed = new Set(["status"]);
    const keys = Object.keys(req.body ?? {});
    if (keys.length === 0 || !keys.every(k => allowed.has(k))) {
      return res.status(403).json({ error: "Partners can only update the 'status' field" });
    }
  }

  try {
    const id   = Number(req.params.id);
    const data = insertLocationSchema.partial().parse(req.body);
    const [item] = await db.update(locationsTable).set(data).where(eq(locationsTable.id, id)).returning();
    if (!item) return res.status(404).json({ error: "Not found" });
    // Broadcast real-time update to all connected map clients
    broadcastLocationUpdate(item as Record<string, unknown>);
    res.json(item);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// DELETE — admin only
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

export default router;
