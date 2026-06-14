-- ============================================================
-- NammaOorKaruvattuKadai — Full Supabase PostgreSQL Schema
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for text search

-- ============================================================
-- DROP EXISTING TABLES (For clean re-setup if needed)
-- ============================================================
DROP VIEW IF EXISTS v_products_with_price CASCADE;
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS return_requests CASCADE;
DROP TABLE IF EXISTS order_timelines CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS banners CASCADE;
DROP TABLE IF EXISTS coupons CASCADE;
DROP TABLE IF EXISTS cart_items CASCADE;
DROP TABLE IF EXISTS carts CASCADE;
DROP TABLE IF EXISTS wishlists CASCADE;
DROP TABLE IF EXISTS product_reviews CASCADE;
DROP TABLE IF EXISTS product_images CASCADE;
DROP TABLE IF EXISTS product_variants CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS addresses CASCADE;
DROP TABLE IF EXISTS otp_verifications CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP TYPE IF EXISTS user_role CASCADE;
DROP TYPE IF EXISTS user_status CASCADE;
DROP TYPE IF EXISTS order_status CASCADE;
DROP TYPE IF EXISTS payment_status CASCADE;
DROP TYPE IF EXISTS payment_method CASCADE;
DROP TYPE IF EXISTS offer_type CASCADE;
DROP TYPE IF EXISTS offer_applies_to CASCADE;
DROP TYPE IF EXISTS return_status CASCADE;
DROP TYPE IF EXISTS banner_position CASCADE;

-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE user_role AS ENUM ('customer', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'blocked');
CREATE TYPE order_status AS ENUM (
  'pending', 'confirmed', 'processing',
  'shipped', 'out_for_delivery', 'delivered',
  'cancelled', 'return_requested', 'returned', 'refunded'
);
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'refunded');
CREATE TYPE payment_method AS ENUM ('cod', 'upi', 'card', 'netbanking', 'wallet');
CREATE TYPE offer_type AS ENUM ('percentage', 'flat');
CREATE TYPE offer_applies_to AS ENUM ('product', 'category', 'all');
CREATE TYPE return_status AS ENUM ('requested', 'approved', 'rejected', 'completed');
CREATE TYPE banner_position AS ENUM ('hero', 'mid_page', 'category', 'sidebar');

-- ============================================================
-- TABLES
-- ============================================================

-- 1. Users table
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT UNIQUE NOT NULL,
  phone           TEXT UNIQUE,
  full_name       TEXT NOT NULL,
  avatar_url      TEXT,
  role            user_role NOT NULL DEFAULT 'customer',
  status          user_status NOT NULL DEFAULT 'active',
  email_verified  BOOLEAN DEFAULT FALSE,
  phone_verified  BOOLEAN DEFAULT FALSE,
  auth_provider   TEXT DEFAULT 'email',
  password_hash   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 2. OTP Verification codes
CREATE TABLE otp_verifications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  email           TEXT,
  phone           TEXT,
  otp_code        TEXT NOT NULL,
  verified        BOOLEAN DEFAULT FALSE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Addresses book
CREATE TABLE addresses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  label           TEXT DEFAULT 'Home',
  full_name       TEXT NOT NULL,
  phone           TEXT NOT NULL,
  address_line1   TEXT NOT NULL,
  address_line2   TEXT,
  city            TEXT NOT NULL,
  state           TEXT DEFAULT 'Tamil Nadu',
  pincode         TEXT NOT NULL,
  is_default      BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Categories table
