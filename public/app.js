// Order Assistant — frontend
(() => {
  // ---------- State ----------
  let history = [];            // Anthropic-format message history (opaque to UI)
  let verified = null;         // { name, email } once verified in chat
  let busy = false;

  const $ = (id) => document.getElementById(id);
  const chatMessages = $("chat-messages");
  const chatScroll = $("chat-scroll");
  const typing = $("typing");
  const input = $("chat-input");

  // ---------- Tabs ----------
  const titles = { assistant: "Order Assistant", orders: "Your Orders", returns: "Returns", account: "Account" };
  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === "screen-" + name));
    $("screen-title").textContent = titles[name];
    if (name === "orders") renderOrders();
    if (name === "account") renderAccount();
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  document.addEventListener("click", (e) => {
    const goto = e.target.closest("[data-goto]");
    if (goto) switchTab(goto.dataset.goto);
  });

  // ---------- Chat ----------
  function addMsg(text, who) {
    const div = document.createElement("div");
    div.className = "msg " + who;
    div.textContent = text;
    chatMessages.appendChild(div);
    chatScroll.scrollTop = chatScroll.scrollHeight;
    return div;
  }

  async function loadWelcome() {
    try {
      const r = await fetch("/api/welcome").then((r) => r.json());
      addMsg(r.welcome, "bot");
    } catch {
      addMsg("Hi! I'm Order Assistant. Ask me about your order status, tracking, or returns.", "bot");
    }
  }

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    addMsg(text, "user");
    history.push({ role: "user", content: text });

    busy = true;
    $("send-btn").disabled = true;
    typing.hidden = false;
    chatScroll.appendChild(typing);
    chatScroll.scrollTop = chatScroll.scrollHeight;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      history = data.messages;
      if (data.verifiedCustomer) setVerified(data.verifiedCustomer);
      addMsg(data.reply, "bot");
    } catch (err) {
      addMsg("Sorry — I hit a connection problem. Please try again in a moment.", "error");
      // roll back the failed user turn so history stays valid
      if (history.length && history[history.length - 1].role === "user") history.pop();
    } finally {
      busy = false;
      $("send-btn").disabled = false;
      typing.hidden = true;
    }
  });

  // ---------- Verified state ----------
  function setVerified(v) {
    verified = v;
    $("verified-chip").hidden = false;
    $("verified-chip-name").textContent = v.name.split(" ")[0];
    const emailField = $("return-email");
    if (emailField && !emailField.value) emailField.value = v.email;
  }

  // ---------- Orders tab ----------
  const pillClass = (s) => "status-pill status-" + String(s || "").toLowerCase();
  const money = (n) => "$" + Number(n).toFixed(2);

  async function renderOrders() {
    const el = $("orders-content");
    if (!verified) return; // keep empty state
    el.innerHTML = '<p class="muted">Loading your orders…</p>';
    try {
      const { orders } = await fetch("/api/orders?email=" + encodeURIComponent(verified.email)).then((r) => r.json());
      if (!orders.length) { el.innerHTML = '<div class="empty-state"><h2>No orders found</h2></div>'; return; }
      el.innerHTML =
        `<p class="muted">${orders.length} order${orders.length > 1 ? "s" : ""} for ${verified.name}</p>` +
        orders.map((o) => `
          <div class="card order-card">
            <div class="order-head">
              <span class="order-id">${o.OrderID}</span>
              <span class="${pillClass(o.Status)}">${o.Status}</span>
            </div>
            <div class="order-product">${o.Product}</div>
            <div class="order-meta">
              <span>Qty <b>${o.Quantity}</b></span>
              <span>Total <b>${money(o.TotalAmount)}</b></span>
              <span>Ordered <b>${o.OrderDate}</b></span>
              ${o.TrackingNumber ? `<span>Tracking <b>${o.TrackingNumber}</b></span>` : "<span>Tracking <b>—</b></span>"}
              ${o.EstimatedDelivery ? `<span>Est. delivery <b>${o.EstimatedDelivery}</b></span>` : ""}
              ${o.ShippingMethod ? `<span>Shipping <b>${o.ShippingMethod}</b></span>` : ""}
            </div>
          </div>`).join("");
    } catch {
      el.innerHTML = '<div class="empty-state"><h2>Couldn\'t load orders</h2><p>Please try again.</p></div>';
    }
  }

  // ---------- Returns tab ----------
  $("return-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("return-result");
    out.innerHTML = '<p class="muted">Submitting…</p>';
    try {
      const res = await fetch("/api/return", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: $("return-order-id").value.trim(),
          email: $("return-email").value.trim(),
          reason: $("return-reason").value.trim(),
        }),
      }).then((r) => r.json());
      out.innerHTML = res.success
        ? `<div class="card confirm-card">
             <h2>Return started ✓</h2>
             <div class="confirm-id">${res.returnId}</div>
             <p class="muted">${res.message}</p>
           </div>`
        : `<div class="card confirm-card fail"><h2>Couldn't start return</h2><p class="muted">${res.message}</p></div>`;
      if (res.success) $("return-form").reset();
    } catch {
      out.innerHTML = '<div class="card confirm-card fail"><h2>Connection error</h2><p class="muted">Please try again.</p></div>';
    }
  });

  // ---------- Account tab ----------
  function renderAccount() {
    if (!verified) return; // keep empty state
    const initials = verified.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    fetch("/api/orders?email=" + encodeURIComponent(verified.email))
      .then((r) => r.json())
      .then(({ orders }) => {
        const active = orders.filter((o) => ["Processing", "Shipped"].includes(o.Status)).length;
        $("account-content").innerHTML = `
          <div class="card account-card">
            <div class="avatar">${initials}</div>
            <h2>${verified.name}</h2>
            <p class="muted">${verified.email}</p>
            <span class="verified-chip">✓ Verified this session</span>
            <div class="account-stats">
              <div class="stat"><b>${orders.length}</b><span>Orders</span></div>
              <div class="stat"><b>${active}</b><span>Active</span></div>
            </div>
          </div>`;
      });
  }

  // ---------- Service worker ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

  loadWelcome();
})();
