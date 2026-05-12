import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { locationsTable, insertLocationSchema } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

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
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// PATCH update — admin only
router.patch("/locations/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = insertLocationSchema.partial().parse(req.body);
    const [item] = await db.update(locationsTable).set(data).where(eq(locationsTable.id, id)).returning();
    if (!item) return res.status(404).json({ error: "Not found" });
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
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete location" });
  }
});

export default router;
