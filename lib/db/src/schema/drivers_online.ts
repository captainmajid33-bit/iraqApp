import { pgTable, serial, integer, text, real, boolean, timestamp } from "drizzle-orm/pg-core";

export const driversOnlineTable = pgTable("drivers_online", {
  id:          serial("id").primaryKey(),
  locationId:  integer("location_id").notNull().unique(),
  driverName:  text("driver_name").notNull().default(""),
  phone:       text("phone").notNull().default(""),
  lat:         real("lat").notNull(),
  lng:         real("lng").notNull(),
  isOnline:    boolean("is_online").notNull().default(true),
  isBusy:      boolean("is_busy").notNull().default(false),
  updatedAt:   timestamp("updated_at").defaultNow(),
});

export type DriverOnline = typeof driversOnlineTable.$inferSelect;
