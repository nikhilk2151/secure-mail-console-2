import { connect } from 'cloudflare:sockets';

const TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
const MAX_RECIPIENTS_PER_BATCH = 50;
const SMTP_PORT = 465;
const SMTP_HOST = 'smtp.gmail.com';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);

        try {
            if (url.pathname === '/api/verify' && request.method === 'POST') {
                return await handleVerify(request);
            }

            if (url.pathname === '/api/send-batch' && request.method === 'POST') {
                return await handleSendBatch(request);
            }

            return new Response('API running', { headers: corsHeaders });

        } catch (err) {
            return jsonResponse({ success: false, message: err.message }, 500);
        }
    }
};

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
        }
    });
}

/* ---------------- HELPERS ---------------- */

function generateUUID() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function generateHexToken(length = 32) {
    const bytes = new Uint8Array(length / 2);
    crypto.getRandomValues(bytes);
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatRFC2822Date() {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = new Date();
    return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
           `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:` +
           `${String(d.getUTCSeconds()).padStart(2,'0')} +0000`;
}

/**
 * Encode text for quoted-printable transfer encoding
 * Needed for proper UTF-8 support and RFC compliance
 */
function encodeQuotedPrintable(str) {
    return str.replace(/[^\t\n\r\x20-\x7e]/g, (ch) => {
        const code = ch.charCodeAt(0);
        if (code < 256) {
            return '=' + code.toString(16).toUpperCase().padStart(2, '0');
        }
        // For multi-byte chars, encode each byte
        const buf = new TextEncoder().encode(ch);
        return [...buf].map(b => '=' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
    }).replace(/ $/gm, '=20'); // Trailing spaces must be encoded
}

/* ---------------- TURNSTILE ---------------- */

async function verifyTurnstile(token, ip) {
    if (!token) return false;

    const formData = new FormData();
    formData.append('secret', TURNSTILE_SECRET);
    formData.append('response', token);
    formData.append('remoteip', ip);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: formData
    });

    const data = await res.json();
    return data.success;
}

/* ---------------- VERIFY ---------------- */

async function handleVerify(request) {
    const { email, appPassword, cfToken } = await request.json();
    const ip = request.headers.get('CF-Connecting-IP');

    if (!email || !appPassword) {
        return jsonResponse({ success: false, message: "Missing credentials" }, 400);
    }

    const isHuman = await verifyTurnstile(cfToken, ip);
    if (!isHuman) {
        return jsonResponse({ success: false, message: "Spam check failed" }, 401);
    }

    const client = new SmtpClient(SMTP_HOST, SMTP_PORT);
    const result = await client.verifyAuth(email, appPassword);

    return result.success
        ? jsonResponse({ success: true })
        : jsonResponse({ success: false, message: result.error }, 401);
}

/* ---------------- SEND (INBOX-OPTIMIZED) ---------------- */

async function handleSendBatch(request) {
    const { email, appPassword, senderName, subject, messageBody, recipients, cfToken } = await request.json();
    const ip = request.headers.get('CF-Connecting-IP');

    if (!email || !appPassword || !recipients?.length) {
        return jsonResponse({ success: false, message: "Missing fields" }, 400);
    }

    if (recipients.length > MAX_RECIPIENTS_PER_BATCH) {
        return jsonResponse({ success: false, message: `Max ${MAX_RECIPIENTS_PER_BATCH} emails per batch` }, 400);
    }

    const isHuman = await verifyTurnstile(cfToken, ip);
    if (!isHuman) {
        return jsonResponse({ success: false, message: "Spam check failed" }, 401);
    }

    // Send emails SEQUENTIALLY — critical for inbox placement
    // Parallel sending triggers Gmail's anti-bulk detection
    let sent = 0;
    let failed = 0;
    const failedRecipients = [];
    const details = [];

    for (let i = 0; i < recipients.length; i++) {
        const to = recipients[i].trim();
        try {
            const client = new SmtpClient(SMTP_HOST, SMTP_PORT);
            const res = await client.sendMail(email, appPassword, to, subject, messageBody, senderName);
            if (!res.success) throw new Error(res.error || 'Failed');
            sent++;
            details.push({ recipient: to, success: true });
        } catch (err) {
            failed++;
            failedRecipients.push(to);
            details.push({ recipient: to, success: false, error: err.message });
        }

        // Stagger delay between emails (200-500ms random)
        // Mimics human sending cadence — prevents bulk pattern detection
        if (i < recipients.length - 1) {
            await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 300)));
        }
    }

    return jsonResponse({
        success: true,
        results: { sent, failed, failedRecipients, details }
    });
}

/* ================================================================
   SMTP CLIENT — INBOX-OPTIMIZED RAW SMTP IMPLEMENTATION
   ================================================================
   
   Key spam-bypass techniques used in the raw SMTP message:
   
   1. EHLO with sender's own domain (not generic "securemail")
   2. Proper RFC2822 header ordering (From, To, Date, Subject first)
   3. List-Unsubscribe + List-Unsubscribe-Post (Gmail requirement)
   4. Per-recipient unique Message-ID with sender's domain
   5. Per-recipient invisible content token (prevents bulk fingerprint)
   6. Feedback-ID for Gmail Postmaster Tools
   7. Auto-Submitted: no (signals manually composed email)
   8. X-Entity-Ref-ID (prevents message threading/grouping)
   9. Proper multipart/alternative with text/plain + text/html
   10. Clean minimal HTML that looks like a personal email
   11. Quoted-printable encoding for proper UTF-8 support
   ================================================================ */

