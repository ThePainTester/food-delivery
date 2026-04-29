CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS orders (
    id                 UUID PRIMARY KEY,
    customer_id        UUID NOT NULL,
    restaurant_id      UUID NOT NULL,
    delivery_user_id   UUID,
    items              JSONB NOT NULL,
    subtotal_cents     BIGINT NOT NULL,
    delivery_fee_cents BIGINT NOT NULL,
    total_cents        BIGINT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN (
        'PENDING','ACCEPTED','REJECTED','PREPARING','READY',
        'PICKED_UP','DELIVERED','CANCELLED'
    )),
    paid               BOOLEAN NOT NULL DEFAULT FALSE,
    delivery_address   TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer    ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant  ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery    ON orders(delivery_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);

-- Per-consumer idempotency table for event processing.
CREATE TABLE IF NOT EXISTS processed_events (
    consumer    TEXT NOT NULL,
    event_id    UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (consumer, event_id)
);