CREATE TABLE categories (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name_en         TEXT NOT NULL,
  name_ta         TEXT,
  slug            TEXT UNIQUE NOT NULL,
  description     TEXT,
  image_url       TEXT,
  sort_order      INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Products table
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name_en         TEXT NOT NULL,
  name_ta         TEXT,
  slug            TEXT UNIQUE NOT NULL,
  description     TEXT,
  how_to_use      TEXT,
  storage_tips    TEXT,
  category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
  is_bestseller   BOOLEAN DEFAULT FALSE,
  is_new          BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Product variants table
CREATE TABLE product_variants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE,
  weight_grams    INTEGER NOT NULL,
  weight_label    TEXT NOT NULL,
  price           NUMERIC(10,2) NOT NULL,
  compare_price   NUMERIC(10,2),
  stock_qty       INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Product images table
CREATE TABLE product_images (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE,
  image_url       TEXT NOT NULL,
  sort_order      INTEGER DEFAULT 0,
  is_primary      BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Reviews table
CREATE TABLE product_reviews (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  rating          INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title           TEXT,
  comment         TEXT,
  is_approved     BOOLEAN DEFAULT TRUE,
  is_verified     BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Wishlists table
CREATE TABLE wishlists (
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

-- 10. Carts table
CREATE TABLE carts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Cart items table
CREATE TABLE cart_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cart_id         UUID REFERENCES carts(id) ON DELETE CASCADE,
  variant_id      UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (cart_id, variant_id)
);

-- 12. Coupons table
CREATE TABLE coupons (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code            TEXT UNIQUE NOT NULL,
  discount_percent INTEGER DEFAULT 0,
  discount_flat   NUMERIC(10,2) DEFAULT 0.00,
  free_shipping   BOOLEAN DEFAULT FALSE,
  min_order       NUMERIC(10,2) DEFAULT 0.00,
  max_uses        INTEGER DEFAULT 100,
  expiry_date     TIMESTAMPTZ,
  usage_count     INTEGER DEFAULT 0,
  description     TEXT,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 13. Banners table
CREATE TABLE banners (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  subtitle        TEXT,
  image_url       TEXT NOT NULL,
  link_url        TEXT,
  sort_order      INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 14. Orders table
CREATE TABLE orders (
  id              TEXT PRIMARY KEY, -- String like ORD-9874
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  customer_phone  TEXT NOT NULL,
  subtotal        NUMERIC(10,2) NOT NULL,
  delivery_charge NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  discount        NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  coupon_applied  TEXT, -- Store coupon code name or null
  total           NUMERIC(10,2) NOT NULL,
  status          order_status NOT NULL DEFAULT 'pending',
  payment_method  TEXT NOT NULL DEFAULT 'cod', -- UPI (GPay), COD, Card etc
  payment_status  payment_status NOT NULL DEFAULT 'pending',
  shipping_address_line1 TEXT NOT NULL,
  shipping_address_line2 TEXT,
  shipping_city   TEXT NOT NULL,
  shipping_state  TEXT DEFAULT 'Tamil Nadu',
  shipping_pincode TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 15. Order items table
CREATE TABLE order_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        TEXT REFERENCES orders(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  variant_id      UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  name_en         TEXT NOT NULL,
  name_ta         TEXT,
  weight          TEXT NOT NULL,
  price           NUMERIC(10,2) NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 16. Order timelines table
CREATE TABLE order_timelines (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        TEXT REFERENCES orders(id) ON DELETE CASCADE,
  status          order_status NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 17. Return requests table
CREATE TABLE return_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        TEXT REFERENCES orders(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL,
  details         TEXT,
  status          return_status NOT NULL DEFAULT 'requested',
  admin_notes     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 18. Settings table
CREATE TABLE settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VIEWS
-- ============================================================

CREATE OR REPLACE VIEW v_products_with_price AS
SELECT 
  p.id,
  p.name_en,
  p.name_ta,
  p.slug,
  p.description,
  p.how_to_use,
  p.storage_tips,
  p.is_bestseller,
  p.is_new,
  p.is_active,
  p.category_id,
  c.name_en AS category_name,
  c.slug AS category_slug,
  p.created_at,
  p.updated_at,
  pi.image_url AS primary_image,
  COALESCE(v.min_price, 0) AS min_price,
  COALESCE(v.min_compare_price, 0) AS min_compare_price,
  COALESCE(v.total_stock, 0) AS total_stock,
  COALESCE(r.avg_rating, 0) AS avg_rating,
  COALESCE(r.review_count, 0) AS review_count
FROM products p
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN product_images pi ON pi.product_id = p.id AND pi.is_primary = TRUE
LEFT JOIN (
  SELECT 
    product_id,
    MIN(price) AS min_price,
    MIN(compare_price) AS min_compare_price,
    SUM(stock_qty) AS total_stock
  FROM product_variants
  WHERE is_active = TRUE
  GROUP BY product_id
) v ON v.product_id = p.id
LEFT JOIN (
  SELECT 
    product_id,
    AVG(rating) AS avg_rating,
    COUNT(id) AS review_count
  FROM product_reviews
  WHERE is_approved = TRUE
  GROUP BY product_id
) r ON r.product_id = p.id;

-- ============================================================
-- SEED DATA
-- ============================================================

-- 1. Users & Admin Seed (with pre-generated bcrypt password hashes)
-- admin123 hash: $2a$10$4SNxfU8BlW8LmL8gS3P28eGMgEyLcIAEUNtGEItoYUliTqjR2WfMm
-- customer123 hash: $2a$10$JMHDNTIpwno3t16eptVxHO9Ij72.9AXmOnDPEF0ByguKlewrPbnwq
INSERT INTO users (id, email, phone, full_name, role, status, email_verified, phone_verified, password_hash) VALUES
('ad123456-7890-abcd-ef12-34567890abcd', 'admin@nammaoor.com', '9000011111', 'Admin Selvam', 'admin', 'active', TRUE, TRUE, '$2a$10$4SNxfU8BlW8LmL8gS3P28eGMgEyLcIAEUNtGEItoYUliTqjR2WfMm'),
('bc123456-7890-abcd-ef12-34567890abcd', 'customer@gmail.com', '9876543210', 'Anbarasan M', 'customer', 'active', TRUE, TRUE, '$2a$10$JMHDNTIpwno3t16eptVxHO9Ij72.9AXmOnDPEF0ByguKlewrPbnwq');

-- Addresses for Customer
INSERT INTO addresses (id, user_id, label, full_name, phone, address_line1, address_line2, city, state, pincode, is_default) VALUES
('aa111111-2222-3333-4444-555555555555', 'bc123456-7890-abcd-ef12-34567890abcd', 'Home', 'Anbarasan M', '9876543210', '14/3, East Coast Road', 'Thiruvanmiyur', 'Chennai', 'Tamil Nadu', '600041', TRUE);

-- 2. Categories
INSERT INTO categories (id, name_en, name_ta, slug, description, image_url, sort_order) VALUES
('d5a1b3c4-e8f7-4a1b-9c2d-3e4f5a6b7c8d', 'Dry Fish', 'கருவாடு', 'dry-fish', 'Authentic sun-dried fish sourced from traditional Tamil Nadu coastal villages.', '/assets/categories/dry-fish.jpg', 1),
('e6b2c4d5-f9a8-5b2c-0d3e-4f5a6b7c8d9e', 'Pickles', 'ஊறுகாய்', 'pickles', 'Traditional homemade hot and spicy seafood pickles prepared with gingelly oil.', '/assets/categories/pickles.jpg', 2),
('f7c3d5e6-a0b9-6c3d-1e4f-5a6b7c8d9e0f', 'Prawns & Shrimp', 'இறால்', 'prawns', 'Delicious sun-dried clean prawns and small shrimps loaded with rich flavor.', '/assets/categories/prawns.jpg', 3),
('a8d4e6f7-b1c0-7d4e-2f5a-6b7c8d9e0f1a', 'Masalas', 'மசாலாக்கள்', 'masalas', 'Traditional ground spices and masalas formulated with traditional village recipes.', '/assets/categories/masalas.jpg', 4),
('b9e5f7a8-c2d1-8e5f-3a6b-7c8d9e0f1a2b', 'Combos', 'கூட்டுத் தொகுப்புகள்', 'combos', 'Value packed combo options offering a curated mix of our best offerings.', '/assets/categories/combos.jpg', 5);

-- 3. Products
INSERT INTO products (id, name_en, name_ta, slug, description, how_to_use, storage_tips, category_id, is_bestseller, is_new) VALUES
('11111111-1111-1111-1111-111111111111', 'Nethili Karuvadu (Anchovy)', 'நெத்திலி கருவாடு', 'nethili-karuvadu', 'Traditionally sun-dried premium Anchovy fish. Highly nutritious, clean, and sourced directly from Rameswaram fishermen. Excellent for dry fish gravy and deep fry.', 'Soak in warm water for 10 minutes, wash 2-3 times to remove excess salt, then cook in gravies or fry.', 'Store in an airtight container in a cool, dry place. Refrigiration extends shelf life up to 6 months.', 'd5a1b3c4-e8f7-4a1b-9c2d-3e4f5a6b7c8d', TRUE, FALSE),
('22222222-2222-2222-2222-222222222222', 'Sura Karuvadu (Shark Dry Fish)', 'சுறா கருவாடு', 'sura-karuvadu', 'Cleaned, salted, and perfectly dried Shark fish chunks. Famously used to make "Sura Karuvadu Puttu". Known for its rich traditional taste and health benefits.', 'Boil in water for 5 minutes, scrape off any rough skin, shred into tiny pieces, and fry with small onions and green chilies.', 'Store in a dry glass jar. Keep away from moisture.', 'd5a1b3c4-e8f7-4a1b-9c2d-3e4f5a6b7c8d', TRUE, TRUE),
('33333333-3333-3333-3333-333333333333', 'Kavalai Karuvadu (Sardine)', 'கவலை கருவாடு', 'kavalai-karuvadu', 'Sardines sun-dried in the traditional coastal style. Sourced from the Tuticorin coast. Packed with Omega-3 fatty acids and deep Tamil coastal flavor.', 'Wash thoroughly in cold water. Fry with mustard, curry leaves, and red chilies, or add to tangy tamarind gravy.', 'Avoid damp places. Airing out under the sun for an hour once a month is recommended for long storage.', 'd5a1b3c4-e8f7-4a1b-9c2d-3e4f5a6b7c8d', FALSE, FALSE),
('44444444-4444-4444-4444-444444444444', 'Premium Karuvadu Thokku (Pickle)', 'காரசாரமான கருவாடு தொக்கு', 'karuvadu-thokku', 'A spicy, traditional dry fish pickle prepared with cold-pressed sesame oil, homemade masalas, and shredded boneless dry fish. A perfect side dish for hot curd rice.', 'Ready to eat. Use a dry spoon only. Mix with hot rice or eat as a side dish for idli, dosa, or curd rice.', 'Keep in refrigerator after opening. Sits well for up to 3 months.', 'e6b2c4d5-f9a8-5b2c-0d3e-4f5a6b7c8d9e', TRUE, FALSE),
('55555555-5555-5555-5555-555555555555', 'Spicy Prawn Pickle', 'காரசாரமான இறால் ஊறுகாய்', 'prawn-pickle', 'Made using fresh prawns fried to perfection and blended with robust coastal spices and gingelly oil. Authentic village taste that will leave you wanting more.', 'Directly consume as an accompaniment with meals.', 'Keep lid tightly closed. Store in a cool place.', 'e6b2c4d5-f9a8-5b2c-0d3e-4f5a6b7c8d9e', FALSE, TRUE),
('66666666-6666-6666-6666-666666666666', 'Sun-Dried Prawns (Ular Eral)', 'உலர் இறால் (கருவாடு)', 'ular-eral', 'Shelled and sun-dried prawns. Clean, sand-free, and natural. Adds a burst of umami flavor to your gravies, rice, and stir-frys.', 'Rinse in cold water. Add directly to gravies, masalas, or fry with onions.', 'Store in air-tight container in freezer for best results.', 'f7c3d5e6-a0b9-6c3d-1e4f-5a6b7c8d9e0f', TRUE, FALSE),
('77777777-7777-7777-7777-777777777777', 'Traditional Fish Fry Masala', 'மீன் வறுவல் மசாலா', 'fish-fry-masala', 'Sourced from coastal villages. A stone-ground, aromatic blend of red chilies, coriander, cumin, pepper, and traditional spices. Gives the authentic fish fry flavor.', 'Mix 2 tbsp masala with lemon juice/water and salt, coat fish pieces, marinate for 20 mins, and shallow fry.', 'Keep in dry container. Avoid wet hands.', 'a8d4e6f7-b1c0-7d4e-2f5a-6b7c8d9e0f1a', FALSE, FALSE),
('88888888-8888-8888-8888-888888888888', 'Village Special Karuvadu Combo', 'கிராமத்து ஸ்பெஷல் கருவாடு காம்போ', 'village-combo', 'A handpicked dry fish bundle for true seafood lovers. Contains: Nethili Karuvadu (250g) + Sura Karuvadu (250g) + Dry Prawns (250g). Sourced fresh, packed hygiene.', 'Process individual packs as per their respective cooking instructions.', 'Store in cool dry place or refrigerate individually.', 'b9e5f7a8-c2d1-8e5f-3a6b-7c8d9e0f1a2b', TRUE, FALSE),
('99999999-9999-9999-9999-999999999999', 'Seela Karuvadu (Kingfish Dry Fish)', 'சீலா கருவாடு', 'seela-karuvadu', 'Premium Kingfish (Seela/Vanjaram) dry fish slices. Thick chunks, very meaty, and minimal bones. Sourced from Cuddalore harbor. Perfect for making traditional fish curry.', 'Soak in warm water for 15 minutes, scrub slightly, wash and drop directly into simmering curry.', 'Store in freezer inside an airtight plastic zip lock.', 'd5a1b3c4-e8f7-4a1b-9c2d-3e4f5a6b7c8d', TRUE, FALSE),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Kanava Karuvadu (Dry Squid)', 'கணவா கருவாடு', 'kanava-karuvadu', 'Cleaned and flat-dried whole squids. Sourced from coastal Ramanathapuram. Highly popular for its chewy, rich seafood flavor when roasted or fried with chilies.', 'Wash, cut into small rings, soak in hot water, and stir fry with onions, garlic, and cracked black pepper.', 'Keep in dry airtight jar. Avoid heat and moisture.', 'd5a1b3c4-e8f7-4a1b-9c2d-3e4f5a6b7c8d', FALSE, TRUE);

-- 4. Product Variants
INSERT INTO product_variants (product_id, weight_grams, weight_label, price, compare_price, stock_qty) VALUES
('11111111-1111-1111-1111-111111111111', 250, '250g', 180.00, 200.00, 45),
('11111111-1111-1111-1111-111111111111', 500, '500g', 340.00, 400.00, 30),
('11111111-1111-1111-1111-111111111111', 1000, '1kg', 650.00, 800.00, 15),

('22222222-2222-2222-2222-222222222222', 250, '250g', 220.00, 220.00, 25),
('22222222-2222-2222-2222-222222222222', 500, '500g', 420.00, 440.00, 18),
('22222222-2222-2222-2222-222222222222', 1000, '1kg', 800.00, 880.00, 8),

('33333333-3333-3333-3333-333333333333', 250, '250g', 120.00, 140.00, 50),
('33333333-3333-3333-3333-333333333333', 500, '500g', 220.00, 280.00, 40),
('33333333-3333-3333-3333-333333333333', 1000, '1kg', 400.00, 560.00, 20),

('44444444-4444-4444-4444-444444444444', 250, '250g', 190.00, 200.00, 60),
('44444444-4444-4444-4444-444444444444', 500, '500g', 360.00, 400.00, 35),

('55555555-5555-5555-5555-555555555555', 250, '250g', 250.00, 250.00, 40),
('55555555-5555-5555-5555-555555555555', 500, '500g', 480.00, 500.00, 20),

('66666666-6666-6666-6666-666666666666', 250, '250g', 230.00, 260.00, 30),
('66666666-6666-6666-6666-666666666666', 500, '500g', 430.00, 520.00, 15),

('77777777-7777-7777-7777-777777777777', 250, '250g', 85.00, 85.00, 100),
('77777777-7777-7777-7777-777777777777', 500, '500g', 160.00, 170.00, 60),

('88888888-8888-8888-8888-888888888888', 1000, '1kg', 499.00, 625.00, 25),

('99999999-9999-9999-9999-999999999999', 250, '250g', 320.00, 320.00, 0),
('99999999-9999-9999-9999-999999999999', 500, '500g', 600.00, 600.00, 0),

('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 250, '250g', 260.00, 275.00, 15),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500, '500g', 500.00, 550.00, 10);

-- 5. Product Images
INSERT INTO product_images (product_id, image_url, sort_order, is_primary) VALUES
('11111111-1111-1111-1111-111111111111', '/assets/products/nethili.jpg', 1, TRUE),
('11111111-1111-1111-1111-111111111111', '/assets/products/nethili_detail1.jpg', 2, FALSE),
('11111111-1111-1111-1111-111111111111', '/assets/products/nethili_detail2.jpg', 3, FALSE),
('22222222-2222-2222-2222-222222222222', '/assets/products/sura.jpg', 1, TRUE),
('33333333-3333-3333-3333-333333333333', '/assets/products/kavalai.jpg', 1, TRUE),
('44444444-4444-4444-4444-444444444444', '/assets/products/thokku.jpg', 1, TRUE),
('55555555-5555-5555-5555-555555555555', '/assets/products/prawn-pickle.jpg', 1, TRUE),
('66666666-6666-6666-6666-666666666666', '/assets/products/dry-prawns.jpg', 1, TRUE),
('77777777-7777-7777-7777-777777777777', '/assets/products/masala.jpg', 1, TRUE),
('88888888-8888-8888-8888-888888888888', '/assets/products/combo.jpg', 1, TRUE),
('99999999-9999-9999-9999-999999999999', '/assets/products/seela.jpg', 1, TRUE),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '/assets/products/squid.jpg', 1, TRUE);

-- 6. Product Reviews Seed (Some verified purchases)
INSERT INTO product_reviews (product_id, user_id, rating, title, comment, is_approved, is_verified) VALUES
('11111111-1111-1111-1111-111111111111', 'bc123456-7890-abcd-ef12-34567890abcd', 5, 'Super Quality', 'Very clean dry fish, less salt and excellent packing. Gravy tasted superb!', TRUE, TRUE),
('44444444-4444-4444-4444-444444444444', 'bc123456-7890-abcd-ef12-34567890abcd', 4, 'Very Tasty', 'Perfect blend of spice and sesame oil. Reminds of my village grandmother cooking.', TRUE, TRUE);

-- 7. Coupons
INSERT INTO coupons (code, discount_percent, discount_flat, free_shipping, min_order, max_uses, expiry_date, usage_count, description) VALUES
('KARUVADU10', 10, 0.00, FALSE, 500.00, 100, '2026-12-31T23:59:59Z', 14, '10% OFF on orders above ₹500'),
('WELCOME50', 0, 50.00, FALSE, 300.00, 500, '2026-09-30T23:59:59Z', 88, 'Flat ₹50 OFF on orders above ₹300'),
('FREESHIP', 0, 0.00, TRUE, 400.00, 1000, '2026-12-31T23:59:59Z', 204, 'Free Delivery on orders above ₹400');

-- 8. Banners
INSERT INTO banners (title, subtitle, image_url, link_url, sort_order) VALUES
('சுத்தமான கிராமத்து கருவாடு', 'Sun-dried. No chemical preservatives. Sourced direct from coastal Tamil Nadu villages.', '/assets/banners/hero-banner.jpg', '/products', 1),
('ஆடி மாச ஸ்பெஷல் சலுகை', 'Flat 10% OFF on all pickles and thokku items. Use code KARUVADU10.', '/assets/banners/offer-banner.jpg', '/products?category=pickles', 2),
('இறக்குமதி இல்லாத நேரடி கொள்முதல்', 'Sourced directly from our traditional fishermen community. Savor the authentic taste.', '/assets/banners/fisherman-banner.jpg', '/products', 3);

-- 9. Orders & Order Items (Initial demo orders)
INSERT INTO orders (id, user_id, customer_name, customer_email, customer_phone, subtotal, delivery_charge, discount, coupon_applied, total, status, payment_method, payment_status, shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_pincode, created_at) VALUES
('ORD-9874', 'bc123456-7890-abcd-ef12-34567890abcd', 'Anbarasan M', 'customer@gmail.com', '9876543210', 550.00, 0.00, 55.00, 'KARUVADU10', 495.00, 'processing', 'UPI (GPay)', 'paid', '14/3, East Coast Road', 'Thiruvanmiyur', 'Chennai', 'Tamil Nadu', '600041', '2026-06-12T14:32:00Z'),
('ORD-9532', 'bc123456-7890-abcd-ef12-34567890abcd', 'Deepak Kumar', 'deepak@gmail.com', '9944332211', 420.00, 50.00, 0.00, NULL, 470.00, 'delivered', 'Cash on Delivery (COD)', 'paid', '5A, Gandhi Nagar', 'Kottar', 'Nagercoil', 'Tamil Nadu', '629002', '2026-06-08T10:15:00Z');

-- Order Items details
INSERT INTO order_items (order_id, product_id, variant_id, name_en, name_ta, weight, price, quantity) VALUES
('ORD-9874', '11111111-1111-1111-1111-111111111111', (SELECT id FROM product_variants WHERE product_id='11111111-1111-1111-1111-111111111111' AND weight_label='250g'), 'Nethili Karuvadu (Anchovy)', 'நெத்திலி கருவாடு', '250g', 180.00, 2),
('ORD-9874', '44444444-4444-4444-4444-444444444444', (SELECT id FROM product_variants WHERE product_id='44444444-4444-4444-4444-444444444444' AND weight_label='250g'), 'Premium Karuvadu Thokku (Pickle)', 'காரசாரமான கருவாடு தொக்கு', '250g', 190.00, 1),
('ORD-9532', '22222222-2222-2222-2222-222222222222', (SELECT id FROM product_variants WHERE product_id='22222222-2222-2222-2222-222222222222' AND weight_label='500g'), 'Sura Karuvadu (Shark Dry Fish)', 'சுறா கருவாடு', '500g', 420.00, 1);

-- Order Timeline events
INSERT INTO order_timelines (order_id, status, notes) VALUES
('ORD-9874', 'pending', 'Order placed by customer.'),
('ORD-9874', 'confirmed', 'Order has been confirmed by shop admin.'),
('ORD-9874', 'processing', 'Order is being packaged and prepared for shipping.'),
('ORD-9532', 'pending', 'Order placed by customer via Cash on Delivery.'),
('ORD-9532', 'confirmed', 'Order confirmed.'),
('ORD-9532', 'processing', 'Order processed.'),
('ORD-9532', 'shipped', 'Package handed over to delivery executive.'),
('ORD-9532', 'delivered', 'Order successfully delivered to customer. Payment collected.');

-- 10. Global Settings
INSERT INTO settings (key, value) VALUES
('websiteName', 'Namma Oor Karuvattu Kadai'),
('websiteNameTa', 'நம்ம ஊர் கருவாடு கடை'),
('logo', '/assets/logo.png'),
('contactPhone', '+91 94420 XXXXX'),
('contactEmail', 'orders@nammaoor.com'),
('whatsappNumber', '+9194420XXXXX'),
('freeShippingThreshold', '500'),
('flatDeliveryCharge', '50'),
('instagramUrl', 'https://instagram.com'),
('facebookUrl', 'https://facebook.com'),
('youtubeUrl', 'https://youtube.com'),
('maintenanceMode', 'false');