import 'dotenv/config';
import express from 'express';
import http from 'http';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// Site password from environment variable (hidden from GitHub via .env + .gitignore)
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'changeme';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '1x0000000000000000000000000000000AA';

/* ---------------- ANTI-SPAM & SECURITY HELPERS ---------------- */

// Anti-Header Injection: cleans string for safe RFC headers
function cleanHeader(val) {
  if (!val) return '';
  return String(val).replace(/[\r\n\t]+/g, ' ').trim();
}

// Anti-Spam Sanitation: removes malware/phishing triggers while keeping all legitimate rich formatting
function sanitizeHtmlForDeliverability(html) {
  if (!html) return '';
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<form\b[^<]*(?:(?!<\/form>)<[^<]*)*<\/form>/gi, '')
    .replace(/<input\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, '')
    .replace(/href\s*=\s*["']\s*javascript:[^"']*["']/gi, 'href="#"')
    .replace(/src\s*=\s*["']\s*javascript:[^"']*["']/gi, 'src=""');
}

// Verify Cloudflare Turnstile anti-bot token with Cloudflare API
async function verifyTurnstile(token, remoteIp) {
  if (!token) {
    return { success: false, message: "Spam protection token required" };
  }

  // Cloudflare test key bypass for local development
  if (TURNSTILE_SECRET === '1x0000000000000000000000000000000AA' || token === 'XXXX.DUMMY.TOKEN.XXXX') {
    return { success: true };
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET);
    formData.append('response', token);
    if (remoteIp) formData.append('remoteip', remoteIp);

    const cfRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });

    const data = await cfRes.json();
    if (data.success) {
      return { success: true };
    } else {
      return {
        success: false,
        message: "Spam check failed: " + (data['error-codes']?.join(', ') || "Invalid token")
      };
    }
  } catch (err) {
    console.warn("Turnstile API verification fallback:", err.message);
    if (TURNSTILE_SECRET === '1x0000000000000000000000000000000AA') {
      return { success: true };
    }
    return { success: false, message: "Spam check service unreachable. Please retry." };
  }
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Prevent browser from caching old CSS/JS in development
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

app.use(express.static(path.join(__dirname, "public"), { maxAge: 0, etag: false }));

const activeSessions = {};

// Cache transporters by email to reuse SMTP connections across requests
const transporterCache = new Map();

/* ---------------- PASSWORD AUTH ---------------- */

app.post("/api/auth", (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, message: "Password required" });
  }

  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: "Access granted" });
  } else {
    return res.status(401).json({ success: false, message: "Incorrect password" });
  }
});

/* ---------------- SMTP TRANSPORTER ---------------- */

function getTransporter(email, appPassword) {
  const key = `${email}:${appPassword}`;
  if (transporterCache.has(key)) {
    return transporterCache.get(key);
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, // SSL on 465 provides reliable, authenticated delivery for Gmail

    auth: {
      user: email,
      pass: appPassword
    },

    tls: {
      rejectUnauthorized: false
    },

    family: 4,

    // Balanced connection pooling optimized for Gmail SMTP
    pool: true,
    maxConnections: 10,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 20
  });

  transporterCache.set(key, transporter);

  // Auto-clean cache after 15 minutes of inactivity
  setTimeout(() => {
    transporterCache.delete(key);
    try { transporter.close(); } catch (_) {}
  }, 15 * 60 * 1000);

  return transporter;
}

/* ---------------- VERIFY SMTP ---------------- */

app.post("/api/verify", async (req, res) => {
  const { email, appPassword, cfToken } = req.body;

  if (!email || !appPassword || !cfToken) {
    return res.status(400).json({
      success: false,
      message: "Email, App Password, and Spam Check required"
    });
  }

  // Verify spam protection
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const spamCheck = await verifyTurnstile(cfToken, clientIp);
  if (!spamCheck.success) {
    return res.status(403).json({
      success: false,
      message: spamCheck.message || "Spam protection verification failed"
    });
  }

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();

    res.json({
      success: true,
      message: "SMTP verified successfully"
    });

  } catch (error) {
    console.error("SMTP Verify Error:", error);
    res.status(401).json({
      success: false,
      message: error.message || "Invalid Gmail or App Password"
    });
  }
});

/* ---------------- SEND BATCH ---------------- */

