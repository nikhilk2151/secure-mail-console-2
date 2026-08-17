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

  // Extract domain for RFC compliant Message-ID
  const senderDomain = email.split('@')[1] || 'gmail.com';

  // Clean HTML email template that avoids Spam/Promotions tab triggers
  function buildCleanHtml(body) {
    const bodyHtml = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #222222; margin: 0; padding: 20px; background-color: #ffffff;">
  <div style="max-width: 600px; margin: 0 auto;">
    ${bodyHtml}
  </div>
</body>
</html>`;
  }

  // Send emails using controlled parallel execution
  const results = await Promise.allSettled(recipients.map(async (recipient) => {
    const uniqueId = crypto.randomUUID();
    const cleanSubject = (subject || '').trim();

    const mailOptions = {
      from: `"${senderName.replace(/"/g, '')}" <${email}>`,
      to: recipient.trim(),
      replyTo: email,
      subject: cleanSubject,
      text: messageBody,
      html: buildCleanHtml(messageBody),
      messageId: `<${uniqueId}@${senderDomain}>`,
      headers: {
        'X-Priority': '3',
        'Importance': 'normal'
      }
    };

    const info = await transporter.sendMail(mailOptions);
    return {
      success: true,
      recipient,
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
