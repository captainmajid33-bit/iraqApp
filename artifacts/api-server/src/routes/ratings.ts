import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { taxiRatingsTable, insertTaxiRatingSchema, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

// ── POST /api/taxi-ratings — submit a ride rating ────────────────────────────
router.post("/taxi-ratings", async (req, res) => {
  try {
    const parsed = insertTaxiRatingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error?.issues });
      return;
    }

    // Verify order exists
    const [order] = await db
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.id, parsed.data.orderId));

    if (!order) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }

    const [rating] = await db.insert(taxiRatingsTable).values(parsed.data).returning();
    res.status(201).json(rating);
  } catch (err: any) {
    console.error("[POST /taxi-ratings] error:", err);
    res.status(500).json({ error: "فشل حفظ التقييم" });
  }
});

// ── GET /api/taxi-ratings — fetch all (admin) or by driver ───────────────────
// • No query param  → returns ALL ratings (admin overview, newest first)
// • ?driverId=X     → returns ratings for a specific driver
router.get("/taxi-ratings", async (req, res) => {
  try {
    const { desc: descOp } = await import("drizzle-orm");
    let rows;
    if (req.query.driverId !== undefined) {
      const driverId = Number(req.query.driverId);
      if (!Number.isFinite(driverId)) {
        res.status(400).json({ error: "driverId غير صالح" });
        return;
      }
      rows = await db
        .select()
        .from(taxiRatingsTable)
        .where(eq(taxiRatingsTable.driverId, driverId))
        .orderBy(descOp(taxiRatingsTable.createdAt));
    } else {
      rows = await db
        .select()
        .from(taxiRatingsTable)
        .orderBy(descOp(taxiRatingsTable.createdAt));
    }
    res.json(rows);
  } catch (err: any) {
    console.error("[GET /taxi-ratings] error:", err);
    res.status(500).json({ error: "فشل جلب التقييمات" });
  }
});

export default router;