app.post("/api/send-batch", async (req, res) => {
  const { email, appPassword, senderName, subject, messageBody, htmlBody, recipients, cfToken } = req.body;

  if (!email || !appPassword || !recipients?.length) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields"
    });
  }

  if (recipients.length > 50) {
    return res.status(400).json({
      success: false,
      message: "Batch too large. Max 50."
    });
  }

  // Anti-Spam / Anti-Bot Token Verification
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const spamCheck = await verifyTurnstile(cfToken, clientIp);
  if (!spamCheck.success) {
    return res.status(403).json({
      success: false,
      message: spamCheck.message || "Spam check failed"
    });
  }

  const transporter = getTransporter(email, appPassword);
  let sent = 0;
  let failed = 0;
  const failedRecipients = [];
  const details = [];

  // Extract domain for RFC compliant Message-ID
  const senderDomain = email.split('@')[1] || 'gmail.com';

  // Helper to convert HTML to clean, readable plain text for anti-spam multipart ratio
  function htmlToPlainText(html) {
    if (!html) return '';
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*[\/]?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n$1\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // HTML email template optimized for Gmail/Yahoo anti-spam algorithms
  function buildCleanHtml(rawContent, sName, sEmail) {
    if (!rawContent) return '';

    const cleanSender = cleanHeader(sName) || 'Sender';
    const cleanMail = cleanHeader(sEmail) || '';

    // Sanitize any malware/phishing triggers from pasted content
    const sanitized = sanitizeHtmlForDeliverability(rawContent);

    // If it's already a full HTML document, return sanitized
    if (/^\s*<!DOCTYPE\s+html/i.test(sanitized) || /^\s*<html[\s>]/i.test(sanitized)) {
      return sanitized;
    }

    const hasHtmlTags = /<[a-z][\s\S]*>/i.test(sanitized);

    // If it contains HTML formatting tags, preserve them. If strictly plain text, convert linebreaks.
    const bodyHtml = hasHtmlTags
      ? sanitized
      : sanitized
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="format-detection" content="telephone=no">
  <meta name="x-apple-disable-message-reformatting">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      color: #222222;
      margin: 0;
      padding: 20px;
      background-color: #ffffff;
      -webkit-font-smoothing: antialiased;
    }
    a { color: #2563eb; text-decoration: underline; }
    p { margin: 0 0 1em 0; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
    th { background-color: #f8fafc; font-weight: 600; }
    img { max-width: 100%; height: auto; border: 0; }
    blockquote { border-left: 4px solid #cbd5e1; margin: 1em 0; padding-left: 1rem; color: #64748b; }
    ul, ol { margin: 1em 0; padding-left: 1.5rem; }
    .email-container { max-width: 600px; margin: 0 auto; background: #ffffff; }
    .email-footer {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid #e2e8f0;
      font-size: 12px;
      color: #94a3b8;
      text-align: center;
      line-height: 1.5;
    }
  </style>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #222222; margin: 0; padding: 20px; background-color: #ffffff;">
  <div class="email-container" style="max-width: 600px; margin: 0 auto;">
    ${bodyHtml}
    <div class="email-footer" style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;">
      Sent by ${cleanSender}. <a href="mailto:${cleanMail}?subject=Unsubscribe" style="color: #64748b; text-decoration: underline;">Unsubscribe</a>
    </div>
  </div>
</body>
</html>`;
  }

  // Send emails using controlled parallel execution with anti-spam deliverability headers
  const results = await Promise.allSettled(recipients.map(async (recipient) => {
    const uniqueId = crypto.randomUUID();
    const cleanSenderName = cleanHeader(senderName) || 'Sender';
    const cleanSubject = cleanHeader(subject) || 'No Subject';
    const cleanRecipient = cleanHeader(recipient).toLowerCase();

    const activeHtml = htmlBody || (/<[a-z][\s\S]*>/i.test(messageBody) ? messageBody : null);
    const textContent = activeHtml
      ? (messageBody && !/<[a-z][\s\S]*>/i.test(messageBody) ? messageBody : htmlToPlainText(activeHtml))
      : messageBody;
    const finalHtml = buildCleanHtml(activeHtml || messageBody, cleanSenderName, email);

    // RFC 8058 & 2024 Gmail/Yahoo Bulk Sender compliant anti-spam headers
    const mailOptions = {
      from: `"${cleanSenderName.replace(/"/g, '')}" <${email}>`,
      to: cleanRecipient,
      replyTo: email,
      subject: cleanSubject,
      text: textContent,
      html: finalHtml,
      messageId: `<${uniqueId}@${senderDomain}>`,
      date: new Date(),
      headers: {
        'X-Priority': '3',
        'Importance': 'normal',
        'Precedence': 'bulk',
        'X-Auto-Response-Suppress': 'All',
        'List-Unsubscribe': `<mailto:${email}?subject=Unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'X-Entity-Ref-ID': uniqueId,
        'Feedback-ID': `bulk-send:gmail:${senderDomain}`,
        'X-Mailer': 'SecureMailConsole/1.0'
      }
    };

    const info = await transporter.sendMail(mailOptions);
    return {
      success: true,
      recipient: cleanRecipient,
      messageId: info.messageId || uniqueId,
      response: info.response
    };
  }));

  for (let i = 0; i < results.length; i++) {
    const resItem = results[i];
    const recipient = recipients[i];

    if (resItem.status === 'fulfilled') {
      sent++;
      details.push({
        recipient,
        success: true,
        response: resItem.value.response || '250 OK'
      });
    } else {
      failed++;
      failedRecipients.push(recipient);
      const errMsg = resItem.reason?.message || 'Delivery rejected by mail server';
      console.error(`Email delivery failed for ${recipient}:`, errMsg);
      details.push({
        recipient,
        success: false,
        error: errMsg
      });
    }
  }

  res.json({
    success: true,
    results: {
      sent,
      failed,
      failedRecipients,
      details
    }
  });
});

/* ---------------- STOP PROCESS ---------------- */

app.post("/api/stop", (req, res) => {
  activeSessions['global_stop'] = true;
  res.json({ success: true, message: "Stopping future batches." });
  setTimeout(() => { activeSessions['global_stop'] = false; }, 5000);
});

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
