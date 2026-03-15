// .wrangler/tmp/bundle-hc1OMd/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// worker.js
import { connect } from "cloudflare:sockets";
var TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
var MAX_RECIPIENTS_PER_BATCH = 10;
var SMTP_PORT = 465;
var SMTP_HOST = "smtp.gmail.com";
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
var worker_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const url = new URL(request.url);
    if (request.method === "POST") {
      try {
        if (url.pathname === "/api/verify") {
          return await handleVerify(request, env);
        }
        if (url.pathname === "/api/send-batch") {
          return await handleSendBatch(request, env);
        }
      } catch (err) {
        return jsonResponse({ success: false, message: err.message }, 500);
      }
    }
    return new Response("Secure Mail Console - API Endpoints: /api/verify | /api/send-batch", { headers: corsHeaders });
  }
};
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });
}
async function verifyTurnstile(token, ip) {
  if (!token)
    return false;
  let formData = new FormData();
  formData.append("secret", TURNSTILE_SECRET);
  formData.append("response", token);
  formData.append("remoteip", ip);
  const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    body: formData,
    method: "POST"
  });
  const outcome = await result.json();
  return outcome.success;
}
async function handleVerify(request, env) {
  const body = await request.json();
  const { email, appPassword, cfToken } = body;
  const ip = request.headers.get("CF-Connecting-IP");
  if (!email || !appPassword) {
    return jsonResponse({ success: false, message: "Email and App Password required" }, 400);
  }
  const isHuman = await verifyTurnstile(cfToken, ip);
  if (!isHuman) {
    return jsonResponse({ success: false, message: "Spam protection check failed. Please refresh." }, 401);
  }
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
  const ip = request.headers.get("CF-Connecting-IP");
  if (!email || !appPassword || !recipients || !Array.isArray(recipients)) {
    return jsonResponse({ success: false, message: "Missing required fields" }, 400);
  }
  if (recipients.length > MAX_RECIPIENTS_PER_BATCH) {
    return jsonResponse({ success: false, message: `Batch too large. Max allowed: ${MAX_RECIPIENTS_PER_BATCH}` }, 400);
  }
  const isHuman = await verifyTurnstile(cfToken, ip);
  if (!isHuman) {
    return jsonResponse({ success: false, message: "Spam check failed." }, 401);
  }
  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    const client = new SmtpClient(SMTP_HOST, SMTP_PORT);
    const result = await client.sendMail(email, appPassword, recipient, subject, messageBody, senderName);
    if (result.success) {
      sent++;
    } else {
      console.error(`Failed to send to ${recipient}: ${result.error}`);
      failed++;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return jsonResponse({
    success: true,
    message: "Batch processed",
    results: { sent, failed }
  });
}
var SmtpClient = class {
  constructor(host, port) {
    this.socket = connect({ hostname: host, port }, { secureTransport: "on" });
    this.writer = this.socket.writable.getWriter();
    this.reader = this.socket.readable.getReader();
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.buffer = "";
  }
  async readResponse() {
    let fullResponse = "";
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index !== -1) {
        const line = this.buffer.slice(0, index + 1);
        this.buffer = this.buffer.slice(index + 1);
        fullResponse += line;
        if (line.length >= 4 && line[3] === " ") {
          return fullResponse.trim();
        } else if (line.length >= 4 && line[3] === "-") {
          continue;
        }
      } else {
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
    await this.writer.write(this.encoder.encode(cmd + "\r\n"));
  }
  async verifyAuth(email, password) {
    try {
      await this.readResponse();
      await this.writeCmd("EHLO securemail");
      await this.readResponse();
      await this.writeCmd("AUTH LOGIN");
      await this.readResponse();
      await this.writeCmd(btoa(email));
      await this.readResponse();
      await this.writeCmd(btoa(password));
      const authRes = await this.readResponse();
      await this.writeCmd("QUIT");
      await this.readResponse();
      if (!authRes.startsWith("235")) {
        return { success: false, error: "Authentication failed." };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  async sendMail(email, password, to, subject, body, senderName) {
    try {
      await this.readResponse();
      await this.writeCmd("EHLO securemail");
      await this.readResponse();
      await this.writeCmd("AUTH LOGIN");
      await this.readResponse();
      await this.writeCmd(btoa(email));
      await this.readResponse();
      await this.writeCmd(btoa(password));
      const authRes = await this.readResponse();
      if (!authRes.startsWith("235"))
        throw new Error("Auth failed");
      await this.writeCmd(`MAIL FROM:<${email}>`);
      const mailFromRes = await this.readResponse();
      if (!mailFromRes.startsWith("250"))
        throw new Error("Sender rejected");
      await this.writeCmd(`RCPT TO:<${to}>`);
      const rcptRes = await this.readResponse();
      if (!rcptRes.startsWith("250"))
        throw new Error("Recipient rejected");
      await this.writeCmd("DATA");
      const dataCmdRes = await this.readResponse();
      if (!dataCmdRes.startsWith("354"))
        throw new Error("Data command rejected");
      const date = (/* @__PURE__ */ new Date()).toUTCString();
      const message = [
        `From: "${senderName}" <${email}>`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Content-Type: text/plain; charset=utf-8`,
        "",
        body,
        ".",
        ""
      ].join("\r\n");
      await this.writeCmd(message);
      const dataRes = await this.readResponse();
      if (!dataRes.startsWith("250"))
        throw new Error("Message rejected");
      await this.writeCmd("QUIT");
      await this.readResponse();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
};
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
var jsonError = async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
};
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-hc1OMd/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  ...void 0 ?? [],
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}

// .wrangler/tmp/bundle-hc1OMd/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  };
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      };
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
