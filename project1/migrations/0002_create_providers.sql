-- Migration: Create providers table for tukang rumput registration
CREATE TABLE IF NOT EXISTS providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    ic_number TEXT,
    zones TEXT NOT NULL,
    status TEXT DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'INACTIVE')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_providers_phone ON providers(phone);
CREATE INDEX IF NOT EXISTS idx_providers_status ON providers(status);