import { pgTable, serial, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const gasOrdersTable = pgTable("gas_orders", {
  id:                serial("id").primaryKey(),
  userName:          text("user_name"),
  phone:             text("phone").notNull(),
  locationAddress:   text("location_address"),
  lat:               real("lat"),
  lng:               real("lng"),
  agentId:           text("agent_id"),
  status:            text("status").notNull().default("pending"),
  // Array of agent IDs (uid / phone) who declined this order.
  // When an agent rejects, their ID is appended here and the order stays
  // 'pending' so other agents can still claim it.
  declinedByAgents:  text("declined_by_agents").array().default([]),
  createdAt:         timestamp("created_at").defaultNow(),
});

export const insertGasOrderSchema = createInsertSchema(gasOrdersTable).omit({
  id:        true,
  createdAt: true,
  status:    true,
  agentId:   true,
});

export type InsertGasOrder = z.infer<typeof insertGasOrderSchema>;
export type GasOrderDB     = typeof gasOrdersTable.$inferSelect;
