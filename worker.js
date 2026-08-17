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

function formatRFC2822Date() {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = new Date();
    return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
           `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:` +
           `${String(d.getUTCSeconds()).padStart(2,'0')} +0000`;
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

/* ---------------- SEND ---------------- */

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

    const results = await Promise.allSettled(
        recipients.map(async (to) => {
            const client = new SmtpClient(SMTP_HOST, SMTP_PORT);
            const res = await client.sendMail(email, appPassword, to, subject, messageBody, senderName);
            if (!res.success) throw new Error(res.error || 'Failed');
            return { success: true, recipient: to };
        })
    );

    let sent = 0;
    let failed = 0;
    const failedRecipients = [];
    const details = [];

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const recipient = recipients[i];
        if (result.status === 'fulfilled' && result.value.success) {
            sent++;
            details.push({ recipient, success: true });
        } else {
            const errMsg = result.status === 'fulfilled' ? result.value.error : result.reason?.message;
            failed++;
            failedRecipients.push(recipient);
            details.push({ recipient, success: false, error: errMsg });
        }
    }

    return jsonResponse({
        success: true,
        results: { sent, failed, failedRecipients, details }
    });
}

/* ---------------- SMTP CLIENT ---------------- */

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

            await this.write('EHLO test');
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

            await this.write('EHLO securemail');
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

            const senderDomain = email.split('@')[1] || 'gmail.com';
            const messageId = `<${generateUUID()}@${senderDomain}>`;
            const date = formatRFC2822Date();
            const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

            const bodyHtml = body
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\n/g, '<br>');

            const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222222;margin:0;padding:20px;background-color:#ffffff;">
  <div style="max-width:600px;margin:0 auto;">${bodyHtml}</div>
</body></html>`;

            const msg = [
                `From: "${senderName.replace(/"/g, '')}" <${email}>`,
                `To: ${to}`,
                `Reply-To: ${email}`,
                `Subject: ${subject}`,
                `Date: ${date}`,
                `Message-ID: ${messageId}`,
                `MIME-Version: 1.0`,
                `Content-Type: multipart/alternative; boundary="${boundary}"`,
                `X-Priority: 3`,
                `Importance: normal`,
                '',
                `--${boundary}`,
                `Content-Type: text/plain; charset=UTF-8`,
                `Content-Transfer-Encoding: quoted-printable`,
                '',
                body,
                '',
                `--${boundary}`,
                `Content-Type: text/html; charset=UTF-8`,
                `Content-Transfer-Encoding: quoted-printable`,
                '',
                htmlBody,
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
