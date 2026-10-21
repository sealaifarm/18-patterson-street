// Vercel serverless function: POST /api/contact
// Sends (1) a full inquiry email to the team and (2) a confirmation to the visitor via Resend.
// Runs on the server only, so the API key is never exposed to the browser.
//
// API key: set RESEND_API_KEY in Vercel > Project > Settings > Environment Variables (never commit it).
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// SETTINGS: edit the values below.
const CONTACT_TO = '';       // Inbox that receives inquiries, e.g. 'inquiries@yourdomain.com'
const CONTACT_FROM = '';     // Verified Resend sender, e.g. '18 Patterson Street <inquiries@yourdomain.com>'
const SITE_URL = '';         // Optional. Public site URL, e.g. 'https://yourdomain.com'
const SHOW_ERROR_DETAILS = false; // true while testing: returns Resend's error reason to the browser

const BRAND = '18 Patterson Street';
const ADDRESS = '18 Patterson Street, Dorchester, MA 02124';
const ACCENT = '#007cbc';
const INTERESTS = ['Residence 1', 'Residence 2'];

/* ---------- helpers ---------- */

const esc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Single line, no control characters (prevents header injection in subjects)
const oneLine = (s = '') => String(s).replace(/[\r\n\t\u0000-\u001f]+/g, ' ').trim();

const multiline = s => esc(s).replace(/\r?\n/g, '<br>');

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

const formatDate = () =>
  new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/New_York'
  }).format(new Date()) + ' ET';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Best-effort throttle per IP. Serverless instances do not share memory, so this only
// slows down simple abuse (the confirmation email must not be usable to spam third parties).
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 1000) {
    for (const [key, times] of hits) {
      if (times.every(t => now - t >= WINDOW_MS)) hits.delete(key);
    }
  }
  return false;
}

const clientIp = req =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  (req.socket && req.socket.remoteAddress) ||
  'unknown';

/* ---------- email layout ---------- */

const FONT_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_SERIF = "Georgia, 'Times New Roman', Times, serif";

function row(label, valueHtml) {
  return `
          <tr>
            <td class="divider" style="padding:22px 0;border-top:1px solid #e8e8e8;">
              <div class="t-muted" style="font-family:${FONT_SANS};font-size:11px;line-height:16px;letter-spacing:0.14em;text-transform:uppercase;color:#8c8c8c;">${esc(label)}</div>
              <div class="t-main" style="font-family:${FONT_SANS};font-size:15px;line-height:24px;color:#1a1a1a;padding-top:6px;word-break:break-word;">${valueHtml}</div>
            </td>
          </tr>`;
}

