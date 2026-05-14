import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { messagesTable, ordersTable, insertMessageSchema } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { broadcastNewMessage } from "../lib/sse";

const router: IRouter = Router();

// ── Partner hub bridge ────────────────────────────────────────────────────────
// The partner hub (diyala-partner-hub.replit.app) uses a separate database.
// This bridge keeps both sides in sync:
//   • POST  → save to our DB  + fire-and-forget forward to partner hub
//   • GET   → our DB messages + driver messages fetched from partner hub (merged)
const PARTNER_HUB = "https://diyala-partner-hub.replit.app";

/** Forward a message to the partner hub (non-blocking, best-effort). */
function bridgeToPartner(orderId: number, sender: string, content: string): void {
  fetch(`${PARTNER_HUB}/api/orders/${orderId}/messages`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ sender, content }),
  }).catch(() => { /* bridge failure is non-fatal */ });
}

/**
 * Fetch driver messages from partner hub and map them to our schema format.
 * We ONLY pull messages where sender === 'driver' — customer messages are
 * already in our DB (we forward them on POST), so we skip them here to
 * avoid duplicates.
 */
async function fetchPartnerDriverMsgs(orderId: number): Promise<{
  id: string; orderId: number; senderRole: string; content: string; createdAt: string;
}[]> {
  try {
    const res = await fetch(
      `${PARTNER_HUB}/api/orders/${orderId}/messages`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return [];
    const raw = (await res.json()) as any[];
    return raw
      .filter(m => m.sender === "driver" || m.senderRole === "driver")
      .map(m => ({
        id:         `partner_${m.id}`,          // prefix to avoid ID collision with our DB
        orderId:    m.orderId ?? orderId,
        senderRole: "driver",
        content:    m.content ?? "",
        createdAt:  m.createdAt ?? m.timestamp ?? new Date().toISOString(),
      }));
  } catch {
    return [];                                   // partner hub unreachable — degrade gracefully
  }
}

// ── GET /api/orders/:id/messages — public ────────────────────────────────────
router.get("/orders/:id/messages", async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isFinite(orderId)) { res.status(400).json({ error: "id غير صالح" }); return; }

    // Verify order exists
    const [order] = await db.select({ id: ordersTable.id }).from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order) { res.status(404).json({ error: "الطلب غير موجود" }); return; }

    // ── Fetch our own messages + partner hub driver messages in parallel ──────
    const [ourMsgs, partnerMsgs] = await Promise.all([
      db.select()
        .from(messagesTable)
        .where(eq(messagesTable.orderId, orderId))
        .orderBy(asc(messagesTable.createdAt)),
      fetchPartnerDriverMsgs(orderId),
    ]);

    // ── Deduplicate: build a Set of (senderRole|content|approx-timestamp) ──────
    // Any driver message that is in our DB already was forwarded back to us and
    // should NOT appear twice. We match by content + senderRole.
    const ourDriverContentSet = new Set(
      ourMsgs
        .filter(m => m.senderRole === "driver")
        .map(m => m.content.trim()),
    );

    const uniquePartnerMsgs = partnerMsgs.filter(
      m => !ourDriverContentSet.has(m.content.trim()),
    );

    // ── Merge and sort chronologically ────────────────────────────────────────
    const allMsgs = [...ourMsgs, ...uniquePartnerMsgs].sort(
      (a, b) => new Date(a.createdAt as any).getTime() - new Date(b.createdAt as any).getTime(),
    );

    res.json(allMsgs);
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

    // ── Broadcast via SSE to all connected clients ────────────────────────────
    broadcastNewMessage({
      id:         msg.id,
      orderId:    msg.orderId,
      senderRole: msg.senderRole,
      content:    msg.content,
      createdAt:  msg.createdAt,
    });

    // ── Bridge: forward to partner hub so the driver sees it too ─────────────
    // We forward ALL messages (customer AND driver) so both databases stay in
    // sync. The driver app reads from its own DB; without this bridge, customer
    // messages would never appear there.
    bridgeToPartner(orderId, msg.senderRole, msg.content);

    res.status(201).json(msg);
  } catch (err: any) {
    console.error("[POST /orders/:id/messages] error:", err);
    res.status(500).json({ error: "فشل حفظ الرسالة" });
  }
});

export default router;
