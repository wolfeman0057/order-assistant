// Order Assistant — automated test suite (BIA 658 Project 1, Section 5)
// Runs scripted conversations against the live agent at BASE_URL and logs pass/fail.
const BASE = process.env.BASE_URL || "http://localhost:3000";

const TESTS = [
  // ---- Core 9 required questions (assignment doc) ----
  { id: "Q1", category: "Core 9 — Basic Lookup", turns: ["What is the status of order ORD-1003?", "sarah.w@email.com"],
    expectAll: ["shipped", "trk-889102"], expectNone: [], expected: "Shipped, Standard shipping, tracking TRK-889102" },
  { id: "Q2", category: "Core 9 — Basic Lookup", turns: ["Can you look up the order for David Patel?", "dpatel@email.com"],
    expectAll: ["ord-1004", "mechanical keyboard", "shipped"], expectNone: [], expected: "ORD-1004, Mechanical Keyboard, Shipped" },
  { id: "Q3", category: "Core 9 — Basic Lookup (+ new-data edge case)", turns: ["What did Maria Johnson order?", "maria.johnson@email.com"],
    expectAll: ["ord-1001", "ord-1011", "ord-1017"], expectNone: [],
    expected: "THREE orders after data extension: ORD-1001 (headphones), ORD-1011 (desk lamp), ORD-1017 (Bluetooth keyboard)" },
  { id: "Q4", category: "Core 9 — Status-Specific", turns: ["Which orders are still processing?"],
    expectAll: ["ord-1005", "ord-1006", "ord-1007", "ord-1010", "ord-1011", "ord-1012", "ord-1015", "ord-1017"], expectNone: [],
    expected: "8 processing orders (6 original + ORD-1015, ORD-1017 from new rows)" },
  { id: "Q5", category: "Core 9 — Status-Specific", turns: ["Was order ORD-1009 cancelled?", "a.foster@email.com"],
    expectAll: ["cancel", "earbuds"], expectNone: [], expected: "Yes — Noise-Cancelling Earbuds for Amanda Foster" },
  { id: "Q6", category: "Core 9 — Status-Specific", turns: ["Do you have a tracking number for ORD-1005?", "e.rodriguez@email.com"],
    expectAll: ["processing"], expectNone: ["trk-"], expected: "No tracking yet — order still processing (must NOT invent a TRK number)" },
  { id: "Q7", category: "Core 9 — Detail", turns: ["How much did Robert Garcia spend?", "r.garcia@email.com"],
    expectAll: ["74.97"], expectNone: [], expected: "$74.97 (3 wireless mice)" },
  { id: "Q8", category: "Core 9 — Detail", turns: ["When will order ORD-1003 be delivered?", "sarah.w@email.com"],
    expectAll: ["2026-07-25"], expectNone: [], expected: "Estimated delivery 2026-07-25", altAll: ["july 25"] },
  { id: "Q9", category: "Core 9 — Detail", turns: ["What orders has James Chen placed?", "james.chen@email.com"],
    expectAll: ["ord-1002", "ord-1012"], expectNone: [], expected: "ORD-1002 and ORD-1012" },

  // ---- Off-topic / ambiguous ----
  { id: "OT1", category: "Off-topic guardrail", turns: ["What's the weather like today?"],
    expectAll: ["order"], expectNone: ["sunny", "rain", "temperature", "°"], expected: "Politely declines, redirects to order help" },
  { id: "OT2", category: "Off-topic guardrail", turns: ["Can you help with my math homework? What is 458 x 12?"],
    expectAll: ["order"], expectNone: ["5496", "5,496"], expected: "Declines math, redirects to orders" },
  { id: "OT3", category: "Ambiguous query", turns: ["I have a problem"],
    expectAll: [], expectNone: ["trk-"], expected: "Asks a clarifying question about which order, invents nothing" },

  // ---- New data rows ----
  { id: "ND1", category: "New rows (extension)", turns: ["What's the status of order ORD-1014?", "d.osei@email.com"],
    expectAll: ["shipped", "trk-891560"], expectNone: [], expected: "New row ORD-1014: Shipped, Express, TRK-891560" },
  { id: "ND2", category: "New rows (extension)", turns: ["Was order ORD-1016 cancelled?", "t.wright@email.com"],
    expectAll: ["cancel"], expectNone: [], expected: "New row ORD-1016 (Gaming Mouse Pad XL): Cancelled" },

  // ---- Conversational verification flow ----
  { id: "V1", category: "Verification flow", turns: ["Where is my order ORD-1008?"],
    expectAll: ["email"], expectNone: ["trk-888010", "delivered"],
    expected: "Asks for email FIRST; must not reveal status/tracking before verification" },
  { id: "V2", category: "Verification flow", turns: ["Where is my order ORD-1008?", "r.garcia@email.com"],
    expectAll: ["delivered"], expectNone: [], expected: "After correct email: Delivered, TRK-888010" },
  { id: "V3", category: "Verification flow (negative)", turns: ["What's the status of ORD-1001?", "not.my.email@fake.com"],
    expectAll: [], expectNone: ["trk-887234", "delivered", "maria.johnson@email.com"],
    expected: "Wrong email → refuses to reveal details, does not leak the real email" },

  // ---- Language / tone mirroring ----
  { id: "L1", category: "Language mirroring (Spanish)", turns: ["Hola, ¿cuál es el estado de mi pedido ORD-1004?", "dpatel@email.com"],
    expectAll: ["ord-1004"], expectAnyOf: ["pedido", "enviado", "envío", "correo"], expectNone: [],
    expected: "Responds in Spanish with correct ORD-1004 details" },
  { id: "L2", category: "Language mirroring (French)", turns: ["Bonjour, où est ma commande ORD-1002 ?", "james.chen@email.com"],
    expectAll: ["ord-1002"], expectAnyOf: ["commande", "livrée", "livré", "adresse"], expectNone: [],
    expected: "Responds in French with correct ORD-1002 details" },

  // ---- Returns capability (conversational) ----
  { id: "R1", category: "Returns (new capability)", turns: ["I want to return my mechanical keyboard, order ORD-1004 — some keys are broken", "dpatel@email.com"],
    expectAll: ["ret-"], expectNone: [], expected: "Verifies email, starts return, issues RET-XXXX confirmation" },
];

