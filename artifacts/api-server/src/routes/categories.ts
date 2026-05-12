import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { categoriesTable, insertCategorySchema } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

// GET all (public)
router.get("/categories", async (_req, res) => {
  try {
    const cats = await db.select().from(categoriesTable).orderBy(asc(categoriesTable.id));
    res.json(cats);
  } catch {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// POST — admin only
router.post("/categories", requireAdmin, async (req, res) => {
  try {
    const data = insertCategorySchema.parse(req.body);
    const [cat] = await db.insert(categoriesTable).values(data).returning();
    res.status(201).json(cat);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// PATCH — admin only
router.patch("/categories/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = insertCategorySchema.partial().parse(req.body);
    const [cat] = await db.update(categoriesTable).set(data).where(eq(categoriesTable.id, id)).returning();
    if (!cat) return res.status(404).json({ error: "Not found" });
    res.json(cat);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// DELETE — admin only
router.delete("/categories/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.delete(categoriesTable).where(eq(categoriesTable.id, id));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete category" });
  }
});

export default router;
