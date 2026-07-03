# Order Assistant — AI Customer Service Agent (BIA 658 Project 1)

A mobile-first PWA customer service agent powered by the Claude API with tool use.
Every factual answer comes from a tool call against `data/orders.json` (parsed from
CustomerOrders-Summer26.xlsx + 5 extension rows) — never from model memory.

## Architecture

```
Excel (CustomerOrders-Summer26.xlsx)
   └─► data/orders.json  (12 original + 5 new rows = 17 orders)
          └─► server.js  (zero-dependency Node server)
                 ├─ Tools: lookup_order_by_id, lookup_orders_by_customer,
                 │         lookup_orders_by_status, verify_customer, start_return
                 ├─ Claude API (key server-side only, via env var)
                 └─► public/  (PWA: Assistant chat, Orders, Returns, Account)
```

## Run locally

```
cp .env.example .env      # paste your ANTHROPIC_API_KEY
node server.js            # http://localhost:3000  (no npm install needed — zero deps)
```

## Test suite

With the server running:

```
node scripts/test-agent.mjs   # writes test-results.json
```

Covers the 9 required assignment questions, off-topic guardrails, the 5 new data
rows (incl. the Maria Johnson 3-order edge case), the conversational email
verification flow (positive + negative), Spanish/French language mirroring, and
the conversational returns workflow.

## Deploy to Render (free)

1. Push this folder to a GitHub repo.
2. On https://render.com: New → Web Service → connect the repo.
3. Runtime Node, build `npm install`, start `node server.js` (or let render.yaml do it).
4. Add environment variable `ANTHROPIC_API_KEY`.
5. Open the https URL in Safari on iPhone → Share → **Add to Home Screen**.

## Security note

The Claude API key lives only in the server environment. The browser talks to
`/api/chat`; it never sees the key or the Anthropic API.
