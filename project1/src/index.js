/// <reference types="@cloudflare/workers-types" />
/**
 * @file Marketplace Potong Rumput / Handyman On-Demand — Cloudflare Worker backend (JavaScript).
 * @module potong-rumput-backend
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

// ============================================================================
// 1. CONSTANTS & TYPE HELPERS (TypeScript types are erased in plain JS)
// ============================================================================

/** @typedef {'TERES' | 'SEMI_D' | 'BANGLO'} HouseType */
/** @typedef {'PENDING' | 'ACCEPTED' | 'COMPLETED' | 'CANCELLED'} BookingStatus */

/** @type {Record<Exclude<HouseType, string>, number>} */
const PRICE_MAP = {
  TERES: 40,
  SEMI_D: 70,
  BANGLO: 120,
};

/** House types supported by the service. */
const SUPPORTED_HOUSE_TYPES = Object.keys(PRICE_MAP);

const HOUSE_TYPE_LABEL = {
  TERES: 'Teres (Satu Tingkat)',
  SEMI_D: 'Semi-D (2 Tingkat)',
  BANGLO: 'Bunglo',
};

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

// ============================================================================
// 2. APP INITIALIZATION
// ============================================================================

const app = new Hono();

// Middleware: logger + secure headers
app.use('*', logger());
app.use('*', secureHeaders());

// Middleware: CORS
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Custom-Header', 'X-Request-ID'],
    exposeHeaders: ['Content-Length', 'X-Request-ID'],
    maxAge: 86400,
    credentials: true,
  })
);

// Middleware: short-circuit preflight OPTIONS requests
app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  await next();
});

// ============================================================================
// 3. HELPER UTILITIES
// ============================================================================

/**
 * Build a JSON success payload.
 * @param {object} data
 * @returns {{ ok: boolean, data: object }}
 */
function ok(data) {
  return { ok: true, data };
}

/**
 * Build a JSON error payload.
 * @param {string} message
 * @param {number} [status=500]
 * @returns {{ ok: boolean, error: string }}
 */
function err(message, status = 500) {
  return { ok: false, status, error: message };
}

// ============================================================================
// 4. ROUTES
// ============================================================================

/** Health check & API documentation root. */
app.get('/', (c) => {
  return c.json({
    ok: true,
    service: 'potong-rumput-backend',
    version: '1.0.0',
    endpoints: {
      booking: 'POST /api/booking',
      webhook: 'POST /api/bot/webhook',
      bookings: 'GET /api/bookings',
    },
  });
});

/**
 * POST /api/booking
 *
 * Menerima tempahan potongan rumput, mengira harga automatik mengikut
 * houseType, menyimpan ke Cloudflare D1 dan menghantar notifikasi Telegram
 * kepada kumpulan tukang rumput dengan butang inline "AMBIL JOB INI".
 */
