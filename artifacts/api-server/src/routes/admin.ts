import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "crypto";

const router: IRouter = Router();

const ADMIN_PASSWORD = "Admin2026";

// In-memory token store: token → expiry timestamp
const sessions = new Map<string, number>();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

function cleanExpired() {
  const now = Date.now();
  for (const [token, exp] of sessions) {
    if (now > exp) sessions.delete(token);
  }
}

// ── POST /api/admin/login ──────────────────────────────────────────────────────
router.post("/admin/login", (req: Request, res: Response) => {
  const { password } = req.body ?? {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  cleanExpired();
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL);
  res.json({ ok: true, token });
});

// ── POST /api/admin/logout ─────────────────────────────────────────────────────
router.post("/admin/logout", (req: Request, res: Response) => {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// ── GET /api/admin/verify ─────────────────────────────────────────────────────
router.get("/admin/verify", (req: Request, res: Response) => {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!token || !sessions.has(token) || Date.now() > sessions.get(token)!) {
    if (token) sessions.delete(token);
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true });
});

// ── Shared token validator (used by other routes) ─────────────────────────────
export function isValidAdminToken(token: string | undefined): boolean {
  if (!token) return false;
  if (!sessions.has(token) || Date.now() > sessions.get(token)!) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}

// ── Middleware export (for protecting write routes) ───────────────────────────
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isValidAdminToken(req.headers["x-admin-token"] as string | undefined)) {
    return res.status(401).json({ ok: false, error: "Admin token required" });
  }
  next();
}

export default router;
