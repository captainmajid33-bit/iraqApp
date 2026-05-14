import { pgTable, serial, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const gasOrdersTable = pgTable("gas_orders", {
  id:              serial("id").primaryKey(),
  userName:        text("user_name"),
  phone:           text("phone").notNull(),
  locationAddress: text("location_address"),
  lat:             real("lat"),
  lng:             real("lng"),
  status:          text("status").notNull().default("pending"),
  createdAt:       timestamp("created_at").defaultNow(),
});

export const insertGasOrderSchema = createInsertSchema(gasOrdersTable).omit({
  id:        true,
  createdAt: true,
  status:    true,
});

export type InsertGasOrder = z.infer<typeof insertGasOrderSchema>;
export type GasOrderDB     = typeof gasOrdersTable.$inferSelect;
