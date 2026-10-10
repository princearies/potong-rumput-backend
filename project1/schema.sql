CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    house_type TEXT NOT NULL CHECK (house_type IN ('TERES', 'SEMI_D', 'BANGLO')),
    price REAL NOT NULL,
    status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'COMPLETED', 'CANCELLED')),
    provider_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);