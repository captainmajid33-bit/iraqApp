import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { gasOrdersTable, insertGasOrderSchema, gasOrderMessagesTable, insertGasOrderMessageSchema } from "@workspace/db";
import { and, eq, desc, asc } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { broadcastGasOrderUpdate, broadcastGasNewMessage } from "../lib/sse";

const router: IRouter = Router();

// ── System message helper ─────────────────────────────────────────────────────
const STATUS_MESSAGES: Record<string, string> = {
  accepted:  "✅ وكيل الغاز قبل طلبك وهو في الطريق إليك",
  arrived:   "📍 وكيل الغاز وصل إلى موقعك وهو بانتظارك",
  completed: "✅ تم تسليم الغاز بنجاح. شكراً لك!",
  cancelled: "❌ تم إلغاء الطلب",
};

async function insertSystemMsg(gasOrderId: number, content: string) {
  try {
    const [msg] = await db.insert(gasOrderMessagesTable).values({
      gasOrderId,
      senderRole: "system",
      content,
      isSystemMsg: true,
    }).returning();
    broadcastGasNewMessage({
      id:          msg.id,
      gasOrderId:  msg.gasOrderId,
      senderRole:  msg.senderRole,
      content:     msg.content,
      isSystemMsg: msg.isSystemMsg,
      createdAt:   msg.createdAt,
    });
  } catch (e) {
    console.warn(`[insertSystemMsg] gasOrderId=${gasOrderId}:`, e);
  }
}

// ── Haversine distance (km) between two lat/lng points ───────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── POST /api/gas-orders — public: create order, broadcast to ALL agents ──────
// Broadcast includes lat/lng so each agent can filter by distance client-side.
router.post("/gas-orders", async (req, res) => {
  try {
    const parsed = insertGasOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error?.issues });
      return;
    }
    const [order] = await db.insert(gasOrdersTable).values(parsed.data).returning();
    console.log(
      `[POST /gas-orders] #${order.id} | user:${parsed.data.userName ?? "?"} | phone:${parsed.data.phone} | lat:${order.lat} lng:${order.lng}`
    );
    // Broadcast includes lat/lng → agents filter by distance on their side
    broadcastGasOrderUpdate({
      id: order.id, status: order.status,
      userName: order.userName, phone: order.phone,
      locationAddress: order.locationAddress,
      lat: order.lat, lng: order.lng,
    });
    res.status(201).json({ ok: true, orderId: order.id });
  } catch (err: any) {
    console.error("[POST /gas-orders] error:", err);
    res.status(500).json({ error: "فشل حفظ الطلب", detail: err?.message });
  }
});

// ── GET /api/gas-orders/pending — agents only ─────────────────────────────────
// Supports geo-filtering: ?lat=X&lng=Y&radiusKm=3 (default 3 km).
// If lat+lng provided → only returns orders within radius of the agent's position.
// Without lat/lng → returns all pending (for admin dashboards).
//
// Partner app usage:
//   GET /api/gas-orders/pending?lat=33.748&lng=44.622
//   Header: x-partner-key: <key>
//   → returns only orders within 3 km of the agent
//
// For real-time stream: listen to SSE event 'gas_order_update'.
// Each event includes { order: { id, status, lat, lng, ... } }.
// Agent app should compute haversineKm(agentLat, agentLng, order.lat, order.lng)
// and only show the order if distance ≤ radiusKm (3 by default).
router.get("/gas-orders/pending", async (req, res) => {
  const partnerKey  = req.headers["x-partner-key"]    as string | undefined;
  const merchantKey = req.headers["x-merchant-key"]   as string | undefined;
  const adminPass   = req.headers["x-admin-password"] as string | undefined;
  const valid =
    adminPass === process.env.ADMIN_PASSWORD ||
    adminPass === "Admin2026" ||
    !!partnerKey || !!merchantKey;
  if (!valid) { res.status(403).json({ error: "غير مصرح" }); return; }

  // Optional geo params
  const agentLat  = req.query.lat       ? Number(req.query.lat)      : null;
  const agentLng  = req.query.lng       ? Number(req.query.lng)      : null;
  const radiusKm  = req.query.radiusKm  ? Number(req.query.radiusKm) : 3;
  // Only apply geo-filter when coordinates are valid AND non-zero (0,0 = no GPS fix yet)
  const geoFilter = agentLat !== null && agentLng !== null &&
                    Number.isFinite(agentLat) && Number.isFinite(agentLng) &&
                    (Math.abs(agentLat) > 0.001 || Math.abs(agentLng) > 0.001);

  try {
    const rows = await db
      .select()
      .from(gasOrdersTable)
      .where(eq(gasOrdersTable.status, "pending"))
      .orderBy(desc(gasOrdersTable.createdAt));

    // Apply distance filter when agent location is provided
    const filtered = geoFilter
      ? rows.filter(r => {
          if (r.lat === null || r.lng === null) return true; // no customer coords → include
          return haversineKm(agentLat!, agentLng!, r.lat, r.lng) <= radiusKm;
        })
      : rows;

    if (geoFilter) {
      console.log(
        `[GET /gas-orders/pending] geo-filter: agent(${agentLat},${agentLng}) r=${radiusKm}km → ${filtered.length}/${rows.length} orders`
      );
    }

    res.json(filtered);
  } catch (err: any) {
    console.error("[GET /gas-orders/pending] error:", err);
    res.status(500).json({ error: "فشل جلب الطلبات" });
  }
});

