import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { locationsTable, insertLocationSchema } from "@workspace/db";
import { eq, asc } from "drizzle-orm";

const router: IRouter = Router();

// GET all locations (optionally filter by category)
router.get("/locations", async (req, res) => {
  try {
    const { category } = req.query;
    let query = db.select().from(locationsTable).orderBy(asc(locationsTable.createdAt));
    const items = await (category
      ? db.select().from(locationsTable).where(eq(locationsTable.category, String(category))).orderBy(asc(locationsTable.createdAt))
      : query);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch locations" });
  }
});

// GET single location
router.get("/locations/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [item] = await db.select().from(locationsTable).where(eq(locationsTable.id, id));
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch location" });
  }
});

// POST create location
router.post("/locations", async (req, res) => {
  try {
    const data = insertLocationSchema.parse(req.body);
    const [item] = await db.insert(locationsTable).values(data).returning();
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// PATCH update location
router.patch("/locations/:id", async (req, res) => {
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

// DELETE location
router.delete("/locations/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.delete(locationsTable).where(eq(locationsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete location" });
  }
});

export default router;
