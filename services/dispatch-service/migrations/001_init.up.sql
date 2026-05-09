CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- assignments.order_id is the SINGLE authority for who owns an order.
-- Finalization uses INSERT ... ON CONFLICT (order_id) DO NOTHING:
--   rowCount = 1 → caller wins, run downstream effects.
--   rowCount = 0 → someone else won (or duplicate retry); 409, no side effects.
CREATE TABLE IF NOT EXISTS assignments (
    order_id     UUID PRIMARY KEY,
    driver_id    UUID NOT NULL,
    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assignments_driver ON assignments(driver_id);
