// ==================================================
// NAMA ENDPOINT : /api/amprem
// FUNGSI        : send-magiclink, verify-account, apply-premium
// METHOD        : GET + POST
// EMAIL         : Resend API (fetch)
// DATABASE      : In-memory
// ==================================================

const crypto = require('crypto');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_API_URL = 'https://api.resend.com/emails';
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'onboarding@resend.dev';
const SENDER_NAME = process.env.SENDER_NAME || 'AXoNa-1';

const PREMIUM_DURATION_DAYS = 365;
const MAGIC_LINK_EXPIRY_MINUTES = 30;
const XYLO_API_URL = 'https://xyloapi.qzz.io/api/info/verify-email';

const users = new Map();

function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function now() { return new Date(); }
function addMinutes(date, m) { return new Date(date.getTime() + m * 60 * 1000); }
function addDays(date, d) { return new Date(date.getTime() + d * 24 * 60 * 60 * 1000); }

function jsonResponse(res, code, payload) {
  res.status(code).json(payload);
}

function parseBody(req) {
  if (req.method === 'POST') return req.body || {};
  return req.query || {};
}

async function validateEmailWithXoba(email) {
  try {
    const url = `${XYLO_API_URL}?email=${encodeURIComponent(email)}`;
    const response = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
    if (!response.ok) return { valid: false, reason: `HTTP ${response.status}` };
    const json = await response.json();
    const apiSuccess = json.success === true;
    const data = json.data || {};
    const isValid = data.is_valid === true;
    const status = (data.status || '').toString().toUpperCase();
    return { valid: apiSuccess && isValid && status === 'VALID', status, email: data.email || email };
  } catch (err) {
    return { valid: false, reason: 'Validation failed: ' + err.message };
  }
}

