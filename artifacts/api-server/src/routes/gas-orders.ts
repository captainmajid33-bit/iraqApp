import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { gasOrdersTable, insertGasOrderSchema } from "@workspace/db";
import { desc } from "drizzle-orm";
import { requireAdmin } from "./admin";

const router: IRouter = Router();

router.post("/gas-orders", async (req, res) => {
  try {
    const parsed = insertGasOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error?.issues });
      return;
    }
    const [order] = await db.insert(gasOrdersTable).values(parsed.data).returning();
    console.log(
      `[POST /gas-orders] #${order.id} | user:${parsed.data.userName ?? "?"} | phone:${parsed.data.phone} | loc:${parsed.data.locationAddress ?? "?"}`
    );
    res.status(201).json({ ok: true, orderId: order.id });
  } catch (err: any) {
    console.error("[POST /gas-orders] error:", err);
    res.status(500).json({ error: "فشل حفظ الطلب", detail: err?.message });
  }
});

router.get("/gas-orders", requireAdmin, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(gasOrdersTable)
      .orderBy(desc(gasOrdersTable.createdAt));
    res.json(rows);
  } catch (err: any) {
    console.error("[GET /gas-orders] error:", err);
    res.status(500).json({ error: "فشل جلب الطلبات" });
  }
});

export default router;