app.post('/api/booking', async (c) => {
  /** @type {{ name: string, phone: string, address: string, houseType: string }} */
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(err('Bad request: fail JSON tidak sah', 400));
  }

  const { name, phone, address, houseType } = payload;

  // --- Validation ---
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return c.json(err('Nama pelanggan tidak sah (min. 2 aksara)', 400));
  }

  if (!phone || typeof phone !== 'string' || !/^\d{9,15}$/.test(phone.replace(/\D/g, ''))) {
    return c.json(err('Nombor telefon tidak sah (9-15 digit)', 400));
  }

  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    return c.json(err('Alamat pelanggan tidak sah (min. 5 aksara)', 400));
  }

  const normalizedHouseType = String(houseType).toUpperCase();
  if (!SUPPORTED_HOUSE_TYPES.includes(normalizedHouseType)) {
    return c.json(err('houseType tidak sah. Sila pilih TERES, SEMI_D atau BANGLO', 400));
  }

  const houseTypeKey = /** @type {HouseType} */ (normalizedHouseType);
  const price = PRICE_MAP[houseTypeKey];

  const db = c.env.DB;

  // --- Simpan ke D1 ---
  const insertResult = await db
    .prepare(
      `INSERT INTO bookings (customer_name, phone, address, house_type, price, status, provider_name)
       VALUES (?, ?, ?, ?, ?, 'PENDING', NULL)`
    )
    .bind(name.trim(), phone.trim(), address.trim(), houseTypeKey, price)
    .run();

  const insertedRow = await db
    .prepare(
      'SELECT id, customer_name, phone, address, house_type, price, status, provider_name, created_at ' +
        'FROM bookings WHERE id = ?'
    )
    .bind(insertResult.meta.last_row_id)
    .first();

  if (!insertedRow) {
    console.error(
      '[Booking] Gagal membaca rekod yang baru diinsert; last_row_id =',
      insertResult.meta.last_row_id
    );
    return c.json(err('Gagal menyimpan tempahan ke pangkalan data', 500));
  }

  const createdLocal = new Date(insertedRow.created_at).toLocaleString('ms-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
  });

  // --- Hantar notifikasi Telegram ---
  const message = [
    '🌿 *JOB BARU: Potong Rumput* 🌿',
    '',
    `👤 *Pelanggan*: ${insertedRow.customer_name}`,
    `📞 *Telefon*: ${insertedRow.phone}`,
    `🏠 *Alamat*: ${insertedRow.address}`,
    `🏡 *Jenis Rumah*: ${houseTypeKey} (${HOUSE_TYPE_LABEL[houseTypeKey]})`,
    `💰 *Harga*: RM ${price.toFixed(2)}`,
    `🆔 *ID Tempahan*: ${insertedRow.id}`,
    `⏰ *Masa*: ${createdLocal}`,
    '',
    'Tekan butang di bawah untuk menerima job ini.',
  ].join('\n');

  /** @type {{ inline_keyboard: Array<Array<{ text: string, callback_data: string, style?: string }>> }} */
  const inlineKeyboard = {
    inline_keyboard: [
      [
        {
          text: '✅ AMBIL JOB INI',
          callback_data: `accept:${insertedRow.id}`,
          style: 'success',
        },
      ],
    ],
  };

  try {
    await fetch(`${TELEGRAM_API_BASE}${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: c.env.TELEGRAM_GROUP_ID,
        text: message,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard,
      }),
    }).then(async (response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Telegram API error ${response.status}: ${response.statusText} (${text.slice(0, 200)})`
        );
      }
    });
  } catch (telegramError) {
    // Gagal hantar notifikasi tidak membatalkan tempahan: log & teruskan (fail-open).
    console.error('[Telegram] Gagal hantar notifikasi:', telegramError);
  }

  return c.json({
    success: true,
    booking: {
      id: insertedRow.id,
      customer_name: insertedRow.customer_name,
      phone: insertedRow.phone,
      address: insertedRow.address,
      house_type: insertedRow.house_type,
      price: Number(insertedRow.price),
      status: insertedRow.status,
      provider_name: insertedRow.provider_name,
      created_at: insertedRow.created_at,
    },
  });
});

/**
 * POST /api/bot/webhook
 *
 * Mengendalikan Callback Query daripada Telegram apabila tukang rumput
 * menekan butang "AMBIL JOB INI". Status ditukar ke ACCEPTED dan
 * provider_name direkodkan. Jawapan dikembalikan kepada tukang.
 */