async function sendMagicLink(email) {
  if (!email || !isValidEmail(email)) return { success: false, message: 'Format email tidak valid' };

  const normalizedEmail = email.toLowerCase().trim();
  const validation = await validateEmailWithXoba(normalizedEmail);

  if (!validation.valid) {
    return { success: false, message: 'Email tidak valid', detail: validation.status || validation.reason || 'unknown' };
  }

  let user = users.get(normalizedEmail);
  if (user && user.isPremium && user.premiumExpiresAt) {
    const expiry = new Date(user.premiumExpiresAt);
    if (expiry > now()) {
      return { success: false, message: 'Akun sudah premium aktif sampai ' + expiry.toISOString(), isPremium: true, premiumExpiresAt: user.premiumExpiresAt };
    }
  }

  const token = generateToken(32);
  const tokenExpiry = addMinutes(now(), MAGIC_LINK_EXPIRY_MINUTES);
  const baseUrl = process.env.BASE_URL || 'https://your-app.vercel.app';
  const magicLink = `${baseUrl}/api/amprem?action=verify-account&token=${token}&email=${encodeURIComponent(normalizedEmail)}`;

  if (!user) {
    user = { email: normalizedEmail, isPremium: false, premiumExpiresAt: null, createdAt: now().toISOString() };
  }
  user.magicToken = token;
  user.magicTokenExpiry = tokenExpiry.toISOString();
  users.set(normalizedEmail, user);

  try {
    const emailResponse = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
        to: normalizedEmail,
        subject: 'Magic Link Aktivasi Premium Alight Motion',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; background: #0a0a0f; color: #e8e8f0; border-radius: 12px;">
            <h2 style="color: #ff4d6d; margin-bottom: 8px;">AXoNa-1</h2>
            <p style="color: #8888a0; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 24px;">Alight Motion Premium</p>
            <p>Halo,</p>
            <p>Klik link di bawah untuk verifikasi akun dan mengaktifkan premium 1 tahun:</p>
            <p style="text-align: center; margin: 32px 0;">
              <a href="${magicLink}" style="background: linear-gradient(135deg, #ff4d6d, #ff2d55); color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block;">VERIFIKASI SEKARANG</a>
            </p>
            <p style="color: #8888a0; font-size: 12px;">Atau salin link ini ke browser:</p>
            <p style="background: #1a1a26; padding: 12px; border-radius: 8px; word-break: break-all; font-size: 12px; color: #ff8fa3;">${magicLink}</p>
            <p style="color: #8888a0; font-size: 12px; margin-top: 24px;">Link berlaku ${MAGIC_LINK_EXPIRY_MINUTES} menit.</p>
          </div>
        `
      })
    });

    if (!emailResponse.ok) {
      const errText = await emailResponse.text();
      return { success: false, message: 'Gagal kirim email: ' + emailResponse.status + ' ' + errText };
    }
  } catch (err) {
    return { success: false, message: 'Gagal kirim email: ' + err.message };
  }

  return {
    success: true,
    message: 'Magic link terkirim ke email',
    email: normalizedEmail,
    validation: validation.status || 'VALID',
    expiresAt: tokenExpiry.toISOString()
  };
}

async function verifyAccount(email, token) {
  if (!email || !token) return { success: false, message: 'Email dan token wajib diisi' };

  const normalizedEmail = email.toLowerCase().trim();
  const user = users.get(normalizedEmail);

  if (!user) return { success: false, message: 'User tidak ditemukan' };
  if (user.magicToken !== token) return { success: false, message: 'Token tidak valid' };
  if (!user.magicTokenExpiry || new Date(user.magicTokenExpiry) < now()) return { success: false, message: 'Token sudah kedaluwarsa' };

  const idToken = generateToken(48);
  const idTokenExpiry = addMinutes(now(), 60);

  user.idToken = idToken;
  user.idTokenExpiry = idTokenExpiry.toISOString();
  user.verifiedAt = now().toISOString();
  user.magicToken = null;
  user.magicTokenExpiry = null;
  users.set(normalizedEmail, user);

  return { success: true, message: 'Verifikasi berhasil', email: normalizedEmail, idToken, idTokenExpiresAt: idTokenExpiry.toISOString() };
}

async function applyPremium(email, idToken) {
  if (!email || !idToken) return { success: false, message: 'Email dan idToken wajib diisi' };

  const normalizedEmail = email.toLowerCase().trim();
  const user = users.get(normalizedEmail);

  if (!user) return { success: false, message: 'User tidak ditemukan' };
  if (user.idToken !== idToken) return { success: false, message: 'idToken tidak valid' };
  if (!user.idTokenExpiry || new Date(user.idTokenExpiry) < now()) return { success: false, message: 'idToken sudah kedaluwarsa' };

  const premiumExpiresAt = addDays(now(), PREMIUM_DURATION_DAYS);
  const alightAccountId = user.alightAccountId || ('AL_' + crypto.createHash('md5').update(normalizedEmail).digest('hex').substring(0, 16).toUpperCase());

  user.isPremium = true;
  user.premiumExpiresAt = premiumExpiresAt.toISOString();
  user.activatedAt = now().toISOString();
  user.alightAccountId = alightAccountId;
  user.idToken = null;
  user.idTokenExpiry = null;
  users.set(normalizedEmail, user);

  return {
    success: true,
    message: 'Premium berhasil diaktifkan',
    email: normalizedEmail,
    isPremium: true,
    premiumExpiresAt: premiumExpiresAt.toISOString(),
    alightAccountId,
    durationDays: PREMIUM_DURATION_DAYS
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return jsonResponse(res, 405, { success: false, message: 'Method tidak diizinkan' });

  try {
    const body = parseBody(req);
    const action = body.action;

    if (!action) return jsonResponse(res, 400, { success: false, message: 'Parameter "action" wajib diisi' });

    let result;

    switch (action) {
      case 'send-magiclink': result = await sendMagicLink(body.email); break;
      case 'verify-account': result = await verifyAccount(body.email, body.token || body.rawLink); break;
      case 'apply-premium': result = await applyPremium(body.email, body.idToken); break;
      default: return jsonResponse(res, 400, { success: false, message: 'Action tidak dikenal' });
    }

    if (req.method === 'GET' && action === 'verify-account' && result.success) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><title>Verifikasi Berhasil</title></head>
        <body style="font-family: Arial; background: #0a0a0f; color: #e8e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0;">
          <div style="text-align: center; padding: 40px; background: #1a1a26; border-radius: 16px; max-width: 480px;">
            <h1 style="color: #4ade80;">Verifikasi Berhasil</h1>
            <p>Email <strong>${result.email}</strong> sudah terverifikasi.</p>
            <p style="color: #8888a0; font-size: 12px;">idToken: <code style="word-break: break-all;">${result.idToken}</code></p>
          </div>
        </body>
        </html>
      `);
    }

    return jsonResponse(res, result.success ? 200 : 400, result);
  } catch (err) {
    console.error('Handler error:', err);
    return jsonResponse(res, 500, { success: false, message: 'Terjadi kesalahan: ' + err.message });
  }
};
