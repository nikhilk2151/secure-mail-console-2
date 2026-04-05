import { connect } from 'cloudflare:sockets';

const TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
const MAX_RECIPIENTS_PER_BATCH = 10;
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
        return jsonResponse({ success: false, message: "Max 10 emails per batch" }, 400);
    }

    const isHuman = await verifyTurnstile(cfToken, ip);
    if (!isHuman) {
        return jsonResponse({ success: false, message: "Spam check failed" }, 401);
    }

    let sent = 0;
    let failed = 0;

    // Reuse single SMTP connection for all recipients in batch
    const client = new SmtpClient(SMTP_HOST, SMTP_PORT);

    for (const to of recipients) {
        const result = await client.sendMail(email, appPassword, to, subject, messageBody, senderName);

        if (result.success) sent++;
        else {
            console.error(result.error);
            failed++;
        }

        // Minimal delay between emails (100ms) - enough for rate limiting without being excessive
        await new Promise(r => setTimeout(r, 100));
    }

    try { await client.write('QUIT'); } catch { }

    return jsonResponse({
        success: true,
        results: { sent, failed }
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

            const messageId = `<${Date.now()}@securemail>`;
            const date = new Date().toUTCString();

            const msg = [
                `From: "${senderName}" <${email}>`,
                `To: ${to}`,
                `Subject: ${subject}`,
                `Date: ${date}`,
                `Message-ID: ${messageId}`,
                `MIME-Version: 1.0`,
                `Content-Type: text/plain; charset=UTF-8`,
                `X-Mailer: SecureMailConsole`,
                '',
                body,
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
