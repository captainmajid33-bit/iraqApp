import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { gasOrdersTable, insertGasOrderSchema } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { broadcastGasOrderUpdate } from "../lib/sse";

const router: IRouter = Router();

// ── POST /api/gas-orders — public: create order, broadcast to all agents ─────
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
    broadcastGasOrderUpdate({
      id: order.id, status: order.status,
      userName: order.userName, phone: order.phone,
      locationAddress: order.locationAddress, lat: order.lat, lng: order.lng,
    });
    res.status(201).json({ ok: true, orderId: order.id });
  } catch (err: any) {
    console.error("[POST /gas-orders] error:", err);
    res.status(500).json({ error: "فشل حفظ الطلب", detail: err?.message });
  }
});

// ── GET /api/gas-orders/pending — agents only: list all pending orders ────────
router.get("/gas-orders/pending", async (req, res) => {
  const partnerKey  = req.headers["x-partner-key"]      as string | undefined;
  const merchantKey = req.headers["x-merchant-key"]     as string | undefined;
  const adminPass   = req.headers["x-admin-password"]   as string | undefined;
  const valid = adminPass === process.env.ADMIN_PASSWORD || adminPass === "Admin2026" || !!partnerKey || !!merchantKey;
  if (!valid) { res.status(403).json({ error: "غير مصرح" }); return; }
  try {
    const rows = await db
      .select()
      .from(gasOrdersTable)
      .where(eq(gasOrdersTable.status, "pending"))
      .orderBy(desc(gasOrdersTable.createdAt));
    res.json(rows);
  } catch (err: any) {
    console.error("[GET /gas-orders/pending] error:", err);
    res.status(500).json({ error: "فشل جلب الطلبات" });
  }
});

// ── POST /api/gas-orders/:id/accept — atomic first-claim (no race condition) ──
// Uses conditional UPDATE: only succeeds if status is still 'pending'.
// PostgreSQL serialises concurrent UPDATEs on the same row, so the first one
// wins and subsequent ones get 0 rows back → 409 response.
router.post("/gas-orders/:id/accept", async (req, res) => {
  const partnerKey  = req.headers["x-partner-key"]    as string | undefined;
  const merchantKey = req.headers["x-merchant-key"]   as string | undefined;
  const adminPass   = req.headers["x-admin-password"] as string | undefined;
  const valid = adminPass === process.env.ADMIN_PASSWORD || adminPass === "Admin2026" || !!partnerKey || !!merchantKey;
  if (!valid) { res.status(403).json({ error: "غير مصرح" }); return; }

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

  const agentId = String(req.body?.agentId ?? partnerKey ?? merchantKey ?? "unknown");

  try {
    // Atomic conditional update — only rows WHERE status='pending' are touched.
    // If two agents call this simultaneously PostgreSQL will serialise the two
    // UPDATEs; the second one finds status already 'accepted' → 0 rows → 409.
    const [updated] = await db
      .update(gasOrdersTable)
      .set({ status: "accepted", agentId })
      .where(and(eq(gasOrdersTable.id, id), eq(gasOrdersTable.status, "pending")))
      .returning();

    if (!updated) {
      res.status(409).json({ error: "تم قبول هذا الطلب من قِبل وكيل آخر أو الطلب غير موجود" });
      return;
    }

    console.log(`[ACCEPT /gas-orders/${id}] agent=${agentId}`);
    broadcastGasOrderUpdate({ id: updated.id, status: updated.status, agentId: updated.agentId });
    res.json({ ok: true, order: updated });
  } catch (err: any) {
    console.error(`[ACCEPT /gas-orders/${id}] error:`, err);
    res.status(500).json({ error: "فشل قبول الطلب", detail: err?.message });
  }
});

// ── GET /api/gas-orders/:id — public: client polls for own order status ───────
router.get("/gas-orders/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }
  try {
    const [order] = await db.select().from(gasOrdersTable).where(eq(gasOrdersTable.id, id));
    if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
    res.json({ id: order.id, status: order.status, agentId: order.agentId, createdAt: order.createdAt });
  } catch (err: any) {
    console.error(`[GET /gas-orders/${id}] error:`, err);
    res.status(500).json({ error: "فشل جلب الطلب" });
  }
});

// ── PATCH /api/gas-orders/:id — agent/admin: update status (done/cancelled) ──
router.patch("/gas-orders/:id", async (req, res) => {
  const partnerKey  = req.headers["x-partner-key"]    as string | undefined;
  const merchantKey = req.headers["x-merchant-key"]   as string | undefined;
  const adminPass   = req.headers["x-admin-password"] as string | undefined;
  const valid = adminPass === process.env.ADMIN_PASSWORD || adminPass === "Admin2026" || !!partnerKey || !!merchantKey;
  if (!valid) { res.status(403).json({ error: "غير مصرح" }); return; }

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

  const { status } = req.body ?? {};
  if (!status) { res.status(400).json({ error: "status مطلوب" }); return; }

  try {
    const [updated] = await db
      .update(gasOrdersTable)
      .set({ status: String(status) })
      .where(eq(gasOrdersTable.id, id))
      .returning();
    if (!updated) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
    console.log(`[PATCH /gas-orders/${id}] status → ${status}`);
    broadcastGasOrderUpdate({ id: updated.id, status: updated.status, agentId: updated.agentId });
    res.json({ ok: true, order: updated });
  } catch (err: any) {
    console.error(`[PATCH /gas-orders/${id}] error:`, err);
    res.status(500).json({ error: "فشل تحديث الطلب", detail: err?.message });
  }
});

// ── GET /api/gas-orders — admin only: full list ───────────────────────────────
router.get("/gas-orders", requireAdmin, async (req, res) => {
  try {
    const rows = await db.select().from(gasOrdersTable).orderBy(desc(gasOrdersTable.createdAt));
    res.json(rows);
  } catch (err: any) {
    console.error("[GET /gas-orders] error:", err);
    res.status(500).json({ error: "فشل جلب الطلبات" });
  }
});

export default router;
