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

/** Kadar baharu Grab-style: tapak + luas × tebal + zon, minima RM50. */
const BASE_FARE = 25;
const RATE_PER_M2 = 0.2;
const MIN_PRICE = 50;
const OFFER_WINDOW_SEC = 120;

const THICKNESS_MULT = { NIPIS: 1.0, SEDERHANA: 1.3, TEBAL: 1.6 };
const SUPPORTED_THICKNESS = Object.keys(THICKNESS_MULT);
const THICKNESS_LABEL = { NIPIS: 'Nipis', SEDERHANA: 'Sederhana', TEBAL: 'Lalang tebal' };

const ZONE_FEE = { PUTATAN: 0, KOTA_KINABALU: 5, PENAMPANG: 5, LAIN: 10 };
const SUPPORTED_ZONES = Object.keys(ZONE_FEE);

const CLEANUP_FEE_SMALL = 20; // < 150 m²
const CLEANUP_FEE_BIG = 30; // >= 150 m²

/**
 * Kira harga baharu.
 * @param {number} areaM2
 * @param {string} thickness
 * @param {string} zone
 * @param {boolean} cleanup
 */
function calcPrice(areaM2, thickness, zone, cleanup) {
  const base = BASE_FARE + areaM2 * RATE_PER_M2 * (THICKNESS_MULT[thickness] || 1.3) + (ZONE_FEE[zone] || 0);
  const floored = Math.max(MIN_PRICE, Math.round(base));
  const cleanupFee = cleanup ? (areaM2 >= 150 ? CLEANUP_FEE_BIG : CLEANUP_FEE_SMALL) : 0;
  return { price: floored + cleanupFee, base: Math.round(base) };
}

/** Normalisasi zon input kepada PUTATAN | KOTA_KINABALU | PENAMPANG | LAIN. */
function normalizeZone(input) {
  const z = String(input ?? 'PUTATAN').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (z === 'KK' || z === 'KOTA_KINABALU') return 'KOTA_KINABALU';
  if (SUPPORTED_ZONES.includes(z)) return z;
  return 'LAIN';
}

/** Digit terakhir nombor telefon untuk padanan WhatsApp (tanpa kod negara). */
function phoneTail(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.slice(-9);
}

/**
 * Cari tukang ACTIVE yang sepadan zon (atau SEMUA),rawak untuk keadilan.
 * @param {D1Database} db
 * @param {string} zone
 * @param {string|null} excludeTail digit telefon untuk dikecualikan
 */
async function getCandidates(db, zone, excludeTail = null) {
  const res = await db
    .prepare("SELECT id, full_name, phone, zones FROM providers WHERE status = 'ACTIVE' LIMIT 50")
    .all();
  const rows = res.results || [];
  const match = rows.filter((r) => {
    const zones = `,${String(r.zones || '').toUpperCase().replace(/\s+/g, '')},`;
    const hit =
      zones.includes(',SEMUA,') || zones.includes(`,${zone},`) || (zone === 'KOTA_KINABALU' && zones.includes(',KK,'));
    if (!hit) return false;
    if (excludeTail && phoneTail(r.phone) === excludeTail) return false;
    return true;
  });
  // Rawak untuk agihan adil
  for (let i = match.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [match[i], match[j]] = [match[j], match[i]];
  }
  return match.slice(0, 3);
}

