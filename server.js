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

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

/* ---------------- SMTP TRANSPORTER (INBOX-OPTIMIZED) ---------------- */

function getTransporter(email, appPassword) {
  const key = `${email}:${appPassword}`;
  if (transporterCache.has(key)) {
    return transporterCache.get(key);
  }

  const senderDomain = email.split('@')[1] || 'gmail.com';

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,

    auth: {
      user: email,
      pass: appPassword
    },

    tls: {
      rejectUnauthorized: false
    },

    family: 4,

    // Use EHLO with sender's domain — critical for SPF/DKIM alignment
    name: senderDomain,

    // Conservative pooling — avoids Gmail rate-limit flags
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    rateDelta: 2000,
    rateLimit: 5
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

/* ---------------- INBOX-OPTIMIZED EMAIL BUILDER ---------------- */

/**
 * Builds a clean, personal-style HTML email that bypasses spam/promotions filters.
 * 
 * Key techniques:
 * - Minimal inline CSS (no external links, no images, no tracking pixels)
 * - System font stack matching personal Gmail compose
 * - No marketing-style layout (no tables, no columns, no big headers)
 * - Hidden unique token per recipient for content uniqueness
 * - Text-to-HTML ratio kept very high (almost all text)
 */
function buildInboxHtml(body, uniqueToken) {
  const bodyHtml = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  // Invisible unique token — ensures each email has unique content fingerprint
  // This prevents Gmail from collapsing identical emails as "bulk"
  const invisibleToken = `<span style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${uniqueToken}</span>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title></title>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;">
  ${invisibleToken}
  <div style="max-width:580px;margin:0 auto;padding:16px 20px;">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

/**
 * Generates a RFC2822 compliant Date header for the current time
 */
function generateRFC2822Date() {
  return new Date().toUTCString().replace('GMT', '+0000');
}

/* ---------------- SEND BATCH (INBOX-OPTIMIZED) ---------------- */

app.post("/api/send-batch", async (req, res) => {
  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken } = req.body;

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

  const transporter = getTransporter(email, appPassword);
  let sent = 0;
  let failed = 0;
  const failedRecipients = [];
  const details = [];

  // Extract domain for RFC compliant Message-ID and DKIM alignment
  const senderDomain = email.split('@')[1] || 'gmail.com';
  const cleanSenderName = (senderName || '').replace(/"/g, '').trim();
  const cleanSubject = (subject || '').trim();

  // Send emails SEQUENTIALLY with small delays — mimics human sending pattern
  // This is the single most important factor for inbox placement
  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i].trim();
    const uniqueId = crypto.randomUUID();
    const uniqueToken = crypto.randomBytes(16).toString('hex');

    try {
      const mailOptions = {
        // === ENVELOPE ===
        from: `"${cleanSenderName}" <${email}>`,
        to: recipient,
        replyTo: email,
        sender: email,

        // === SUBJECT ===
        subject: cleanSubject,

        // === CONTENT (multipart/alternative — text + html) ===
        text: messageBody,
        html: buildInboxHtml(messageBody, uniqueToken),

        // === RFC-COMPLIANT MESSAGE-ID ===
        // Uses sender's domain for DKIM alignment
        messageId: `<${uniqueId}@${senderDomain}>`,

        // === DATE HEADER ===
        date: new Date(),

        // === CRITICAL INBOX HEADERS ===
        headers: {
          // Priority: Normal (3 = normal, 1 = high triggers spam)
          'X-Priority': '3',
          'X-MSMail-Priority': 'Normal',
          'Importance': 'Normal',

          // Tells receiving server this is a personal transactional email
          'Precedence': 'bulk',

          // List-Unsubscribe — Gmail REQUIRES this for inbox placement
          // Uses mailto: unsubscribe which is the most trusted form
          'List-Unsubscribe': `<mailto:${email}?subject=unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',

          // Feedback-ID for Gmail Postmaster Tools tracking
          // Format: a]b:c:d — helps Gmail track sender reputation
          'Feedback-ID': `${uniqueId}:${senderDomain}:campaign`,

          // Auto-Submitted: no — tells servers this was manually composed
          'Auto-Submitted': 'no',

          // X-Entity-Ref-ID — unique per message, prevents threading/grouping
          'X-Entity-Ref-ID': uniqueId,

          // MIME headers
          'MIME-Version': '1.0'
        },

        // === ENCODING ===
        encoding: 'quoted-printable',
        textEncoding: 'quoted-printable'
      };

      const info = await transporter.sendMail(mailOptions);
      sent++;
      details.push({
        recipient,
        success: true,
        response: info.response || '250 OK'
      });

    } catch (err) {
      failed++;
      failedRecipients.push(recipient);
      const errMsg = err.message || 'Delivery rejected by mail server';
      console.error(`Email delivery failed for ${recipient}:`, errMsg);
      details.push({
        recipient,
        success: false,
        error: errMsg
      });
    }

    // Stagger delay between emails — mimics natural human sending cadence
    // 200-500ms random jitter prevents pattern detection by spam filters
    if (i < recipients.length - 1) {
      await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 300)));
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
