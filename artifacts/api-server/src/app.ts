import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { addSseClient, removeSseClient, sendToClient } from "./lib/sse";
import { db } from "@workspace/db";
import { gasOrdersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const app: Express = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow the partner app + any Replit dev/preview domains.
// For PATCH with custom headers the browser sends an OPTIONS preflight first;
// we must respond 204 BEFORE any auth or body-parsing middleware.
const ALLOWED_ORIGINS = [
  "https://diyala-partner-hub.replit.app",
  "https://00-38yq7axxsi3c.sisko.replit.dev", // legacy dev URL
  /\.replit\.app$/,
  /\.replit\.dev$/,
  /\.sisko\.replit\.dev$/,
];

const corsOptions: CorsOptions = {
  origin: (origin, cb) => {
    // Allow server-to-server (no Origin header) and all matching origins
    if (!origin) return cb(null, true);
    const ok = ALLOWED_ORIGINS.some(o =>
      typeof o === "string" ? o === origin : o.test(origin)
    );
    cb(ok ? null : new Error(`CORS: origin not allowed — ${origin}`), ok);
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-admin-token",
    "x-admin-password",
    "x-partner-key",
    "x-merchant-key",
  ],
  exposedHeaders: ["Content-Type"],
  credentials: false,          // partner uses key header, not cookies
  optionsSuccessStatus: 204,   // some legacy browsers choke on 200
  maxAge: 86400,               // cache preflight for 24 h
};

// Apply CORS to all requests including OPTIONS preflight.
// cors() with preflightContinue=false (default) automatically short-circuits
// OPTIONS requests with the right headers — no separate app.options() needed.
// Must come before auth middleware so preflight is never rejected by auth.
app.use(cors(corsOptions));

// ── Logging ───────────────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Server-Sent Events endpoint — real-time map updates ───────────────────────
app.get("/api/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(":connected\n\n");

  addSseClient(res);

  // ── Replay all pending gas orders to this new client immediately ────────────
  // This ensures the partner app receives historical pending orders on
  // (re)connect — without depending on GPS availability or a separate REST call.
  try {
    const pending = await db
      .select()
      .from(gasOrdersTable)
      .where(eq(gasOrdersTable.status, "pending"))
      .orderBy(desc(gasOrdersTable.createdAt));

    for (const order of pending) {
      sendToClient(res, "gas_order_update", {
        order: {
          id: order.id,
          status: order.status,
          userName: order.userName,
          phone: order.phone,
          locationAddress: order.locationAddress,
          lat: order.lat,
          lng: order.lng,
        },
      });
    }
    if (pending.length > 0) {
      console.log(`[SSE connect] replayed ${pending.length} pending gas order(s) to new client`);
    }
  } catch (err) {
    console.warn("[SSE connect] failed to replay pending gas orders:", err);
  }

  const hb = setInterval(() => {
    try { res.write(":heartbeat\n\n"); } catch { clearInterval(hb); }
  }, 25_000);

  req.on("close", () => {
    clearInterval(hb);
    removeSseClient(res);
  });
});

app.use("/api", router);

export default app;