const WHATSAPP_API_BASE = 'https://graph.facebook.com/v18.0';

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
    version: '1.1.0-area-pricing',
    endpoints: {
      booking: 'POST /api/booking',
      webhook: 'POST /api/bot/webhook',
      bookings: 'GET /api/bookings',
      chat: 'POST /api/chat',
      provider: 'POST /api/provider/register'
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
  /** @type {{ name: string, phone: string, address: string, houseType: string, zone: string, areaM2: number, thickness: string, cleanup: boolean }} */
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

  const db = c.env.DB;
  let price;
  let zone = normalizeZone(payload.zone);
  /** @type {number|null} */ let areaM2 = null;
  /** @type {string|null} */ let thickness = null;
  /** @type {number} */ let cleanup = 0;
  /** @type {string|null} */ let legacyHouseType = null;
  /** @type {string} */ let priceDesc;

  if (payload.areaM2 != null) {
    // --- Kadar baharu: ikut luas + tebal + zon + bersih (minima RM50) ---
    const area = Number(payload.areaM2);
    if (!Number.isFinite(area) || area < 5 || area > 5000) {
      return c.json(err('Luas kawasan tidak sah (5–5000 m²)', 400));
    }
    const th = String(payload.thickness ?? 'SEDERHANA').trim().toUpperCase();
    if (!SUPPORTED_THICKNESS.includes(th)) {
      return c.json(err('Ketebalan tidak sah (NIPIS / SEDERHANA / TEBAL)', 400));
    }
    const wantCleanup = payload.cleanup === true;
    const calc = calcPrice(area, th, zone, wantCleanup);
    price = calc.price;
    areaM2 = Math.round(area);
    thickness = th;
    cleanup = wantCleanup ? 1 : 0;
    priceDesc =
      `Luas ${areaM2}m² ${THICKNESS_LABEL[th]}${wantCleanup ? ' + Bersih&angkut' : ''} (${zone})` +
      (calc.base < MIN_PRICE ? ' — harga minima RM50' : '');
  } else {
    // --- Fallback lama: ikut jenis rumah (frontend lama) ---
    const normalizedHouseType = String(houseType).toUpperCase();
    if (!SUPPORTED_HOUSE_TYPES.includes(normalizedHouseType)) {
      return c.json(err('houseType tidak sah. Sila pilih TERES, SEMI_D atau BANGLO', 400));
    }
    legacyHouseType = normalizedHouseType;
    price = PRICE_MAP[legacyHouseType];
    priceDesc = `${legacyHouseType} (${HOUSE_TYPE_LABEL[legacyHouseType]})`;
  }

  // --- Simpan ke D1 ---
  const insertResult = await db
    .prepare(
      `INSERT INTO bookings (customer_name, phone, address, house_type, price, status, provider_name, zone, area_m2, thickness, cleanup)
       VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, ?, ?, ?, ?)`
    )
    .bind(
      name.trim(), phone.trim(), address.trim(), legacyHouseType || 'TERES', price,
      zone, areaM2, thickness, cleanup
    )
    .run();

  const bookingId = Number(insertResult.meta.last_row_id);

  // --- Auto-assign: tawar kepada tukang ACTIVE terdekat (zon sama dahulu) ---
  /** @type {string|null} */ let offeredName = null;
  /** @type {string|null} */ let offeredPhone = null;
  try {
    const candidates = await getCandidates(db, zone);
    if (candidates.length > 0) {
      const pick = candidates[0];
      offeredName = pick.full_name;
      offeredPhone = pick.phone;
      const expires = new Date(Date.now() + OFFER_WINDOW_SEC * 1000).toISOString();
      await db
        .prepare('UPDATE bookings SET assigned_provider = ?, assigned_phone = ?, offer_expires_at = ? WHERE id = ?')
        .bind(pick.full_name, pick.phone, expires, bookingId)
        .run();
    }
  } catch (e) {
    console.error('[AutoAssign] gagal:', e);
  }

  const insertedRow = await db
    .prepare(
      'SELECT id, customer_name, phone, address, house_type, price, status, provider_name, zone, area_m2, thickness, cleanup, assigned_provider, offer_expires_at, created_at ' +
        'FROM bookings WHERE id = ?'
    )
    .bind(bookingId)
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

  // --- Hantar notifikasi WhatsApp ---
  const messageLines = [
    '🌿 *JOB BARU: Potong Rumput* 🌿',
    '',
    `👤 *Pelanggan*: ${insertedRow.customer_name}`,
    `📞 *Telefon*: ${insertedRow.phone}`,
    `🏠 *Alamat*: ${insertedRow.address} (${insertedRow.zone})`,
    `🧾 *Butiran*: ${priceDesc}`,
    `💰 *Harga*: RM ${price.toFixed(2)}`,
    `🆔 *ID Tempahan*: ${insertedRow.id}`,
    `⏰ *Masa*: ${createdLocal}`,
    '',
  ];
  if (offeredName) {
    messageLines.push(
      `🎯 *Tawaran untuk*: ${offeredName} (2 minit — jika tiada respons, terbuka kepada semua)`,
      ''
    );
  }
  messageLines.push('Sila klik pautan WhatsApp di bawah untuk menerima job ini.');
  const message = messageLines.join('\n');

  // WhatsApp Cloud API message payload
  const whatsappBody = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: c.env.PROVIDER_WHATSAPP_NUMBER,
    type: 'text',
    text: {
      body: message + `\n\n👉 Terima job ini: https://wa.me/${c.env.PROVIDER_WHATSAPP_NUMBER}?text=Ambil+Job+${insertedRow.id}`
    }
  };

  try {
    await fetch(`${WHATSAPP_API_BASE}/${c.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${c.env.WHATSAPP_TOKEN}`
      },
      body: JSON.stringify(whatsappBody),
    }).then(async (response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `WhatsApp API error ${response.status}: ${response.statusText} (${text.slice(0, 200)})`
        );
      }
    });
  } catch (whatsappError) {
    // Gagal hantar notifikasi WhatsApp tidak membatalkan tempahan: log & teruskan (fail-open).
    console.error('[WhatsApp] Gagal hantar notifikasi:', whatsappError);
  }

  return c.json({
    success: true,
    booking: {
      id: insertedRow.id,
      customer_name: insertedRow.customer_name,
      phone: insertedRow.phone,
      address: insertedRow.address,
      zone: insertedRow.zone,
      area_m2: insertedRow.area_m2,
      thickness: insertedRow.thickness,
      cleanup: Number(insertedRow.cleanup) || 0,
      house_type: insertedRow.house_type,
      price: Number(insertedRow.price),
      status: insertedRow.status,
      provider_name: insertedRow.provider_name,
      assigned_provider: insertedRow.assigned_provider,
      offer_expires_at: insertedRow.offer_expires_at,
      created_at: insertedRow.created_at,
    },
  });
});