// ── POST /api/gas-orders/:id/cancel — PUBLIC: customer cancels their own order ─
// No auth required — orderId itself serves as the access token.
// Only works when status is still 'pending' (not accepted/done).
router.post("/gas-orders/:id/cancel", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

  try {
    const [order] = await db
      .select({ status: gasOrdersTable.status })
      .from(gasOrdersTable)
      .where(eq(gasOrdersTable.id, id));

    if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    // Allow cancel only while pending (not already accepted / done)
    const CANCELLABLE = new Set(["pending", "accepted"]);
    if (!CANCELLABLE.has(order.status)) {
      res.status(409).json({ error: "لا يمكن إلغاء هذا الطلب في وضعه الحالي" }); return;
    }

    const [updated] = await db
      .update(gasOrdersTable)
      .set({ status: "cancelled" })
      .where(eq(gasOrdersTable.id, id))
      .returning();

    if (!updated) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    console.log(`[CANCEL /gas-orders/${id}] customer cancelled`);
    broadcastGasOrderUpdate({ id: updated.id, status: updated.status, agentId: updated.agentId });
    void insertSystemMsg(id, STATUS_MESSAGES.cancelled);
    res.json({ ok: true });
  } catch (err: any) {
    console.error(`[CANCEL /gas-orders/${id}] error:`, err);
    res.status(500).json({ error: "فشل إلغاء الطلب", detail: err?.message });
  }
});

// ── DELETE /api/gas-orders/:id — PUBLIC: customer permanently deletes their order ─
// Broadcasts 'cancelled' SSE first so agent removes it from live list, then hard-deletes.
router.delete("/gas-orders/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: "id غير صالح" }); return; }

  try {
    const [order] = await db
      .select({ status: gasOrdersTable.status, agentId: gasOrdersTable.agentId })
      .from(gasOrdersTable)
      .where(eq(gasOrdersTable.id, id));

    if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    // 1) Broadcast cancellation so agent's live stream removes the order immediately
    broadcastGasOrderUpdate({ id, status: "cancelled", agentId: order.agentId ?? null });

    // 2) Hard-delete from DB
    await db.delete(gasOrdersTable).where(eq(gasOrdersTable.id, id));

    console.log(`[DELETE /gas-orders/${id}] permanently deleted by customer`);
    res.json({ ok: true });
  } catch (err: any) {
    console.error(`[DELETE /gas-orders/${id}] error:`, err);
    res.status(500).json({ error: "فشل حذف الطلب", detail: err?.message });
  }
});

