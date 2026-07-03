// Order Assistant — backend (BIA 658 Project 1)
// Zero-dependency Node server. Claude API key stays server-side (env var), never sent to client.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// ---- tiny .env loader (no dotenv dependency) ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env file — rely on real env vars (e.g. on Render) */ }

const ORDERS = require("./data/orders.json");
const PORT = process.env.PORT || 3000;

// Provider: OpenAI if OPENAI_API_KEY is set, else Anthropic (ANTHROPIC_API_KEY).
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PROVIDER = OPENAI_KEY ? "openai" : "anthropic";
const MODEL = process.env.MODEL || (PROVIDER === "openai" ? "gpt-4o" : "claude-sonnet-4-5");
if (!OPENAI_KEY && !ANTHROPIC_KEY)
  console.warn("WARNING: no OPENAI_API_KEY or ANTHROPIC_API_KEY set. /api/chat will fail until one is.");

// ---------- Data helpers (the ONLY source of factual answers) ----------
const norm = (s) => String(s || "").trim().toLowerCase();

function lookupOrderById(orderId) {
  const id = norm(orderId).replace(/\s+/g, "");
  const order = ORDERS.find((o) => norm(o.OrderID) === id);
  return order ? { found: true, order } : { found: false, message: `No order found with ID "${orderId}".` };
}

function lookupOrdersByCustomer(nameOrEmail) {
  const q = norm(nameOrEmail);
  if (!q) return { found: false, message: "No name or email given." };
  const matches = ORDERS.filter((o) => norm(o.CustomerName).includes(q) || norm(o.Email) === q);
  return matches.length
    ? { found: true, count: matches.length, orders: matches }
    : { found: false, message: `No orders found for "${nameOrEmail}".` };
}

function lookupOrdersByStatus(status) {
  const s = norm(status);
  const matches = ORDERS.filter((o) => norm(o.Status) === s);
  return matches.length
    ? {
        found: true,
        count: matches.length,
        // Aggregate view: no customer contact details.
        orders: matches.map(({ OrderID, Product, Quantity, Status, OrderDate }) => ({ OrderID, Product, Quantity, Status, OrderDate })),
      }
    : { found: false, message: `No orders with status "${status}". Valid statuses: Delivered, Shipped, Processing, Cancelled.` };
}

function verifyCustomer(orderIdOrName, email) {
  const e = norm(email);
  if (!e) return { verified: false, message: "No email provided." };
  const matches = ORDERS.filter((o) => norm(o.Email) === e);
  if (!matches.length) return { verified: false, message: "That email does not match any order on file." };
  if (orderIdOrName) {
    const q = norm(orderIdOrName);
    const scoped = matches.some((o) => norm(o.OrderID) === q || norm(o.CustomerName).includes(q));
    if (!scoped) return { verified: false, message: "That email does not match the order/customer being asked about." };
  }
  return { verified: true, customerName: matches[0].CustomerName, email: matches[0].Email, orderCount: matches.length };
}

function startReturn(orderId, reason) {
  const res = lookupOrderById(orderId);
  if (!res.found) return { success: false, message: res.message };
  const o = res.order;
  if (norm(o.Status) === "cancelled")
    return { success: false, message: `Order ${o.OrderID} was cancelled, so there is nothing to return.` };
  const returnId = "RET-" + Math.floor(1000 + Math.random() * 9000);
  return {
    success: true,
    returnId,
    orderId: o.OrderID,
    product: o.Product,
    reason: reason || "not specified",
    message: `Return ${returnId} started for ${o.OrderID} (${o.Product}). Reason: ${reason || "not specified"}. A prepaid shipping label will be emailed to ${o.Email} within 24 hours.`,
  };
}

