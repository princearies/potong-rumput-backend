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
    version: '1.0.0',
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

  // --- Hantar notifikasi WhatsApp ---
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
    'Sila klik pautan WhatsApp di bawah untuk menerima job ini.',
  ].join('\n');

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
  const updateResult = await db
    .prepare(
      `UPDATE bookings SET status = ?, provider_name = ? WHERE id = ? AND status = ?`
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
    const systemPrompt = `Anda adalah Pembantu Maya Potong Rumput Sabah — mesra, santai, ringkas, profesional. Kawasan servis: Putatan, Penampang, Kota Kinabalu. Harga: TERES (RM40), SEMI_D (RM70), BANGLO (RM120). Jawab dalam Bahasa Melayu atau Inggeris mengikut soalan pengguna.`;

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