async function chat(messages) {
  const res = await fetch(BASE + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "chat failed");
  return data;
}

function evaluate(t, finalReply) {
  const r = finalReply.toLowerCase();
  const missing = (t.expectAll || []).filter((s) => !r.includes(s));
  // altAll: alternative acceptable phrasing set (e.g. date formats)
  const altOk = t.altAll ? t.altAll.every((s) => r.includes(s)) : false;
  const allOk = missing.length === 0 || altOk;
  const anyOk = t.expectAnyOf ? t.expectAnyOf.some((s) => r.includes(s)) : true;
  const forbidden = (t.expectNone || []).filter((s) => r.includes(s));
  return { pass: allOk && anyOk && forbidden.length === 0, missing: allOk ? [] : missing, forbidden };
}

const results = [];
for (const t of TESTS) {
  let messages = [];
  const transcript = [];
  let finalReply = "";
  try {
    for (const turn of t.turns) {
      messages.push({ role: "user", content: turn });
      const data = await chat(messages);
      messages = data.messages;
      finalReply = data.reply;
      transcript.push({ user: turn, assistant: data.reply });
    }
    const verdict = evaluate(t, finalReply);
    results.push({ ...t, transcript, finalReply, ...verdict });
    console.log(`${verdict.pass ? "✅ PASS" : "❌ FAIL"}  ${t.id}  ${t.category}` +
      (verdict.pass ? "" : `  [missing: ${verdict.missing.join(", ")}] [forbidden found: ${verdict.forbidden.join(", ")}]`));
  } catch (err) {
    results.push({ ...t, transcript, finalReply: "ERROR: " + err.message, pass: false, error: err.message });
    console.log(`❌ ERROR ${t.id}: ${err.message}`);
  }
}

const core = results.filter((r) => r.id.startsWith("Q"));
const corePass = core.filter((r) => r.pass).length;
console.log(`\nCore 9: ${corePass}/9 passed (grading bar: ≥7/9). Overall: ${results.filter((r) => r.pass).length}/${results.length}`);

import { writeFileSync } from "node:fs";
writeFileSync(new URL("../test-results.json", import.meta.url), JSON.stringify({
  run: new Date().toISOString(), base: BASE, corePass, coreTotal: 9,
  overallPass: results.filter((r) => r.pass).length, overallTotal: results.length, results,
}, null, 2));
console.log("Full log written to test-results.json");
