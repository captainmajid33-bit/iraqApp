import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { messagesTable, ordersTable, insertMessageSchema } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { broadcastNewMessage } from "../lib/sse";

const router: IRouter = Router();

// ── GET /api/orders/:id/messages — public ────────────────────────────────────
router.get("/orders/:id/messages", async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isFinite(orderId)) { res.status(400).json({ error: "id غير صالح" }); return; }

    // Verify order exists
    const [order] = await db.select({ id: ordersTable.id }).from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    const msgs = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.orderId, orderId))
      .orderBy(asc(messagesTable.createdAt));

    res.json(msgs);
  } catch (err: any) {
    console.error("[GET /orders/:id/messages] error:", err);
    res.status(500).json({ error: "فشل جلب الرسائل" });
  }
});

// ── POST /api/orders/:id/messages — public (customer or driver) ──────────────
router.post("/orders/:id/messages", async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isFinite(orderId)) { res.status(400).json({ error: "id غير صالح" }); return; }

    const parsed = insertMessageSchema.safeParse({ ...req.body, orderId });
    if (!parsed.success) {
      res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error?.issues });
      return;
    }

    const [msg] = await db.insert(messagesTable).values(parsed.data).returning();

    broadcastNewMessage({
      id:         msg.id,
      orderId:    msg.orderId,
      senderRole: msg.senderRole,
      content:    msg.content,
      createdAt:  msg.createdAt,
    });

    res.status(201).json(msg);
  } catch (err: any) {
    console.error("[POST /orders/:id/messages] error:", err);
    res.status(500).json({ error: "فشل حفظ الرسالة" });
  }
});

export default router;
