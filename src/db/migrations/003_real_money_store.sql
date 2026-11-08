-- Move the store to real-money pricing. Legacy diamond columns are retained
-- for historical reference, but legacy products are disabled until staff
-- assigns a real price in cents.
ALTER TABLE store_items
  ADD COLUMN price_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN stock_quantity INTEGER,
  ADD CONSTRAINT store_items_price_cents_nonnegative CHECK (price_cents >= 0),
  ADD CONSTRAINT store_items_stock_nonnegative CHECK (stock_quantity IS NULL OR stock_quantity >= 0);

UPDATE store_items SET active = false WHERE price_cents = 0;

ALTER TABLE orders
  ADD COLUMN total_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'pix',
  ADD COLUMN idempotency_key TEXT UNIQUE,
  ADD COLUMN idempotency_payload_hash TEXT;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
UPDATE orders SET total_cents = 0;
UPDATE orders SET status = CASE status
  WHEN 'pendente' THEN 'pending_payment'
  WHEN 'pago' THEN 'paid'
  WHEN 'cancelado' THEN 'cancelled'
  ELSE 'pending_payment'
END;

ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending_payment','paid','processing','delivered','cancelled','refunded','expired'));
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending_payment';
ALTER TABLE orders ADD CONSTRAINT orders_total_cents_nonnegative CHECK (total_cents >= 0);

ALTER TABLE order_items
  ADD COLUMN unit_price_cents BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT order_items_unit_price_cents_nonnegative CHECK (unit_price_cents >= 0),
  ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0);

CREATE TABLE payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, provider_event_id)
);
