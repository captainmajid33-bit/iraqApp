import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "./admin";
import { broadcastSettingUpdate } from "../lib/sse";

const router: IRouter = Router();

// ── GET /api/settings/:key — public ──────────────────────────────────────────
router.get("/settings/:key", async (req, res) => {
  try {
    const { key } = req.params;
    const [row] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, key));
    if (!row) {
      res.json({ key, value: "" });
      return;
    }
    res.json(row);
  } catch (err: any) {
    console.error("[GET /settings/:key] error:", err);
    res.status(500).json({ error: "فشل جلب الإعداد" });
  }
});

// ── PATCH /api/settings/:key — admin only ─────────────────────────────────────
router.patch("/settings/:key", requireAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body ?? {};
    if (typeof value !== "string") {
      res.status(400).json({ error: "value مطلوب" });
      return;
    }

    const [row] = await db
      .insert(settingsTable)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set:    { value, updatedAt: new Date() },
      })
      .returning();

    broadcastSettingUpdate(key, value);
    res.json({ ok: true, setting: row });
  } catch (err: any) {
    console.error("[PATCH /settings/:key] error:", err);
    res.status(500).json({ error: "فشل حفظ الإعداد" });
  }
});

export default router;
