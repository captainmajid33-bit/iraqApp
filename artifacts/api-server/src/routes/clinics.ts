import { Router, type IRouter } from "express";
import { db, clinicsTable, insertClinicSchema } from "@workspace/db";

const router: IRouter = Router();

router.get("/locations", async (_req, res) => {
  try {
    const items = await db.select().from(clinicsTable).orderBy(clinicsTable.createdAt);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch locations" });
  }
});

router.post("/locations", async (req, res) => {
  try {
    const data = insertClinicSchema.parse(req.body);
    const [item] = await db.insert(clinicsTable).values(data).returning();
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

router.delete("/locations/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { eq } = await import("drizzle-orm");
    await db.delete(clinicsTable).where(eq(clinicsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete location" });
  }
});

export default router;
