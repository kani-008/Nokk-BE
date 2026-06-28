-- Migration: Add Razorpay payment columns and pending orders table
-- Run this against your PostgreSQL database before deploying Razorpay integration.

-- 1. Add Razorpay columns to orders table (all nullable — existing rows stay unaffected)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS razorpay_order_id   TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS razorpay_signature  TEXT;

-- 2. Unique index on razorpay_payment_id to enforce idempotency at DB level
--    (partial index: only non-null rows, since most orders won't have a payment_id)
CREATE UNIQUE INDEX IF NOT EXISTS orders_razorpay_payment_id_idx
  ON orders (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

-- 3. Index on razorpay_order_id for webhook lookups
CREATE INDEX IF NOT EXISTS orders_razorpay_order_id_idx
  ON orders (razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

-- 4. Widen payment_method CHECK constraint if one exists limiting to ('cod','upi').
--    The 'replacement' payment_method already used in adminUpdateReplacement suggests
--    there is no such constraint — this block is a safety net.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_payment_method_check'
      AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
    ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
      CHECK (payment_method IN ('cod','upi','replacement','razorpay_upi','razorpay_card','razorpay_netbanking','razorpay_wallet'));
  END IF;
END $$;

-- 5. Short-lived table to bridge create-order → verify-payment calls.
--    Stores validated cart/address state so verify-payment can re-derive prices
--    from trusted server-side data, not client-supplied body.
--    Entries should be cleaned up on successful order creation; a scheduled job
--    or application-level check can purge rows older than 30 minutes.
CREATE TABLE IF NOT EXISTS pending_razorpay_orders (
  razorpay_order_id TEXT        PRIMARY KEY,
  user_id           UUID        NOT NULL,
  items             JSONB       NOT NULL,
  address           JSONB       NOT NULL,
  coupon_applied    TEXT,
  server_total      NUMERIC(10,2) NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Index for TTL cleanup query (DELETE ... WHERE created_at < NOW() - INTERVAL '30 minutes')
CREATE INDEX IF NOT EXISTS pending_razorpay_orders_created_at_idx
  ON pending_razorpay_orders (created_at);
