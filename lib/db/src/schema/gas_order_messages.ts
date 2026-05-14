import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { gasOrdersTable } from "./gas_orders";

export const gasOrderMessagesTable = pgTable("gas_order_messages", {
  id:          serial("id").primaryKey(),
  gasOrderId:  integer("gas_order_id").notNull().references(() => gasOrdersTable.id, { onDelete: "cascade" }),
  senderRole:  text("sender_role").notNull(), // 'customer' | 'agent' | 'system'
  content:     text("content").notNull(),
  isSystemMsg: boolean("is_system_msg").notNull().default(false),
  createdAt:   timestamp("created_at").defaultNow(),
});

export const insertGasOrderMessageSchema = createInsertSchema(gasOrderMessagesTable).omit({
  id:        true,
  createdAt: true,
});

export type InsertGasOrderMessage = z.infer<typeof insertGasOrderMessageSchema>;
export type GasOrderMessageDB     = typeof gasOrderMessagesTable.$inferSelect;
