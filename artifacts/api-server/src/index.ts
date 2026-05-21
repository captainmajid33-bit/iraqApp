import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { driversOnlineTable, ordersTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { broadcastDriverUpdate } from "./lib/sse";

// ── Auto-release stuck isBusy drivers every 10 minutes ────────────────────────
// A driver is considered "stuck busy" if isBusy=true but has NO order currently
// in accepted/driving state. This can happen when the partner app crashes mid-trip
// or if the status update call failed.
async function autoReleaseBusyDrivers() {
  try {
    // Find all drivers currently marked as busy
    const busyDrivers = await db
      .select({ locationId: driversOnlineTable.locationId })
      .from(driversOnlineTable)
      .where(eq(driversOnlineTable.isBusy, true));

    if (busyDrivers.length === 0) return;

    // Find locationIds that actually have an active order right now
    const activeOrders = await db
      .select({ locationId: ordersTable.locationId })
      .from(ordersTable)
      .where(inArray(ordersTable.status, ["accepted", "driving"]));

    const activeLocationIds = new Set(activeOrders.map(o => o.locationId));

    // Release any driver that is busy but has no active order
    const toRelease = busyDrivers.filter(d => !activeLocationIds.has(d.locationId));

    for (const d of toRelease) {
      const [updated] = await db
        .update(driversOnlineTable)
        .set({ isBusy: false, updatedAt: new Date() })
        .where(eq(driversOnlineTable.locationId, d.locationId))
        .returning();
      if (updated) {
        broadcastDriverUpdate(updated as Record<string, unknown>);
        logger.info({ locationId: d.locationId }, "[AUTO-RELEASE] driver freed — no active order found");
      }
    }
  } catch (err) {
    logger.warn({ err }, "[AUTO-RELEASE] cleanup failed (non-fatal)");
  }
}

// Run immediately on startup, then every 10 minutes
autoReleaseBusyDrivers();
setInterval(autoReleaseBusyDrivers, 10 * 60 * 1000);


const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
