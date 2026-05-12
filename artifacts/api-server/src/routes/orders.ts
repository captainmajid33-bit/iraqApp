import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { ordersTable, insertOrderSchema, locationsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

// ── POST /api/orders — public, anyone can place a taxi order ─────────────────
router.post("/orders", async (req, res) => {
  try {
    const parsed = insertOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error?.issues });
      return;
    }
    const { locationId, phone, destination, lat, lng } = parsed.data;

    // Verify the location exists and is a taxi/transport category
    const [loc] = await db
      .select({ id: locationsTable.id, category: locationsTable.category, name: locationsTable.name, status: locationsTable.status })
      .from(locationsTable)
      .where(eq(locationsTable.id, locationId));

    if (!loc) {
      res.status(404).json({ error: "لم يتم العثور على السائق" });
      return;
    }
    if (loc.status === "معطّل") {
      res.status(409).json({ error: "هذا السائق غير متاح حالياً" });
      return;
    }

    const [order] = await db
      .insert(ordersTable)
      .values({ locationId, phone, destination, lat: lat ?? null, lng: lng ?? null })
      .returning();

    console.log(`[POST /orders] new order #${order.id} → location ${locationId} (${loc.name}) | phone: ${phone} | dest: ${destination}`);
    res.status(201).json({ ok: true, orderId: order.id, status: order.status });
  } catch (err: any) {
    console.error("[POST /orders] error:", err);
    res.status(500).json({ error: "فشل حفظ الطلب", detail: err?.message });
  }
});

// ── GET /api/orders — admin only, list all orders ────────────────────────────
router.get("/orders", requireAdmin, async (req, res) => {
  try {
    const locationId = req.query.locationId ? Number(req.query.locationId) : null;
    const rows = locationId
      ? await db.select().from(ordersTable).where(eq(ordersTable.locationId, locationId)).orderBy(desc(ordersTable.createdAt))
      : await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));
    res.json(rows);
  } catch (err: any) {
    console.error("[GET /orders] error:", err);
    res.status(500).json({ error: "فشل جلب الطلبات" });
  }
});

// ── PATCH /api/orders/:id — admin only, update status ───────────────────────
router.patch("/orders/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    if (!status) { res.status(400).json({ error: "status field required" }); return; }
    const [updated] = await db
      .update(ordersTable)
      .set({ status: String(status) })
      .where(eq(ordersTable.id, id))
      .returning();
    if (!updated) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
    res.json({ ok: true, order: updated });
  } catch (err: any) {
    console.error("[PATCH /orders/:id] error:", err);
    res.status(500).json({ error: "فشل تحديث الطلب" });
  }
});

export default router;