// ---------- Claude tool definitions ----------
const TOOLS = [
  {
    name: "lookup_order_by_id",
    description: "Look up a single order by its order ID (e.g. ORD-1003). Returns full order details.",
    input_schema: { type: "object", properties: { order_id: { type: "string", description: "The order ID, e.g. ORD-1003" } }, required: ["order_id"] },
  },
  {
    name: "lookup_orders_by_customer",
    description: "Look up all orders for a customer by full/partial name or exact email address.",
    input_schema: { type: "object", properties: { name_or_email: { type: "string", description: "Customer name or email" } }, required: ["name_or_email"] },
  },
  {
    name: "lookup_orders_by_status",
    description: "List all orders with a given status: Delivered, Shipped, Processing, or Cancelled. Returns an aggregate view without customer contact details.",
    input_schema: { type: "object", properties: { status: { type: "string", description: "Order status" } }, required: ["status"] },
  },
  {
    name: "verify_customer",
    description: "Verify a customer's identity by checking that the email they provided matches the email on file. Call this when the customer supplies their email during the verification step, BEFORE revealing order details. Optionally scope to the order ID or customer name being discussed.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email address the customer provided" },
        order_id_or_name: { type: "string", description: "The order ID or customer name being asked about (optional)" },
      },
      required: ["email"],
    },
  },
  {
    name: "start_return",
    description: "Start a return for an existing order. Validates the order exists and returns a confirmation with a return ID.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "The order ID to return" },
        reason: { type: "string", description: "The customer's reason for the return" },
      },
      required: ["order_id", "reason"],
    },
  },
];

function runTool(name, input) {
  switch (name) {
    case "lookup_order_by_id": return lookupOrderById(input.order_id);
    case "lookup_orders_by_customer": return lookupOrdersByCustomer(input.name_or_email);
    case "lookup_orders_by_status": return lookupOrdersByStatus(input.status);
    case "verify_customer": return verifyCustomer(input.order_id_or_name, input.email);
    case "start_return": return startReturn(input.order_id, input.reason);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ---------- System prompt ----------
const SYSTEM_PROMPT = `You are "Order Assistant", the friendly customer service agent for our online store. You help customers with questions about their orders ONLY: order status, tracking numbers, estimated delivery dates, products ordered, quantities, prices, totals, and starting returns.

## Grounding rules (critical)
- EVERY factual claim about an order MUST come from a tool call result in this conversation. Never answer from memory, never guess, never invent order IDs, tracking numbers, dates, prices, or statuses.
- If a tool returns no match, say so plainly and ask the customer to double-check the ID/name. Never fabricate a plausible-sounding answer.
- If a field is empty in the data (e.g. no tracking number yet), say it is not available yet and explain why if the status makes it obvious (e.g. still processing).
- Report values exactly as returned by tools (IDs, tracking numbers, dates, amounts). Format prices with a dollar sign and two decimals.

## Identity verification (required)
- Before revealing specific details of a particular order or a particular customer's orders (status, tracking, totals, delivery dates, products), you MUST verify identity: politely ask the customer to confirm the email address on file for that order, right here in chat.
- When they provide an email, call the verify_customer tool. Only reveal details if it returns verified: true. If not verified, apologize and ask them to re-check the email; do not reveal any details or hint at the correct email.
- Once a customer is verified in this conversation, do NOT ask again for subsequent questions about that same customer's orders.
- Aggregate/status queries (e.g. "which orders are still processing?") may be answered WITHOUT verification using lookup_orders_by_status, since that view contains no customer contact details. This supports store-staff style questions.
- Starting a return also requires the order's email to be verified first.

## Scope
- You only discuss this store's orders and returns. For anything off-topic (weather, news, coding, math homework, general chit-chat beyond a friendly greeting), politely decline in one short sentence and steer back to order help. Example: "I'm only able to help with questions about your orders — is there an order I can look up for you?"
- Do not give opinions on products, offer discounts, change order data, or promise anything the tools cannot do.

## Tone & language
- Mirror the customer's language: if they write in Spanish, reply in Spanish; French in French; and so on. Mirror their register too — casual if they're casual, formal if they're formal. Stay warm, concise, and professional either way.
- Be conversational: short paragraphs, no unnecessary bullet walls. Use at most a compact list when presenting multiple orders.

## Returns
- To start a return you need the order ID and a reason. If either is missing, ask for it conversationally. After verification, call start_return and relay the confirmation (return ID, product, label email note) clearly.`;

const WELCOME =
  "Hi! I'm Order Assistant 👋 I can check your order status, find tracking info, answer questions about your purchases, and start a return. Just give me your order number or name and I'll take it from there!";

// ---------- LLM providers (plain fetch, no SDKs) ----------
// The client treats the message history as opaque JSON, so each provider keeps
// its own native message format inside that history.

async function callAnthropic(messages) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, tools: TOOLS, messages }),
  });
  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

