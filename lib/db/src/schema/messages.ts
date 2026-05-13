import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ordersTable } from "./orders";

export const messagesTable = pgTable("messages", {
  id:         serial("id").primaryKey(),
  orderId:    integer("order_id").notNull().references(() => ordersTable.id, { onDelete: "cascade" }),
  senderRole: text("sender_role").notNull(), // 'customer' | 'driver'
  content:    text("content").notNull(),
  createdAt:  timestamp("created_at").defaultNow(),
});

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  id:        true,
  createdAt: true,
});

export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type MessageDB    = typeof messagesTable.$inferSelect;
