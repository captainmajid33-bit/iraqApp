import { pgTable, serial, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { locationsTable } from "./locations";

export const ordersTable = pgTable("orders", {
  id:          serial("id").primaryKey(),
  locationId:  integer("location_id").notNull().references(() => locationsTable.id, { onDelete: "cascade" }),
  phone:       text("phone").notNull(),
  destination: text("destination").notNull(),
  lat:         real("lat"),
  lng:         real("lng"),
  status:      text("status").notNull().default("pending"),
  createdAt:   timestamp("created_at").defaultNow(),
});

export const insertOrderSchema = createInsertSchema(ordersTable).omit({
  id:        true,
  createdAt: true,
  status:    true,
});

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type OrderDB     = typeof ordersTable.$inferSelect;
