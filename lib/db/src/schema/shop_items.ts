import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const shopItemsTable = pgTable("shop_items", {
  id:        serial("id").primaryKey(),
  name:      text("name").notNull(),
  emoji:     text("emoji").notNull().default("🎭"),
  price:     integer("price").notNull().default(1000),
  imageUrl:  text("image_url").notNull().default(""),
  color:     text("color").notNull().default("#00f5d4"),
  category:  text("category").notNull().default("skin"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive:  boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ShopItem    = typeof shopItemsTable.$inferSelect;
export type NewShopItem = typeof shopItemsTable.$inferInsert;