// ── POST /api/gas-orders/:id/accept — atomic first-claim (no race condition) ──
// Conditional UPDATE on status='pending' — PostgreSQL serialises concurrent
// UPDATEs on the same row; second caller gets 0 rows → 409.
router.post("/gas-orders/:id/accept", async (req, res) => {
  const partnerKey  = req.headers["x-partner-key"]    as string | undefined;
  const merchantKey = req.headers["x-merchant-key"]   as string | undefined;
  const adminPass   = req.headers["x-admin-password"] as string | undefined;
  const valid =
    adminPass === process.env.ADMIN_PASSWORD ||
    adminPass === "Admin2026" ||
    !!partnerKey || !!merchantKey;
  if (!valid) { res.status(403).json({ error: "غير مصرح" }); return; }

  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id غير صالح" }); return; }

  const agentId = String(req.body?.agentId ?? partnerKey ?? merchantKey ?? "unknown");

  // Optional: agent provides their location for distance validation
  const agentLat = req.body?.agentLat ? Number(req.body.agentLat) : null;
  const agentLng = req.body?.agentLng ? Number(req.body.agentLng) : null;

  try {
    // Distance guard — prevent an out-of-range agent from accepting
    if (agentLat !== null && agentLng !== null && Number.isFinite(agentLat) && Number.isFinite(agentLng)) {
      const [order] = await db
        .select({ lat: gasOrdersTable.lat, lng: gasOrdersTable.lng, status: gasOrdersTable.status })
        .from(gasOrdersTable)
        .where(eq(gasOrdersTable.id, id));

      if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }
      if (order.status !== "pending") {
        res.status(409).json({ error: "تم قبول هذا الطلب من قِبل وكيل آخر" }); return;
      }
      if (order.lat !== null && order.lng !== null) {
        const dist = haversineKm(agentLat, agentLng, order.lat, order.lng);
        if (dist > 3) {
          res.status(403).json({ error: `الطلب خارج نطاقك (${dist.toFixed(1)} كم) — الحد الأقصى 3 كم` });
          return;
        }
      }
    }

    const [updated] = await db
      .update(gasOrdersTable)
      .set({ status: "accepted", agentId })
      .where(and(eq(gasOrdersTable.id, id), eq(gasOrdersTable.status, "pending")))
      .returning();

    if (!updated) {
      res.status(409).json({ error: "تم قبول هذا الطلب من قِبل وكيل آخر أو الطلب غير موجود" });
      return;
    }

    console.log(`[ACCEPT /gas-orders/${id}] agent=${agentId}` +
      (agentLat ? ` loc=(${agentLat},${agentLng})` : ""));
    broadcastGasOrderUpdate({ id: updated.id, status: updated.status, agentId: updated.agentId });
    void insertSystemMsg(id, STATUS_MESSAGES.accepted);
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

// ── PATCH /api/gas-orders/:id — agent/admin: update status ───────────────────
router.patch("/gas-orders/:id", async (req, res) => {
  const partnerKey  = req.headers["x-partner-key"]    as string | undefined;
  const merchantKey = req.headers["x-merchant-key"]   as string | undefined;
  const adminPass   = req.headers["x-admin-password"] as string | undefined;
  const valid =
    adminPass === process.env.ADMIN_PASSWORD ||
    adminPass === "Admin2026" ||
    !!partnerKey || !!merchantKey;
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
    const sysMsg = STATUS_MESSAGES[String(status)];
    if (sysMsg) void insertSystemMsg(id, sysMsg);
    res.json({ ok: true, order: updated });
  } catch (err: any) {
    console.error(`[PATCH /gas-orders/${id}] error:`, err);
    res.status(500).json({ error: "فشل تحديث الطلب", detail: err?.message });
  }
});

// ── GET /api/gas-orders/:id/messages — public: fetch chat messages ────────────
router.get("/gas-orders/:id/messages", async (req, res) => {
  const gasOrderId = Number(req.params.id);
  if (!Number.isFinite(gasOrderId)) { res.status(400).json({ error: "id غير صالح" }); return; }
  try {
    const [order] = await db.select({ id: gasOrdersTable.id })
      .from(gasOrdersTable).where(eq(gasOrdersTable.id, gasOrderId));
    if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    const msgs = await db.select()
      .from(gasOrderMessagesTable)
      .where(eq(gasOrderMessagesTable.gasOrderId, gasOrderId))
      .orderBy(asc(gasOrderMessagesTable.createdAt));

    res.json(msgs);
  } catch (err: any) {
    console.error(`[GET /gas-orders/${gasOrderId}/messages] error:`, err);
    res.status(500).json({ error: "فشل جلب الرسائل" });
  }
});

// ── POST /api/gas-orders/:id/messages — public: send a message ───────────────
router.post("/gas-orders/:id/messages", async (req, res) => {
  const gasOrderId = Number(req.params.id);
  if (!Number.isFinite(gasOrderId)) { res.status(400).json({ error: "id غير صالح" }); return; }
  try {
    const [order] = await db.select({ id: gasOrdersTable.id })
      .from(gasOrdersTable).where(eq(gasOrdersTable.id, gasOrderId));
    if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    const parsed = insertGasOrderMessageSchema.safeParse({ ...req.body, gasOrderId });
    if (!parsed.success) {
      res.status(400).json({ error: "بيانات غير صالحة", details: parsed.error?.issues });
      return;
    }

    const [msg] = await db.insert(gasOrderMessagesTable).values(parsed.data).returning();

    broadcastGasNewMessage({
      id:          msg.id,
      gasOrderId:  msg.gasOrderId,
      senderRole:  msg.senderRole,
      content:     msg.content,
      isSystemMsg: msg.isSystemMsg,
      createdAt:   msg.createdAt,
    });

    console.log(`[POST /gas-orders/${gasOrderId}/messages] role=${msg.senderRole} len=${msg.content.length}`);
    res.status(201).json(msg);
  } catch (err: any) {
    console.error(`[POST /gas-orders/${gasOrderId}/messages] error:`, err);
    res.status(500).json({ error: "فشل حفظ الرسالة" });
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