const OPENAI_TOOLS = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOpenAI(messages) {
  // Retry on 429 rate limits with backoff (low-tier OpenAI orgs allow very few requests/min).
  for (let attempt = 0; attempt < 6; attempt++) {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
        max_tokens: 1024,
      }),
    });
    if (resp.ok) return resp.json();
    const body = await resp.text();
    if (resp.status === 429 && attempt < 5) {
      const m = body.match(/try again in ([\d.]+)(ms|s)/i);
      let waitMs = m ? parseFloat(m[1]) * (m[2].toLowerCase() === "ms" ? 1 : 1000) : 5000 * (attempt + 1);
      waitMs = Math.min(waitMs + 500, 25000);
      console.warn(`OpenAI 429 — retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1})`);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`OpenAI API ${resp.status}: ${body.slice(0, 300)}`);
  }
}

async function handleChatOpenAI(messages) {
  let verifiedCustomer = null;
  for (let i = 0; i < 8; i++) {
    const data = await callOpenAI(messages);
    const msg = data.choices[0].message;
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        const result = runTool(tc.function.name, args);
        if (tc.function.name === "verify_customer" && result.verified) {
          verifiedCustomer = { name: result.customerName, email: result.email };
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }
    return { status: 200, body: { reply: msg.content || "", messages, verifiedCustomer } };
  }
  return { status: 500, body: { error: "Tool loop exceeded limit." } };
}

async function handleChatAnthropic(messages) {
  let verifiedCustomer = null;
  for (let i = 0; i < 8; i++) {
    const response = await callAnthropic(messages);
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const reply = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      return { status: 200, body: { reply, messages, verifiedCustomer } };
    }
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = runTool(block.name, block.input);
      if (block.name === "verify_customer" && result.verified) {
        verifiedCustomer = { name: result.customerName, email: result.email };
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return { status: 500, body: { error: "Tool loop exceeded limit." } };
}

async function handleChat(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!messages.length) return { status: 400, body: { error: "messages required" } };
  return PROVIDER === "openai" ? handleChatOpenAI(messages) : handleChatAnthropic(messages);
}

// ---------- HTTP server ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const PUBLIC_DIR = path.join(__dirname, "public");

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/welcome") return json(res, 200, { welcome: WELCOME });

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const payload = await readBody(req);
      const out = await handleChat(payload);
      return json(res, out.status, out.body);
    }

    if (url.pathname === "/api/orders") {
      const result = lookupOrdersByCustomer(url.searchParams.get("email") || "");
      return json(res, 200, { orders: result.found ? result.orders : [] });
    }

    if (url.pathname === "/api/return" && req.method === "POST") {
      const { orderId, reason, email } = await readBody(req);
      if (!orderId || !reason) return json(res, 400, { success: false, message: "Order ID and reason are required." });
      const order = lookupOrderById(orderId);
      if (order.found && email && norm(order.order.Email) !== norm(email)) {
        return json(res, 200, { success: false, message: "That email doesn't match the email on file for this order." });
      }
      return json(res, 200, startReturn(orderId, reason));
    }

    return serveStatic(req, res);
  } catch (err) {
    console.error("error:", err.message);
    json(res, 500, { error: "The assistant is temporarily unavailable. Please try again." });
  }
}).listen(PORT, () => console.log(`Order Assistant running on port ${PORT} (provider: ${PROVIDER}, model: ${MODEL})`));
