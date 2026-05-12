import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { addSseClient, removeSseClient } from "./lib/sse";

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
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(":connected\n\n");

  addSseClient(res);

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