/**
 * POST /api/bot/webhook
 *
 * Mengendalikan mesej WhatsApp daripada tukang apabila menerima job.
 * Status ditukar ke ACCEPTED dan provider_name direkodkan.
 */
app.post('/api/bot/webhook', async (c) => {
  let payload;
  try {
    payload = JSON.parse(await c.req.raw.text());
  } catch {
    return c.json(err('Invalid JSON payload', 400));
  }

  // WhatsApp webhook payload: entry[].changes[].value.messages[]
  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages || [];
  const message = messages[0] || {};
  const from = message.from || '';
  const body = (message.text || message)?.body || '';

  if (!body || messages.length === 0) {
    return c.json({ ok: true, message: 'Webhook WhatsApp diterima (tiada mesej)' });
  }

  const idMatch = body.match(/(?:#|JOB\s+)(\d+)/i) || body.match(/(\d{1,10})/);
  const bookingIdStr = idMatch ? idMatch[1] : null;

  if (!bookingIdStr || isNaN(Number(bookingIdStr))) {
    try {
      await fetch(`${WHATSAPP_API_BASE}/${c.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.env.WHATSAPP_TOKEN}`
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: from,
          type: 'text',
          text: { body: 'Format mesej tidak dikenali. Sila balas dengan format: AMBIL JOB INI #<ID>' }
        })
      });
    } catch {
      // abaikan
    }
    return c.json({ ok: false, error: 'mesej WhatsApp tidak mengandungi ID tempahan' });
  }

  const bookingId = Number(bookingIdStr);

  const db = c.env.DB;

  // Tawaran eksklusif: dalam 2 minit pertama hanya tukang yang ditawarkan boleh ambil.
  try {
    const offerRow = await db
      .prepare('SELECT status, assigned_phone, offer_expires_at FROM bookings WHERE id = ?')
      .bind(bookingId)
      .first();
    if (offerRow && offerRow.status === 'PENDING' && offerRow.assigned_phone && offerRow.offer_expires_at) {
      const live = Date.parse(offerRow.offer_expires_at) > Date.now();
      if (live && phoneTail(offerRow.assigned_phone) !== phoneTail(from)) {
        try {
          await fetch(`${WHATSAPP_API_BASE}/${c.env.WHATSAPP_PHONE_ID}/messages`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${c.env.WHATSAPP_TOKEN}`
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: from,
              type: 'text',
              text: { body: 'Tawaran eksklusif untuk tukang terdekat dahulu (2 minit). Cuba lagi sebentar.' }
            })
          });
        } catch {
          // abaikan
        }
        return c.json({ ok: false, error: 'tawaran eksklusif masih hidup' });
      }
    }
  } catch {
    // Semakan tawaran gagal — teruskan cara lama (siapa cepat dia dapat).
  }

  const updateResult = await db
    .prepare(
      `UPDATE bookings SET status = ?, provider_name = ?, assigned_provider = NULL, assigned_phone = NULL, offer_expires_at = NULL WHERE id = ? AND status = ?`
    )
    .bind('ACCEPTED', from, bookingId, 'PENDING')
    .run();

  if (updateResult.meta.changes_count === 0) {
    try {
      await fetch(`${WHATSAPP_API_BASE}/${c.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.env.WHATSAPP_TOKEN}`
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: from,
          type: 'text',
          text: { body: `Job #${bookingId} sudah diambil oleh tukang lain.` }
        })
      });
    } catch {
      // abaikan
    }
    return c.json({ ok: false, error: 'tempahan tidak dijumpai atau sudah diambil' });
  }

  try {
    const acceptedRow = await db
      .prepare('SELECT id, customer_name, phone, address, house_type, price, created_at FROM bookings WHERE id = ?')
      .bind(bookingId)
      .first();

    if (acceptedRow) {
      const acceptMessage = [
        '✅ JOB DITERIMA',
        '',
        `👷 Tukang: ${from}`,
        `🆔 ID Tempahan: ${acceptedRow.id}`,
        `👤 Pelanggan: ${acceptedRow.customer_name}`,
        `📞 Telefon: ${acceptedRow.phone}`,
        `💰 Harga: RM ${Number(acceptedRow.price).toFixed(2)}`,
        '',
        'Sila hubungi pelanggan untuk menyepakati tarikh & masa.'
      ].join('\n');

      await fetch(`${WHATSAPP_API_BASE}/${c.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.env.WHATSAPP_TOKEN}`
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: c.env.PROVIDER_WHATSAPP_NUMBER,
          type: 'text',
          text: { body: acceptMessage }
        }),
      }).then((response) => {
        if (!response.ok) {
          console.warn('[WhatsApp] Gagal hantar notifikasi penerimaan job:', response.status);
        }
      });
    }
  } catch (whatsappError) {
    console.error('[WhatsApp] Gagal hantar notifikasi penerimaan:', whatsappError);
  }

  return c.json({
    ok: true,
    message: `Job #${bookingId} diterima oleh tukang (${from})`
  });
});