class SmtpClient {
    constructor(host, port) {
        this.socket = connect({ hostname: host, port }, { secureTransport: 'on' });
        this.writer = this.socket.writable.getWriter();
        this.reader = this.socket.readable.getReader();
        this.decoder = new TextDecoder();
        this.encoder = new TextEncoder();
        this.buffer = '';
    }

    async readResponse() {
        let full = '';

        while (true) {
            const index = this.buffer.indexOf('\n');

            if (index !== -1) {
                const line = this.buffer.slice(0, index + 1);
                this.buffer = this.buffer.slice(index + 1);
                full += line;

                if (line[3] === ' ') return full.trim();
            } else {
                const { value, done } = await this.reader.read();
                if (value) this.buffer += this.decoder.decode(value);
                if (done) break;
            }
        }

        return full.trim();
    }

    async write(cmd) {
        await this.writer.write(this.encoder.encode(cmd + '\r\n'));
    }

    async verifyAuth(email, password) {
        try {
            await this.readResponse();

            // EHLO with the sender's domain — essential for SPF alignment
            const domain = email.split('@')[1] || 'gmail.com';
            await this.write(`EHLO ${domain}`);
            await this.readResponse();

            await this.write('AUTH LOGIN');
            await this.readResponse();

            await this.write(btoa(email));
            await this.readResponse();

            await this.write(btoa(password));
            const res = await this.readResponse();

            await this.write('QUIT');

            return res.startsWith('235')
                ? { success: true }
                : { success: false, error: res };

        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async sendMail(email, password, to, subject, body, senderName) {
        try {
            await this.readResponse();

            // EHLO with sender's actual domain — critical for SPF/DKIM alignment
            const senderDomain = email.split('@')[1] || 'gmail.com';
            await this.write(`EHLO ${senderDomain}`);
            await this.readResponse();

            await this.write('AUTH LOGIN');
            await this.readResponse();

            await this.write(btoa(email));
            await this.readResponse();

            await this.write(btoa(password));
            const auth = await this.readResponse();
            if (!auth.startsWith('235')) throw new Error(auth);

            await this.write(`MAIL FROM:<${email}>`);
            await this.readResponse();

            await this.write(`RCPT TO:<${to}>`);
            await this.readResponse();

            await this.write('DATA');
            await this.readResponse();

            // Generate unique identifiers per recipient
            const messageId = `<${generateUUID()}@${senderDomain}>`;
            const entityRefId = generateUUID();
            const uniqueToken = generateHexToken(32);
            const date = formatRFC2822Date();
            const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const cleanName = (senderName || '').replace(/"/g, '').trim();

            // Build clean HTML that mimics a personal 1-on-1 email
            const bodyHtml = body
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\n/g, '<br>');

            // Invisible unique token — prevents Gmail from fingerprinting as bulk
            const invisibleToken = `<span style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${uniqueToken}</span>`;

            const htmlBody = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title></title></head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;">
  ${invisibleToken}
  <div style="max-width:580px;margin:0 auto;padding:16px 20px;">${bodyHtml}</div>
</body></html>`;

            // Encode body content as quoted-printable for proper handling
            const qpTextBody = encodeQuotedPrintable(body);
            const qpHtmlBody = encodeQuotedPrintable(htmlBody);

            // Build RFC2822 compliant message with inbox-optimized headers
            // Header ordering matters — From/To/Date/Subject first matches legitimate clients
            const msg = [
                // === PRIMARY HEADERS (RFC2822 standard order) ===
                `From: "${cleanName}" <${email}>`,
                `To: ${to}`,
                `Date: ${date}`,
                `Subject: ${subject}`,
                `Reply-To: ${email}`,
                `Message-ID: ${messageId}`,

                // === MIME STRUCTURE ===
                `MIME-Version: 1.0`,
                `Content-Type: multipart/alternative; boundary="${boundary}"`,

                // === INBOX PLACEMENT HEADERS ===

                // Priority: Normal — high priority (1) triggers spam filters
                `X-Priority: 3`,
                `X-MSMail-Priority: Normal`,
                `Importance: Normal`,

                // List-Unsubscribe — Gmail REQUIRES this for bulk inbox delivery
                // mailto: form is the most trusted by all major providers
                `List-Unsubscribe: <mailto:${email}?subject=unsubscribe>`,
                `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,

                // Feedback-ID — enables Gmail Postmaster Tools reputation tracking
                `Feedback-ID: ${entityRefId}:${senderDomain}:campaign`,

                // Auto-Submitted: no — tells receiving MTA this is human-composed
                `Auto-Submitted: no`,

                // X-Entity-Ref-ID — unique per email, prevents grouping/threading
                `X-Entity-Ref-ID: ${entityRefId}`,

                // === MULTIPART BODY ===
                '',
                `--${boundary}`,
                `Content-Type: text/plain; charset=UTF-8`,
                `Content-Transfer-Encoding: quoted-printable`,
                '',
                qpTextBody,
                '',
                `--${boundary}`,
                `Content-Type: text/html; charset=UTF-8`,
                `Content-Transfer-Encoding: quoted-printable`,
                '',
                qpHtmlBody,
                '',
                `--${boundary}--`,
                '.',
                ''
            ].join('\r\n');

            await this.write(msg);

            const result = await this.readResponse();
            if (!result.startsWith('250')) throw new Error(result);

            await this.write('QUIT');

            return { success: true };

        } catch (e) {
            try { await this.write('QUIT'); } catch { }
            return { success: false, error: e.message };
        }
    }
}
