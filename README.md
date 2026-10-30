# 📧 Secure Mail Console

A powerful **web-based email sending console** built with **Node.js, Express, and Nodemailer** that allows users to send bulk emails securely using Gmail SMTP.
This tool provides a simple interface for sending emails to multiple recipients with real-time status updates.

---

## 🚀 Features

* Send emails using **Gmail SMTP**
* **Bulk email sending** with background batching
* Progress tracking via HTTP chunking
* Built-in **Spam Protection** (Cloudflare Turnstile)
* Supports **HTML email content**
* Secure, Serverless backend via **Cloudflare Workers**
* Cross-origin support using **CORS**
* Ready to deploy globally on **Cloudflare**

---

## 🛠 Tech Stack

**Frontend**

* HTML
* CSS
* JavaScript

**Backend**

* Cloudflare Workers (Serverless)
* `cloudflare:sockets` based SMTP Client

**Email Service**

* Gmail SMTP

---

## 📂 Project Structure

```
secure-mail-console/
│
├── public/            # Frontend files (HTML, CSS, JS)
│   ├── index.html
│   ├── style.css
│   └── script.js
│
├── worker.js          # Cloudflare Worker Backend (SMTP & Anti-Spam)
├── wrangler.json      # Cloudflare deployment configuration
├── package.json       # Project dependencies
└── README.md
```

---

## ⚙️ Installation

### 1️⃣ Clone the Repository

```bash
git clone https://github.com/yourusername/secure-mail-console.git
```

### 2️⃣ Open the Project

```bash
cd secure-mail-console
```

### 3️⃣ Install Dependencies

```bash
npm install
```

---

## ▶️ Run the Application (Locally)

To test the application locally with Cloudflare's runtime, use Wrangler:

```bash
npx wrangler dev
```

The app will become available at `http://localhost:8787`.

---

## 📧 Anti-Spam & Turnstile

This application uses **Cloudflare Turnstile** to prevent spam and automated bots from abusing your bulk email console.
By default, a test sitekey is provided.

For production:
1. Get a sitekey and secret from the [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/turnstile).
2. Update `data-sitekey` in `public/index.html`.
3. Update `TURNSTILE_SECRET` in `worker.js`.

---

## 🌐 Deployment

This project is now designed as a **Cloudflare Worker with Static Assets**. You can deploy the frontend and backend globally to Cloudflare with a single command.

```bash
npm install -g wrangler
wrangler deploy
```

This will upload your static files and deploy the worker API seamlessly.

---

## 🔒 Security Notes

* Always use **App Passwords** for Gmail SMTP.
* Do not upload sensitive credentials to GitHub.
* Use **environment variables (.env)** for production.

---

## 📜 License

This project is open-source and available under the **MIT License**.

---

## 👨‍💻 Author

**Nikhil Kumar**

If you like this project, consider giving it a ⭐ on GitHub!