/**
 * POST /api/bookings/:id/reassign
 *
 * Tawar semula job yang tawarannya luput kepada tukang ACTIVE seterusnya.
 * Jika tiada calon, tawaran dibuka kepada semua.
 */
app.post('/api/bookings/:id/reassign', async (c) => {
  const id = Number(c.req.param('id'));
  if (!id) return c.json(err('ID tidak sah', 400));
  const db = c.env.DB;
  const row = await db
    .prepare('SELECT id, status, zone, customer_name, price, assigned_phone, offer_expires_at FROM bookings WHERE id = ?')
    .bind(id)
    .first();
  if (!row || row.status !== 'PENDING') {
    return c.json(err('Tempahan tidak pending', 404));
  }
  const expiresAt = row.offer_expires_at ? Date.parse(row.offer_expires_at) : 0;
  if (expiresAt > Date.now()) {
    return c.json({ success: true, message: 'Tawaran semasa masih hidup' });
  }
  const candidates = await getCandidates(db, row.zone, row.assigned_phone ? phoneTail(row.assigned_phone) : null);
  if (candidates.length === 0) {
    await db
      .prepare('UPDATE bookings SET assigned_provider = NULL, assigned_phone = NULL, offer_expires_at = NULL WHERE id = ?')
      .bind(id)
      .run();
    return c.json({ success: true, message: 'Dibuka kepada semua tukang' });
  }
  const pick = candidates[0];
  const expires = new Date(Date.now() + OFFER_WINDOW_SEC * 1000).toISOString();
  await db
    .prepare('UPDATE bookings SET assigned_provider = ?, assigned_phone = ?, offer_expires_at = ? WHERE id = ?')
    .bind(pick.full_name, pick.phone, expires, id)
    .run();
  try {
    await fetch(`${WHATSAPP_API_BASE}/${c.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${c.env.WHATSAPP_TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: c.env.PROVIDER_WHATSAPP_NUMBER,
        type: 'text',
        text: {
          body:
            `🔁 *TAWARAN SEMULA JOB #${id}*\n` +
            `🎯 Kepada: ${pick.full_name} (2 minit)\n` +
            `👤 ${row.customer_name} (${row.zone}) — RM ${Number(row.price).toFixed(2)}\n\n` +
            `Balas: AMBIL JOB INI #${id}`
        }
      }),
    });
  } catch (e) {
    console.error('[Reassign] WhatsApp gagal:', e);
  }
  return c.json({ success: true, message: `Ditawar semula kepada ${pick.full_name}` });
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
        'SELECT id, customer_name, phone, address, house_type, price, status, provider_name, zone, area_m2, thickness, cleanup, assigned_provider, offer_expires_at, created_at ' +
          'FROM bookings ORDER BY created_at DESC'
      )
      .all();

    const bookings = rows.results.map((r) => ({
      id: Number(r.id),
      customer_name: r.customer_name,
      phone: r.phone,
      address: r.address,
      house_type: r.house_type,
      zone: r.zone,
      area_m2: r.area_m2 != null ? Number(r.area_m2) : null,
      thickness: r.thickness,
      cleanup: r.cleanup != null ? Number(r.cleanup) : 0,
      price: Number(r.price),
      status: r.status,
      provider_name: r.provider_name,
      assigned_provider: r.assigned_provider,
      offer_expires_at: r.offer_expires_at,
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

/**
 * POST /api/provider/register
 *
 * Mendaftar tukang rumput baru ke dalam pangkalan data D1.
 */
app.post('/api/provider/register', async (c) => {
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(err('Bad request: fail JSON tidak sah', 400));
  }

  const { fullName, phone, icNumber, zones } = payload;

  if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
    return c.json(err('Nama penuh tukang tidak sah', 400));
  }

  if (!phone || typeof phone !== 'string' || !/^\d{9,15}$/.test(phone.replace(/\D/g, ''))) {
    return c.json(err('Nombor WhatsApp tidak sah', 400));
  }

  if (!zones || typeof zones !== 'string' || zones.trim().length < 2) {
    return c.json(err('Kawasan liputan (zones) diperlukan', 400));
  }

  const db = c.env.DB;
  try {
    const result = await db
      .prepare(
        'INSERT INTO providers (full_name, phone, ic_number, zones, status) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(
        fullName.trim(),
        phone.trim(),
        icNumber ? String(icNumber).trim() : '',
        zones.trim(),
        'PENDING_APPROVAL'
      )
      .run();

    const newRow = await db
      .prepare('SELECT id, full_name, phone, zones, status, created_at FROM providers WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first();

    // Notifikasi WhatsApp ke admin (provider number)
    const notifyMsg = [
      '👷 *PENDAFTARAN TUKANG BARU* 👷',
      '',
      `NAMA: ${newRow.full_name}`,
      `TELEFON: ${newRow.phone}`,
      `IC/LESEN: ${newRow.ic_number || '- TIDAK DISERTAKAN -'}`,
      `ZON: ${newRow.zones}`,
      `STATUS: PENDING_APPROVAL`,
      `MASA: ${new Date(newRow.created_at).toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' })}`,
      '',
      'Sila semak dan aktifkan akaun jika layak.'
    ].join('\n');

    try {
      await fetch(`${WHATSAPP_API_BASE}/${c.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.env.WHATSAPP_TOKEN}`
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: c.env.PROVIDER_WHATSAPP_NUMBER,
          type: 'text',
          text: { body: notifyMsg }
        }),
      });
    } catch (notifyErr) {
      console.error('[WhatsApp] Gagal hantar notifikasi pendaftaran:', notifyErr);
    }

    return c.json({
      success: true,
      message: 'Pendaftaran berjaya! Pihak admin akan menyemak dan mengaktifkan akaun WhatsApp anda dalam masa 24 jam.',
      provider: {
        id: newRow.id,
        full_name: newRow.full_name,
        phone: newRow.phone,
        zones: newRow.zones,
        status: newRow.status,
        created_at: newRow.created_at
      }
    });
  } catch (dbErr) {
    console.error('[Provider] Gagal menyimpan:', dbErr);
    // Jika ralat UNIQUE constraint pada telefon
    if (String(dbErr).includes('UNIQUE') || String(dbErr).includes('constraint')) {
      return c.json(err('Nombor telefon ini sudah didaftarkan', 409));
    }
    return c.json(err('Gagal menyimpan pendaftaran', 500));
  }
});