function layout({ preheader, heading, intro, rows = [], closing = '' }) {
  const rowsHtml = rows.map(r => row(r.label, r.html)).join('');
  const closingHtml = closing
    ? `<tr><td class="t-body" style="padding:32px 0 0;font-family:${FONT_SANS};font-size:15px;line-height:26px;color:#4a4a4a;">${closing}</td></tr>`
    : '';
  const wordmark = `<span class="t-main" style="font-family:${FONT_SERIF};font-size:22px;line-height:28px;color:#1a1a1a;">${esc(BRAND)}</span><br><span class="t-muted" style="font-family:${FONT_SANS};font-size:10px;line-height:16px;letter-spacing:0.28em;text-transform:uppercase;color:#8c8c8c;">Dorchester</span>`;
  const header = SITE_URL
    ? `<a href="${esc(SITE_URL)}" target="_blank" style="text-decoration:none;">${wordmark}</a>`
    : wordmark;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${esc(BRAND)}</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body { margin:0; padding:0; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
    a { color:${ACCENT}; }
    @media only screen and (max-width:600px) {
      .outer { padding:32px 20px 40px !important; }
      .heading { font-size:22px !important; line-height:30px !important; }
    }
    /* Dark mode: Apple Mail, iOS Mail, Outlook for Mac and other clients that honor prefers-color-scheme */
    @media (prefers-color-scheme: dark) {
      body, .bg { background-color:#0f0f0f !important; }
      .t-main { color:#f5f5f5 !important; }
      .link { color:#5cc0ee !important; }
      .t-body { color:#c4c4c4 !important; }
      .t-muted { color:#8f8f8f !important; }
      .divider { border-color:#2b2b2b !important; }
    }
    /* Dark mode: Outlook.com and Outlook apps */
    [data-ogsb] body, [data-ogsb] .bg { background-color:#0f0f0f !important; }
    [data-ogsc] .t-main { color:#f5f5f5 !important; }
    [data-ogsc] .link { color:#5cc0ee !important; }
    [data-ogsc] .t-body { color:#c4c4c4 !important; }
    [data-ogsc] .t-muted { color:#8f8f8f !important; }
    [data-ogsc] .divider { border-color:#2b2b2b !important; }
  </style>
</head>
<body class="bg" style="margin:0;padding:0;background-color:#ffffff;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(preheader)}&#8203;&zwnj;&#8203;&zwnj;&#8203;&zwnj;</div>
  <table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;">
    <tr>
      <td align="center" class="outer bg" style="padding:56px 24px 64px;background-color:#ffffff;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
          <tr>
            <td align="left" style="padding:0 0 44px;">${header}</td>
          </tr>
          <tr>
            <td class="heading t-main" style="font-family:${FONT_SERIF};font-size:26px;line-height:34px;font-weight:normal;color:#1a1a1a;padding:0 0 14px;">${heading}</td>
          </tr>
          <tr>
            <td class="t-body" style="font-family:${FONT_SANS};font-size:15px;line-height:26px;color:#4a4a4a;padding:0 0 36px;">${intro}</td>
          </tr>${rowsHtml}${rows.length ? `
          <tr><td class="divider" style="border-top:1px solid #e8e8e8;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr>` : ''}${closingHtml}
          <tr>
            <td class="t-muted" style="padding:48px 0 0;font-family:${FONT_SANS};font-size:12px;line-height:20px;color:#8c8c8c;">
              ${esc(BRAND)}<br>${esc(ADDRESS)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ---------- the two emails ---------- */

function companyEmail({ name, email, interest, message, submittedAt }) {
  const html = layout({
    preheader: `New inquiry from ${name} about ${interest}.`,
    heading: 'New website inquiry',
    intro: 'A new message was submitted through the contact form. You can reply directly to this email to respond to the sender.',
    rows: [
      { label: 'Name', html: esc(name) },
      { label: 'Email', html: `<a class="link" href="mailto:${esc(email)}" style="color:${ACCENT};text-decoration:underline;">${esc(email)}</a>` },
      { label: 'Interest', html: esc(interest) },
      { label: 'Message', html: multiline(message) },
      { label: 'Submitted', html: esc(submittedAt) }
    ]
  });

  const text = [
    'NEW WEBSITE INQUIRY',
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    `Interest: ${interest}`,
    `Message: ${message}`,
    `Submitted: ${submittedAt}`,
    '',
    'Reply directly to this email to respond to the sender.'
  ].join('\n');

  return { html, text };
}

function customerEmail({ name, interest, message }) {
  const firstName = name.split(/\s+/)[0];
  const rows = [];
  if (interest !== 'General') rows.push({ label: 'Interest', html: esc(interest) });
  rows.push({ label: 'Your message', html: multiline(message) });

  const html = layout({
    preheader: 'We received your message and will be in touch soon.',
    heading: `Hello ${esc(firstName)},`,
    intro: 'Thank you for your interest in 18 Patterson Street. We have received your message and a member of our team will be in touch soon with pricing, availability, and private viewing details.',
    rows,
    closing: `Warm regards,<br>${esc(BRAND)}`
  });

  const text = [
    `Hello ${firstName},`,
    '',
    'Thank you for your interest in 18 Patterson Street. We have received your message and a member of our team will be in touch soon with pricing, availability, and private viewing details.',
    '',
    ...(interest !== 'General' ? [`Interest: ${interest}`] : []),
    `Your message: ${message}`,
    '',
    'Warm regards,',
    BRAND,
    ADDRESS
  ].join('\n');

  return { html, text };
}

/* ---------- Resend ---------- */

async function sendWithResend(payload, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  // Resend allows 2 requests per second by default; wait and retry if we hit the limit
  if (res.status === 429 && attempt < 3) {
    await sleep(1100);
    return sendWithResend(payload, attempt + 1);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
  return res.json();
}

/* ---------- handler ---------- */

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const missing = Object.entries({ RESEND_API_KEY, CONTACT_TO, CONTACT_FROM }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('Missing RESEND_API_KEY env var or settings at the top of api/contact.js:', missing.join(', '));
    return res.status(500).json({ success: false, error: 'Email service is not configured' });
  }

  // Body may arrive parsed (JSON) or as a string
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  // Honeypot: pretend success so bots learn nothing
  if (body.botcheck && body.botcheck !== 'false') {
    return res.status(200).json({ success: true });
  }

  if (rateLimited(clientIp(req))) {
    return res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
  }

  const name = oneLine(body.name).slice(0, 120);
  const email = oneLine(body.email).slice(0, 254);
  const message = String(body.message || '').trim().slice(0, 5000);
  const interest = INTERESTS.includes(oneLine(body.interest)) ? oneLine(body.interest) : 'General';

  if (!name) return res.status(400).json({ success: false, field: 'name', error: 'Please enter your name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, field: 'email', error: 'A valid email address is required.' });
  if (!message) return res.status(400).json({ success: false, field: 'message', error: 'Please enter a message.' });

  const submittedAt = formatDate();

  try {
    // 1. Team notification (reply goes straight to the visitor)
    const company = companyEmail({ name, email, interest, message, submittedAt });
    await sendWithResend({
      from: CONTACT_FROM,
      to: [CONTACT_TO],
      reply_to: email,
      subject: `New inquiry: ${interest} from ${name}`,
      html: company.html,
      text: company.text
    });
  } catch (err) {
    console.error('Company email failed:', err);
    const out = { success: false, error: 'Unable to send message' };
    // Resend's reason (e.g. unverified domain), only while testing
    if (SHOW_ERROR_DETAILS) out.detail = String(err.message || err);
    return res.status(502).json(out);
  }

  // 2. Visitor confirmation (a failure here must not fail the submission)
  let confirmation = true;
  try {
    const customer = customerEmail({ name, interest, message });
    await sendWithResend({
      from: CONTACT_FROM,
      to: [email],
      reply_to: CONTACT_TO,
      subject: 'We received your message',
      html: customer.html,
      text: customer.text
    });
  } catch (err) {
    confirmation = false;
    console.error('Customer confirmation failed:', err);
  }

  return res.status(200).json({ success: true, confirmation });
};
