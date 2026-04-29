-- Optional geo coordinates for the delivery destination, picked by the
-- customer on a map at order time. Used by the SPA to render driver +
-- destination markers and to drive the demo "simulated delivery" path.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS delivery_latitude  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS delivery_longitude DOUBLE PRECISION;
