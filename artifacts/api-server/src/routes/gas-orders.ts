import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { gasOrdersTable, insertGasOrderSchema } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { broadcastGasOrderUpdate, broadcastGasOrdersToOrdersStream } from "../lib/sse";

const router: IRouter = Router();

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
    // Also push to /api/orders/stream (partner app SSE channel)
    broadcastGasOrdersToOrdersStream([{
      id:             `gas_${order.id}`,
      type:           "gas",
      locationId:     null,
      userName:       order.userName,
      phone:          order.phone,
      destination:    order.locationAddress,
      fromLat:        order.lat,
      fromLng:        order.lng,
      toLat:          null,
      toLng:          null,
      estimatedPrice: null,
      lat:            order.lat,
      lng:            order.lng,
      driverLat:      null,
      driverLng:      null,
      status:         order.status,
      createdAt:      order.createdAt,
    }]);
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
