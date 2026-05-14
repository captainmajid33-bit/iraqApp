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

// ── GET /api/taxi-ratings?driverId=X — fetch ratings for a driver ────────────
router.get("/taxi-ratings", async (req, res) => {
  try {
    const driverId = Number(req.query.driverId);
    if (!Number.isFinite(driverId)) {
      res.status(400).json({ error: "driverId مطلوب" });
      return;
    }
    const ratings = await db
      .select()
      .from(taxiRatingsTable)
      .where(eq(taxiRatingsTable.driverId, driverId));
    res.json(ratings);
  } catch (err: any) {
    console.error("[GET /taxi-ratings] error:", err);
    res.status(500).json({ error: "فشل جلب التقييمات" });
  }
});

export default router;
