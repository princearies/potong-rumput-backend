-- Migration 0003: harga ikut luas+tebal (Grab-style), add-on bersih, auto-assign
-- Formula: Harga = MAX(RM50, 25 + luas×0.20×tebal + zon) + bersih(0/20/30)

ALTER TABLE bookings ADD COLUMN zone TEXT NOT NULL DEFAULT 'PUTATAN';
ALTER TABLE bookings ADD COLUMN area_m2 REAL;
ALTER TABLE bookings ADD COLUMN thickness TEXT;
ALTER TABLE bookings ADD COLUMN cleanup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN assigned_provider TEXT;
ALTER TABLE bookings ADD COLUMN assigned_phone TEXT;
ALTER TABLE bookings ADD COLUMN offer_expires_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_bookings_zone_status ON bookings(zone, status);