app.post('/api/bot/webhook', async (c) => {
  /** @type {{ update_id: number, callback_query?: object }} */
  let update;
  try {
    const rawText = await c.req.raw.text();
    update = JSON.parse(rawText);
  } catch {
    return c.json(err('Invalid JSON payload', 400));
  }

  const callbackQuery = update.callback_query;
  if (!callbackQuery) {
    // Webhook biasa (e.g. message update) tidak dikendalikan.
    return c.json({ ok: true, message: 'Webhook diterima (tiada callback)' });
  }

  // Ketepikan mesej yang dihantar oleh bot itu sendiri.
  if (callbackQuery.from && callbackQuery.from.is_bot) {
    return c.json({
      ok: false,
      error: 'bot tidak boleh menekan butang pada diri sendiri',
    });
  }

  const [action, idStr] = callbackQuery.data.split(':');

  if (action !== 'accept' || !idStr || isNaN(Number(idStr))) {
    // Maklum balas kepada tukang: pilihan tidak sah.
    try {
      await fetch(`${TELEGRAM_API_BASE}${c.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQuery.id, text: 'Pilihan tidak sah, sila cuba semula.' }),
      });
    } catch {
      // Jawapan Telegram gagal (mis. sudah luput) - abaikan.
    }
    return c.json({ ok: false, error: 'callback_data tidak sah' });
  }

  const bookingId = Number(idStr);

  const db = c.env.DB;
  const updateResult = await db
    .prepare(
      `UPDATE bookings SET status = ?, provider_name = ? WHERE id = ? AND status = ?`
    )
    .bind('ACCEPTED', callbackQuery.from.first_name, bookingId, 'PENDING')
    .run();

  if (updateResult.meta.changes_count === 0) {
    // Tempahan tidak dijumpai atau sudah diambil oleh tukang lain.
    try {
      await fetch(`${TELEGRAM_API_BASE}${c.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQuery.id, text: 'Job ini sudah diambil oleh tukang lain.' }),
      });
    } catch {
      // abaikan
    }
    return c.json({ ok: false, error: 'tempahan tidak dijumpai atau sudah diambil' });
  }

  // Notifikasi kepada kumpulan: job diterima.
  try {
    const acceptedRow = await db
      .prepare(
        'SELECT id, customer_name, phone, address, house_type, price, created_at ' +
          'FROM bookings WHERE id = ?'
      )
      .bind(bookingId)
      .first();

    if (acceptedRow) {
      const acceptMessage = [
        '✅ *JOB DITERIMA*',
        '',
        `👷 Tukang: ${callbackQuery.from.first_name}`,
        `🆔 ID Tempahan: ${acceptedRow.id}`,
        `👤 Pelanggan: ${acceptedRow.customer_name}`,
        `📞 Telefon: ${acceptedRow.phone}`,
        `💰 Harga: RM ${Number(acceptedRow.price).toFixed(2)}`,
        '',
        'Tukang diminta menghubungi pelanggan untuk menyepakati tarikh & masa.',
      ].join('\n');

      await fetch(`${TELEGRAM_API_BASE}${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: c.env.TELEGRAM_GROUP_ID,
          text: acceptMessage,
          parse_mode: 'HTML',
        }),
      }).then((response) => {
        if (!response.ok) {
          console.warn('[Telegram] Gagal hantar notifikasi penerimaan job:', response.status);
        }
      });
    }
  } catch (telegramError) {
    console.error('[Telegram] Gagal hantar notifikasi penerimaan:', telegramError);
  }

  return c.json({
    ok: true,
    message: `Job #${bookingId} diterima oleh ${callbackQuery.from.first_name}`,
  });
});

/**
 * GET /api/bookings
 *
 * Admin dashboard endpoint: mengembalikan senarai semua tempahan dari D1.
 */
app.get('/api/bookings', async (c) => {
  try {
    const rows = await c.env.DB
      .prepare(
        'SELECT id, customer_name, phone, address, house_type, price, status, provider_name, created_at ' +
          'FROM bookings ORDER BY created_at DESC'
      )
      .all();

    const bookings = rows.results.map((r) => ({
      id: Number(r.id),
      customer_name: r.customer_name,
      phone: r.phone,
      address: r.address,
      house_type: r.house_type,
      price: Number(r.price),
      status: r.status,
      provider_name: r.provider_name,
      created_at: r.created_at,
    }));

    return c.json({
      success: true,
      count: bookings.length,
      bookings,
    });
  } catch {
    console.error('[Bookings] Gagal memuat senarai tempahan');
    return c.json(err('Gagal memuat senarai tempahan', 500));
  }
});

// ============================================================================
// 5. ERROR HANDLERS
// ============================================================================

app.onError((err, c) => {
  console.error('[OnError]', err);
  return c.json(err('Ralat pelayan dalaman', 500));
});

app.notFound((c) => {
  return c.json(err('Endpoint tidak dijumpai', 404));
});

export default app;