/**
 * POST /api/chat
 *
 * Pembantu Maya Potong Rumput menggunakan Cloudflare Workers AI.
 */
app.post('/api/chat', async (c) => {
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(err('Bad request: fail JSON tidak sah', 400));
  }

  const userMessage = payload?.message;
  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length < 1) {
    return c.json(err('Mesej tidak dibenarkan', 400));
  }

  try {
    const ai = c.env.AI;
    const systemPrompt = `Anda adalah Pembantu Maya Potong Rumput Sabah — mesra, santai, ringkas, profesional. Kawasan servis: Putatan, Penampang, Kota Kinabalu. Harga: minima RM50. Formula: RM25 tapak + RM0.20 setiap m² × tebal (Nipis ×1.0, Sederhana ×1.3, Lalang tebal ×1.6) + caj zon (Putatan RM0, KK/Penampang RM5, lain RM10) + caj bersih&angkut (RM20 bawah 150m², RM30 ke atas, jika diminta). Jawab dalam Bahasa Melayu atau Inggeris mengikut soalan pengguna.`;

    const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage.trim() }
      ]
    });

    const reply = response?.response || response?.message || JSON.stringify(response);
    return c.json({ reply: String(reply).trim() });
  } catch (aiErr) {
    console.error('[AI] Gagal menjana respons:', aiErr);
    return c.json(err('Pembantu maya sedang sibuk. Sila cuba semula sebentar.', 503));
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
