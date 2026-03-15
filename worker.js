import { connect } from 'cloudflare:sockets';

// --- CONFIGURATION ---
const TURNSTILE_SECRET = '1x0000000000000000000000000000000AA'; // Test secret key (always passes). Replace with real secret.
const MAX_RECIPIENTS_PER_BATCH = 10;
const SMTP_PORT = 465;
const SMTP_HOST = 'smtp.gmail.com';

// CORS Headers
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
    async fetch(request, env, ctx) {
        // Handle CORS Preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);

        if (request.method === 'POST') {
            try {
                if (url.pathname === '/api/verify') {
                    return await handleVerify(request, env);
                }
                if (url.pathname === '/api/send-batch') {
                    return await handleSendBatch(request, env);
                }
            } catch (err) {
                return jsonResponse({ success: false, message: err.message }, 500);
            }
        }

        // Static files fallback (if this worker also serves pages, though usually Pages does that)
        return new Response('Secure Mail Console - API Endpoints: /api/verify | /api/send-batch', { headers: corsHeaders });
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

// --- CLOUDFLARE TURNSTILE ---
async function verifyTurnstile(token, ip) {
    if (!token) return false;
    
    let formData = new FormData();
    formData.append('secret', TURNSTILE_SECRET);
    formData.append('response', token);
    formData.append('remoteip', ip);

    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        body: formData,
        method: 'POST',
    });

    const outcome = await result.json();
    return outcome.success;
}

// --- HANDLERS ---

async function handleVerify(request, env) {
    const body = await request.json();
    const { email, appPassword, cfToken } = body;
    const ip = request.headers.get('CF-Connecting-IP');

    if (!email || !appPassword) {
        return jsonResponse({ success: false, message: "Email and App Password required" }, 400);
    }

    // SPAM PREVENTION: Verify Turnstile
    const isHuman = await verifyTurnstile(cfToken, ip);
    if (!isHuman) {
        return jsonResponse({ success: false, message: "Spam protection check failed. Please refresh." }, 401);
    }

    // Verify SMTP connection by doing a dry-run auth
    const client = new SmtpClient(SMTP_HOST, SMTP_PORT);
    const authResult = await client.verifyAuth(email, appPassword);
    
    if (authResult.success) {
        return jsonResponse({ success: true, message: "SMTP verified successfully" });
    } else {
        return jsonResponse({ success: false, message: authResult.error }, 401);
    }
}

async function handleSendBatch(request, env) {
    const body = await request.json();
    const { email, appPassword, senderName, subject, messageBody, recipients, cfToken } = body;
    const ip = request.headers.get('CF-Connecting-IP');

    if (!email || !appPassword || !recipients || !Array.isArray(recipients)) {
        return jsonResponse({ success: false, message: "Missing required fields" }, 400);
    }

    // SPAM PREVENTION: Batch limit
    if (recipients.length > MAX_RECIPIENTS_PER_BATCH) {
        return jsonResponse({ success: false, message: `Batch too large. Max allowed: ${MAX_RECIPIENTS_PER_BATCH}` }, 400);
    }

    // SPAM PREVENTION: Verify Turnstile again for sending
    const isHuman = await verifyTurnstile(cfToken, ip);
    if (!isHuman) {
        return jsonResponse({ success: false, message: "Spam check failed." }, 401);
    }

    let sent = 0;
    let failed = 0;

    // Send emails sequentially in this batch
    for (const recipient of recipients) {
        const client = new SmtpClient(SMTP_HOST, SMTP_PORT);
        const result = await client.sendMail(email, appPassword, recipient, subject, messageBody, senderName);
        if (result.success) {
            sent++;
        } else {
            console.error(`Failed to send to ${recipient}: ${result.error}`);
            failed++;
        }
        // Small delay between emails in the same batch
        await new Promise(r => setTimeout(r, 500));
    }

    return jsonResponse({
        success: true,
        message: "Batch processed",
        results: { sent, failed }
    });
}

// --- SMTP CLIENT USING CLOUDFLARE SOCKETS ---
class SmtpClient {
    constructor(host, port) {
        // connect() uses Implicit TLS if secureTransport: 'on' (typical for port 465)
        this.socket = connect({ hostname: host, port: port }, { secureTransport: 'on' });
        this.writer = this.socket.writable.getWriter();
        this.reader = this.socket.readable.getReader();
        this.decoder = new TextDecoder();
        this.encoder = new TextEncoder();
        this.buffer = '';
    }

    async readResponse() {
        let fullResponse = '';
        while (true) {
            const index = this.buffer.indexOf('\n');
            if (index !== -1) {
                // Return up to the newline
                const line = this.buffer.slice(0, index + 1);
                this.buffer = this.buffer.slice(index + 1); // remove line from buffer
                fullResponse += line;
                
                if (line.length >= 4 && line[3] === ' ') {
                    // It's the final line of the response
                    return fullResponse.trim();
                } else if (line.length >= 4 && line[3] === '-') {
                    // Multiline response continues. Wait for next line.
                    continue;
                }
            } else {
                // Read more chunks from socket
                const { value, done } = await this.reader.read();
                if (value) {
                    this.buffer += this.decoder.decode(value, { stream: true });
                }
                if (done) {
                    break;
                }
            }
        }
        return fullResponse.trim();
    }

    async writeCmd(cmd) {
        await this.writer.write(this.encoder.encode(cmd + '\r\n'));
    }

    async verifyAuth(email, password) {
        try {
            await this.readResponse(); // Greeting

            await this.writeCmd('EHLO securemail');
            await this.readResponse();

            await this.writeCmd('AUTH LOGIN');
            await this.readResponse(); // 334 VXNlcm5hbWU6

            await this.writeCmd(btoa(email));
            await this.readResponse(); // 334 UGFzc3dvcmQ6

            await this.writeCmd(btoa(password));
            const authRes = await this.readResponse();
            
            await this.writeCmd('QUIT');
            await this.readResponse();

            if (!authRes.startsWith('235')) {
                return { success: false, error: 'Authentication failed.' };
            }

            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async sendMail(email, password, to, subject, body, senderName) {
        try {
            await this.readResponse(); // Greeting

            await this.writeCmd('EHLO securemail');
            await this.readResponse();

            await this.writeCmd('AUTH LOGIN');
            await this.readResponse(); // 334

            await this.writeCmd(btoa(email));
            await this.readResponse(); // 334

            await this.writeCmd(btoa(password));
            const authRes = await this.readResponse();
            if (!authRes.startsWith('235')) throw new Error('Auth failed');

            await this.writeCmd(`MAIL FROM:<${email}>`);
            const mailFromRes = await this.readResponse();
            if (!mailFromRes.startsWith('250')) throw new Error('Sender rejected');

            await this.writeCmd(`RCPT TO:<${to}>`);
            const rcptRes = await this.readResponse();
            if (!rcptRes.startsWith('250')) throw new Error('Recipient rejected');

            await this.writeCmd('DATA');
            const dataCmdRes = await this.readResponse();
            if (!dataCmdRes.startsWith('354')) throw new Error('Data command rejected');

            const date = new Date().toUTCString();
            const message = [
                `From: "${senderName}" <${email}>`,
                `To: ${to}`,
                `Subject: ${subject}`,
                `Date: ${date}`,
                `Content-Type: text/plain; charset=utf-8`,
                '',
                body,
                '.',
                ''
            ].join('\r\n');

            await this.writeCmd(message);
            const dataRes = await this.readResponse();
            if (!dataRes.startsWith('250')) throw new Error('Message rejected');

            await this.writeCmd('QUIT');
            await this.readResponse();
            
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
}
