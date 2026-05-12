// Minimal vanilla SPA. Hash router, role-based views, JWT in localStorage.
// All API calls hit same-origin /api/* — NGINX in front of us proxies to the
// correct backend service.
//
// Bundled with esbuild (`npm run build` → dist/app.js, IIFE). Deps:
//   - @microsoft/fetch-event-source — SSE over fetch() so the JWT rides in the
//     Authorization header instead of a `?token=` query string.
//   - leaflet — maps; bundled (no CDN). Styles come from dist/styles.css.

import { fetchEventSource } from "@microsoft/fetch-event-source";
import L from "leaflet";
import markerIconUrl from "leaflet/dist/images/marker-icon.png";
import markerIcon2xUrl from "leaflet/dist/images/marker-icon-2x.png";
import markerShadowUrl from "leaflet/dist/images/marker-shadow.png";

// Leaflet derives its default marker-icon URLs from the script's own location,
// which is wrong under a bundler. Point it at the assets esbuild emitted.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIcon2xUrl,
  shadowUrl: markerShadowUrl,
});

// ---------- auth store ------------------------------------------------------

const TOKEN_KEY = 'fd.token';
const RESTAURANT_KEY = 'fd.myRestaurantId';

function saveToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function clearAuth() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(RESTAURANT_KEY); }

function parseJwt(t) {
  try {
    const [, payload] = t.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}

function currentUser() {
  const t = getToken();
  if (!t) return null;
  const c = parseJwt(t);
  if (!c) return null;
  if (c.exp && c.exp * 1000 < Date.now()) { clearAuth(); return null; }
  return { id: c.user_id || c.sub, role: c.role, claims: c };
}

// ---------- API client ------------------------------------------------------

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `${res.status} ${res.statusText}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- SSE client ------------------------------------------------------
// Reads a Server-Sent Events stream over fetch() (via fetch-event-source) so
// the Bearer token goes in the Authorization header — native EventSource can't
// set headers. Reconnects automatically (the library's default). Returns a
// handle whose .close() aborts the stream; the call sites still treat it like
// the old EventSource object.
function startSSE(path, { query = '', onMessage } = {}) {
  const ctl = new AbortController();
  const qs = query ? `?${query}` : '';
  const t = getToken();
  fetchEventSource(`/api${path}${qs}`, {
    headers: t ? { Authorization: `Bearer ${t}` } : {},
    signal: ctl.signal,
    // Keep streaming even when the tab is hidden (a backgrounded driver
    // must still receive offers); matches EventSource's behaviour.
    openWhenHidden: true,
    onmessage(ev) {
      if (!ev.data) return; // skip `:hb` comment heartbeats
      try { onMessage(ev.data); } catch { /* ignore malformed frames */ }
    },
    onerror() { /* swallow → fetch-event-source retries with backoff */ },
  }).catch(() => { /* aborted via ctl.abort() */ });
  return { close() { ctl.abort(); } };
}

const API = {
  register: (b) => api('POST', '/auth/register', b),
  login: (b) => api('POST', '/auth/login', b),
  me: () => api('GET', '/users/me'),

  listRestaurants: (q = '') => api('GET', `/restaurants${q}`),
  getRestaurant: (id) => api('GET', `/restaurants/${id}`),
  myRestaurant: () => api('GET', `/restaurants/mine`),
  createRestaurant: (b) => api('POST', `/restaurants`, b),
  patchRestaurant: (id, b) => api('PATCH', `/restaurants/${id}`, b),
  getMenu: (id) => api('GET', `/restaurants/${id}/menu`),
  createMenuItem: (id, b) => api('POST', `/restaurants/${id}/menu`, b),
  patchMenuItem: (id, it, b) => api('PATCH', `/restaurants/${id}/menu/${it}`, b),
  deleteMenuItem: (id, it) => api('DELETE', `/restaurants/${id}/menu/${it}`),

  placeOrder: (b) => api('POST', '/orders', b),
  payOrder: (b) => api('POST', '/payments', b),
  getOrderPayment: (id) => api('GET', `/payments/by-order/${id}`),
  collectCash: (id) => api('POST', `/payments/by-order/${id}/collect`),
  getOrder: (id) => api('GET', `/orders/${id}`),
  listOrders: (q) => api('GET', `/orders${q}`),
  setOrderStatus: (id, s) => api('PATCH', `/orders/${id}/status`, { status: s }),
  postLocation: (id, b) => api('POST', `/orders/${id}/location`, b),
  getLocation: (id) => api('GET', `/orders/${id}/location`),

  // dispatch-service
  driverHeartbeat: (b) => api('POST', `/dispatch/drivers/heartbeat`, b),
  driverOff: () => api('POST', `/dispatch/drivers/off`),
  acceptOffer: (id) => api('POST', `/dispatch/assignments/${id}/accept`),
  rejectOffer: (id) => api('POST', `/dispatch/assignments/${id}/reject`),
};

// ---------- DOM helpers -----------------------------------------------------

const app = () => document.getElementById('app');
const navEl = () => document.getElementById('nav');

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function render(node) {
  app().replaceChildren(typeof node === 'string' ? el(node) : node);
}

function flash(msg, kind = 'error') {
  const colour = kind === 'error' ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800';
  const banner = el(`<div class="fixed top-3 right-3 px-4 py-2 rounded shadow ${colour}">${msg}</div>`);
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 3000);
}

function fmtMoney(s) {
  if (s == null) return '';
  const n = typeof s === 'string' ? parseFloat(s) : s;
  return `EGP ${n.toFixed(2)}`;
}

// ---------- map helpers -----------------------------------------------------

const DEFAULT_CENTER = [30.0444, 31.2357]; // Cairo
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '© OpenStreetMap';

// Click-to-pick map. `initial` is [lat,lng] or null. Calls onPick({lat,lng}).
// Returns { setLatLng } so the caller can programmatically move the pin.
function pickerMap(elId, initial, onPick) {
  const start = initial || DEFAULT_CENTER;
  const map = L.map(elId).setView(start, initial ? 15 : 12);
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);
  let marker = initial ? L.marker(start).addTo(map) : null;
  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    if (marker) marker.setLatLng([lat, lng]);
    else marker = L.marker([lat, lng]).addTo(map);
    onPick({ lat, lng });
  });
  return {
    setLatLng: (lat, lng) => {
      if (marker) marker.setLatLng([lat, lng]);
      else marker = L.marker([lat, lng]).addTo(map);
      map.panTo([lat, lng]);
    },
  };
}

// ---------- nav -------------------------------------------------------------

function renderNav() {
  const u = currentUser();
  navEl().innerHTML = '';
  if (!u) {
    navEl().append(
      el(`<a href="#/login" class="hover:underline">Login</a>`),
      el(`<a href="#/register" class="hover:underline">Register</a>`),
    );
    return;
  }
  const links = {
    customer: [['#/c/restaurants', 'Browse'], ['#/c/orders', 'My Orders']],
    restaurant: [['#/r/orders', 'Orders'], ['#/r/menu', 'Menu']],
    delivery: [['#/d/orders', 'Deliveries']],
  }[u.role] || [];
  for (const [h, label] of links) {
    navEl().append(el(`<a href="${h}" class="hover:underline">${label}</a>`));
  }
  navEl().append(el(`<span class="text-slate-500">${u.role}</span>`));
  const out = el(`<button class="text-slate-600 hover:underline">Logout</button>`);
  out.onclick = () => { clearAuth(); location.hash = '#/login'; };
  navEl().append(out);
}

// ---------- views: auth -----------------------------------------------------

function viewLogin() {
  const v = el(`
    <section class="max-w-sm mx-auto bg-white p-6 rounded shadow">
      <h1 class="text-xl font-semibold mb-4">Login</h1>
      <form class="space-y-3">
        <input name="email" type="email" placeholder="email" required class="w-full border rounded px-3 py-2" />
        <input name="password" type="password" placeholder="password" required class="w-full border rounded px-3 py-2" />
        <button class="w-full bg-slate-900 text-white py-2 rounded">Login</button>
      </form>
      <p class="text-sm mt-3 text-slate-600">Need an account? <a href="#/register" class="underline">Register</a></p>
    </section>`);
  v.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { token } = await API.login({ email: fd.get('email'), password: fd.get('password') });
      saveToken(token);
      goHome();
    } catch (err) { flash(err.message); }
  };
  render(v);
}

function viewRegister() {
  const v = el(`
    <section class="max-w-sm mx-auto bg-white p-6 rounded shadow">
      <h1 class="text-xl font-semibold mb-4">Register</h1>
      <form class="space-y-3">
        <input name="full_name" placeholder="full name" required class="w-full border rounded px-3 py-2" />
        <input name="email" type="email" placeholder="email" required class="w-full border rounded px-3 py-2" />
        <input name="phone" placeholder="phone" required class="w-full border rounded px-3 py-2" />
        <input name="password" type="password" placeholder="password" required class="w-full border rounded px-3 py-2" />
        <select name="role" required class="w-full border rounded px-3 py-2">
          <option value="customer">Customer</option>
          <option value="restaurant">Restaurant owner</option>
          <option value="delivery">Delivery</option>
        </select>
        <button class="w-full bg-slate-900 text-white py-2 rounded">Create account</button>
      </form>
      <p class="text-sm mt-3 text-slate-600">Have an account? <a href="#/login" class="underline">Login</a></p>
    </section>`);
  v.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { token } = await API.register(Object.fromEntries(fd.entries()));
      saveToken(token);
      goHome();
    } catch (err) { flash(err.message); }
  };
  render(v);
}

// ---------- views: customer -------------------------------------------------

const cart = { restaurantId: null, items: {}, destination: null }; // { menuItemId -> { item, qty } }

function cartTotal() {
  return Object.values(cart.items).reduce((s, l) => s + l.qty * parseFloat(l.item.price), 0);
}

async function viewCustomerRestaurants() {
  render(el(`<section><h1 class="text-xl font-semibold mb-4">Restaurants</h1><div id="list" class="grid sm:grid-cols-2 gap-3"></div></section>`));
  try {
    const list = await API.listRestaurants();
    const items = (list || []).map(r => `
      <a href="#/c/restaurants/${r.id}" class="bg-white p-4 rounded shadow hover:shadow-md transition">
        <div class="font-medium">${r.name} ${r.is_open ? '' : '<span class="text-xs text-red-600">(closed)</span>'}</div>
        <div class="text-sm text-slate-600">${r.cuisine || ''}</div>
        <div class="text-sm text-slate-500 mt-1">${r.address || ''}</div>
      </a>`).join('');
    document.getElementById('list').innerHTML = items || '<p class="text-slate-600">No restaurants yet.</p>';
  } catch (err) { flash(err.message); }
}

async function viewCustomerRestaurant(id) {
  render(el(`<section><a href="#/c/restaurants" class="text-sm text-slate-600">← Restaurants</a>
    <div id="head" class="mt-2"></div>
    <div class="grid md:grid-cols-3 gap-4 mt-4">
      <div id="menu" class="md:col-span-2 space-y-2"></div>
      <aside class="bg-white p-4 rounded shadow self-start space-y-3">
        <div id="cart-lines"></div>
        <div>
          <label class="block text-sm text-slate-700 mb-1">Delivery destination (click map)</label>
          <div id="dest-map"></div>
          <p id="dest-readout" class="text-xs text-slate-500 mt-1">No destination picked.</p>
        </div>
        <input id="addr" placeholder="Delivery address" class="w-full border rounded px-2 py-1 text-sm" />
        <button id="place" class="w-full bg-emerald-600 text-white py-2 rounded text-sm disabled:opacity-50" disabled>Place order</button>
      </aside>
    </div></section>`));
  if (cart.restaurantId !== id) { cart.restaurantId = id; cart.items = {}; cart.destination = null; }
  try {
    const [r, menu] = await Promise.all([API.getRestaurant(id), API.getMenu(id)]);
    const closedBanner = r.is_open ? '' :
      `<p class="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mt-2">This restaurant is not accepting orders right now. You can browse the menu, but checkout is disabled until they reopen.</p>`;
    const closedTag = r.is_open ? '' : '<span class="text-sm text-red-600 align-middle">(closed)</span>';
    document.getElementById('head').innerHTML =
      `<h1 class="text-xl font-semibold">${r.name} ${closedTag}</h1>` +
      `<p class="text-slate-600">${r.description || ''}</p>` +
      closedBanner;
    cart.restaurantOpen = !!r.is_open;
    const menuEl = document.getElementById('menu');
    menuEl.innerHTML = (menu || []).map(m => `
      <div class="bg-white p-3 rounded shadow flex items-center justify-between">
        <div>
          <div class="font-medium">${m.name}</div>
          <div class="text-sm text-slate-600">${m.description || ''}</div>
          <div class="text-sm text-slate-500">${fmtMoney(m.price)} ${m.is_available ? '' : '<span class="text-red-600">unavailable</span>'}</div>
        </div>
        <button data-id="${m.id}" class="add bg-slate-900 text-white px-3 py-1 rounded ${m.is_available ? '' : 'opacity-50 pointer-events-none'}">Add</button>
      </div>`).join('') || '<p class="text-slate-600">Empty menu.</p>';
    menuEl.querySelectorAll('button.add').forEach(b => {
      b.onclick = () => {
        const item = menu.find(x => x.id === b.dataset.id);
        const line = cart.items[item.id] || { item, qty: 0 };
        line.qty += 1; cart.items[item.id] = line;
        renderCartLines();
      };
    });

    // Center the picker on the restaurant if it has coordinates.
    const initial = (r.latitude != null && r.longitude != null) ? [r.latitude, r.longitude] : null;
    pickerMap('dest-map', initial, ({ lat, lng }) => {
      cart.destination = { lat, lng };
      document.getElementById('dest-readout').textContent =
        `Destination: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      refreshPlaceBtn();
    });

    renderCartLines();
    document.getElementById('addr').oninput = refreshPlaceBtn;
    document.getElementById('place').onclick = async () => {
      const addr = document.getElementById('addr').value.trim();
      if (!addr) return flash('Address required');
      if (!cart.destination) return flash('Pick a destination on the map');
      const lines = Object.values(cart.items);
      try {
        const order = await API.placeOrder({
          restaurant_id: id,
          delivery_address: addr,
          delivery_latitude: cart.destination.lat,
          delivery_longitude: cart.destination.lng,
          items: lines.map(l => ({ menu_item_id: l.item.id, quantity: l.qty })),
        });
        cart.items = {}; cart.restaurantId = null; cart.destination = null;
        flash('Cart saved — choose a payment method to place your order', 'ok');
        location.hash = `#/c/checkout/${order.id}`;
      } catch (err) { flash(err.message); }
    };
  } catch (err) { flash(err.message); }
}

function refreshPlaceBtn() {
  const btn = document.getElementById('place');
  if (!btn) return;
  const lines = Object.values(cart.items);
  const addrEl = document.getElementById('addr');
  const open = cart.restaurantOpen !== false;
  const ok = open && lines.length > 0 && cart.destination && addrEl && addrEl.value.trim();
  btn.disabled = !ok;
  btn.textContent = open ? 'Place order' : 'Restaurant closed';
}

function renderCartLines() {
  const lines = Object.values(cart.items);
  const target = document.getElementById('cart-lines');
  if (!target) return;
  target.innerHTML = `
    <h2 class="font-semibold mb-2">Cart</h2>
    ${lines.length === 0 ? '<p class="text-sm text-slate-500">Empty.</p>' : `
      <ul class="text-sm space-y-1">
        ${lines.map(l => `<li class="flex justify-between"><span>${l.qty}× ${l.item.name}</span><span>${fmtMoney(l.qty * parseFloat(l.item.price))}</span></li>`).join('')}
      </ul>
      <div class="border-t mt-2 pt-2 text-sm flex justify-between font-medium"><span>Subtotal</span><span>${fmtMoney(cartTotal())}</span></div>`}
  `;
  refreshPlaceBtn();
}

async function viewCustomerCheckout(orderId) {
  render(el(`<section class="max-w-md mx-auto bg-white p-6 rounded shadow">
    <h1 class="text-xl font-semibold mb-1">Checkout</h1>
    <p class="text-sm text-slate-600 mb-4">Order <span class="font-mono">${orderId.slice(0, 8)}…</span></p>
    <div id="summary" class="text-sm mb-4">Loading…</div>

    <div class="flex gap-2 mb-4">
      <button data-method="card" class="method flex-1 border rounded py-2 text-sm">Card</button>
      <button data-method="cash" class="method flex-1 border rounded py-2 text-sm">Cash on delivery</button>
    </div>

    <form id="pay" class="space-y-3">
      <div id="card-fields" class="space-y-3">
        <input name="card_number" placeholder="Card number (e.g. 4242 4242 4242 4242)" class="w-full border rounded px-3 py-2 font-mono tracking-wider" autocomplete="cc-number" />
        <div class="grid grid-cols-2 gap-3">
          <input name="exp" placeholder="MM/YY" class="border rounded px-3 py-2 font-mono" autocomplete="cc-exp" />
          <input name="cvv" placeholder="CVV" class="border rounded px-3 py-2 font-mono" autocomplete="cc-csc" />
        </div>
        <input name="cardholder" placeholder="Name on card" class="w-full border rounded px-3 py-2" autocomplete="cc-name" />
      </div>
      <p id="cash-note" class="hidden text-sm text-slate-700 bg-slate-50 border rounded p-3">Pay the driver in cash on delivery. The restaurant will start preparing once they accept your order.</p>
      <button id="pay-btn" class="w-full bg-emerald-600 text-white py-2 rounded">Pay</button>
      <p id="card-hint" class="text-xs text-slate-500">Demo: any card succeeds, except numbers ending in <span class="font-mono">0000</span> which simulate a decline. No real payment is taken.</p>
    </form>
  </section>`));

  let order;
  try { order = await API.getOrder(orderId); }
  catch (err) { flash(err.message); return; }

  if (order.status !== 'DRAFT') {
    // Once a payment method has been chosen the order has left DRAFT and
    // checkout is no longer the right page — bounce to the order detail.
    flash(order.paid ? 'Already paid' : 'Order already placed', 'ok');
    location.hash = `#/c/orders/${orderId}`;
    return;
  }

  document.getElementById('summary').innerHTML = `
    <div class="flex justify-between"><span>Subtotal</span><span>${fmtMoney(order.subtotal)}</span></div>
    <div class="flex justify-between"><span>Delivery</span><span>${fmtMoney(order.delivery_fee)}</span></div>
    <div class="flex justify-between font-semibold border-t mt-1 pt-1"><span>Total</span><span>${fmtMoney(order.total)}</span></div>
  `;

  let method = 'card';
  const setMethod = (m) => {
    method = m;
    document.querySelectorAll('button.method').forEach(b => {
      const on = b.dataset.method === m;
      b.className = `method flex-1 border rounded py-2 text-sm ${on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700'}`;
    });
    document.getElementById('card-fields').classList.toggle('hidden', m !== 'card');
    document.getElementById('cash-note').classList.toggle('hidden', m !== 'cash');
    document.getElementById('card-hint').classList.toggle('hidden', m !== 'card');
    document.getElementById('pay-btn').textContent = m === 'cash' ? 'Confirm cash order' : 'Pay';
    // Required attribute toggled so the form doesn't validate hidden card fields.
    ['card_number', 'exp', 'cvv', 'cardholder'].forEach(n => {
      const el = document.querySelector(`[name="${n}"]`);
      if (el) el.required = (m === 'card');
    });
  };
  document.querySelectorAll('button.method').forEach(b => {
    b.onclick = (e) => { e.preventDefault(); setMethod(b.dataset.method); };
  });
  setMethod('card');

  // Auto-format MM/YY: insert "/" after the second digit, drop it when
  // backspacing from "MM/" so the next press edits the month digit.
  const expInput = document.querySelector('input[name="exp"]');
  if (expInput) {
    expInput.addEventListener('input', (e) => {
      const isDelete = e.inputType && e.inputType.startsWith('delete');
      const digits = expInput.value.replace(/\D/g, '').slice(0, 4);
      if (digits.length >= 3) {
        expInput.value = digits.slice(0, 2) + '/' + digits.slice(2);
      } else if (digits.length === 2 && !isDelete) {
        expInput.value = digits + '/';
      } else {
        expInput.value = digits;
      }
    });
  }

  document.getElementById('pay').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = document.getElementById('pay-btn');
    btn.disabled = true;
    btn.textContent = method === 'cash' ? 'Confirming…' : 'Charging…';
    try {
      await API.payOrder({
        order_id: orderId,
        amount: parseFloat(order.total),
        method,
        card_number: method === 'card' ? fd.get('card_number') : '',
      });
      flash(method === 'cash' ? 'Order confirmed — pay the driver on delivery' : 'Payment approved', 'ok');
      location.hash = `#/c/orders/${orderId}`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = method === 'cash' ? 'Confirm cash order' : 'Pay';
      flash(err.message);
      if (err.status === 402) {
        setTimeout(() => { location.hash = `#/c/orders/${orderId}`; }, 1200);
      }
    }
  };
}

async function viewCustomerOrders() {
  const u = currentUser();
  render(el(`<section><h1 class="text-xl font-semibold mb-4">My Orders</h1><div id="list" class="space-y-2"></div></section>`));
  const refresh = async () => {
    const list = await API.listOrders(`?customer_id=${u.id}`);
    const target = document.getElementById('list');
    if (!target) return;
    target.innerHTML = (list || []).map(orderRow).join('') || '<p class="text-slate-600">No orders yet.</p>';
  };
  try { await refresh(); } catch (err) { flash(err.message); }
  openOrdersStream({}, refresh);
}

function orderRow(o) {
  if (o.status === 'DRAFT') {
    // Customer left checkout without choosing a payment method. Surface
    // the order with a high-visibility prompt to resume.
    return `<div class="block bg-amber-50 border border-amber-200 p-3 rounded shadow">
      <div class="flex justify-between items-center">
        <div>
          <div class="font-medium">Order ${o.id.slice(0, 8)}…</div>
          <div class="text-sm text-slate-500">${new Date(o.created_at).toLocaleString()}</div>
          <div class="text-xs text-amber-800 mt-1 font-medium">Awaiting payment — your order isn't placed yet.</div>
        </div>
        <div class="text-right text-sm text-slate-600">${fmtMoney(o.total)}</div>
      </div>
      <a href="#/c/checkout/${o.id}" class="block mt-2 w-full bg-emerald-600 text-white text-center py-2 rounded text-sm">Resume checkout</a>
    </div>`;
  }
  return `<a href="#/c/orders/${o.id}" class="block bg-white p-3 rounded shadow flex justify-between items-center">
    <div>
      <div class="font-medium">Order ${o.id.slice(0, 8)}…</div>
      <div class="text-sm text-slate-500">${new Date(o.created_at).toLocaleString()}</div>
    </div>
    <div class="text-right">
      <div class="text-sm">${o.status}</div>
      <div class="text-sm text-slate-600">${fmtMoney(o.total)}</div>
    </div>
  </a>`;
}

const STATUS_FLOW = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED'];

function statusTimeline(status) {
  if (status === 'DRAFT') {
    return `<div class="text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 text-sm">Awaiting payment — choose a method to place the order.</div>`;
  }
  if (status === 'REJECTED' || status === 'CANCELLED') {
    return `<div class="text-red-700 font-medium">${status}</div>`;
  }
  const idx = STATUS_FLOW.indexOf(status);
  return `<ol class="flex flex-wrap gap-2 text-xs">
    ${STATUS_FLOW.map((s, i) => `<li class="px-2 py-1 rounded ${i <= idx ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'}">${s}</li>`).join('')}
  </ol>`;
}

let pollTimer = null;
let trackEventSource = null;
let ordersStream = null;
let mapInstance = null;
let mapMarker = null;
let destMarker = null;

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (trackEventSource) { trackEventSource.close(); trackEventSource = null; }
  if (mapInstance) { mapInstance.remove(); mapInstance = null; mapMarker = null; destMarker = null; }
}

function stopListPolling() {
  if (ordersStream) { ordersStream.close(); ordersStream = null; }
}

// Wraps a refresh fn so transient errors don't spam the toast.
function pollSilently(fn) {
  return () => { fn().catch(() => { }); };
}

// Subscribe to /orders/stream. `query` is passed through as the query string
// (use it to pass restaurant_id for the restaurant role). `idFilter` reacts
// only to events for one order id (single-order views).
function openOrdersStream({ query = '', idFilter = null } = {}, refresh) {
  if (ordersStream) ordersStream.close();
  const safeRefresh = pollSilently(refresh);
  ordersStream = startSSE('/orders/stream', {
    query,
    onMessage: (raw) => {
      const data = JSON.parse(raw);
      if (idFilter && data.order_id !== idFilter) return;
      safeRefresh();
    },
  });
}

async function viewCustomerOrder(id) {
  // Skeleton rendered once. Only #order-summary and #status-bar are
  // re-rendered on each poll so the #map div (with its Leaflet instance)
  // is never detached.
  render(el(`<section><a href="#/c/orders" class="text-sm text-slate-600">← Orders</a>
    <h1 id="order-title" class="text-xl font-semibold mt-3 mb-2"></h1>
    <div id="status-bar"></div>
    <div class="grid md:grid-cols-2 gap-4 mt-4">
      <div id="order-summary" class="bg-white p-4 rounded shadow"></div>
      <div class="bg-white p-4 rounded shadow">
        <h2 class="font-semibold mb-2">Live tracking</h2>
        <div id="map" class="bg-slate-100"></div>
        <p id="map-note" class="text-xs text-slate-500 mt-2">Map activates when the order is picked up.</p>
      </div>
    </div></section>`));

  const refresh = async () => {
    try {
      const o = await API.getOrder(id);
      let payment = null;
      try { payment = await API.getOrderPayment(id); }
      catch (e) { if (e.status !== 404) console.warn(e); }
      document.getElementById('order-title').textContent = `Order ${o.id.slice(0, 8)}…`;
      document.getElementById('status-bar').innerHTML = statusTimeline(o.status);
      const itemsHtml = (o.items || []).map(i => `<li class="flex justify-between"><span>${i.quantity}× ${i.name}</span><span>${fmtMoney(parseFloat(i.unit_price) * i.quantity)}</span></li>`).join('');
      const paidLabel = o.paid
        ? (payment && payment.method === 'cash' ? 'paid (cash collected)' : 'yes')
        : (payment && payment.method === 'cash' && payment.status === 'PENDING' ? 'cash on delivery' : 'no');
      const isDraft = o.status === 'DRAFT';
      const canCancel = isDraft || o.status === 'PENDING';
      document.getElementById('order-summary').innerHTML = `
        <h2 class="font-semibold mb-2">Items</h2>
        <ul class="text-sm space-y-1">${itemsHtml}</ul>
        <div class="border-t mt-2 pt-2 text-sm space-y-1">
          <div class="flex justify-between"><span>Subtotal</span><span>${fmtMoney(o.subtotal)}</span></div>
          <div class="flex justify-between"><span>Delivery</span><span>${fmtMoney(o.delivery_fee)}</span></div>
          <div class="flex justify-between font-medium"><span>Total</span><span>${fmtMoney(o.total)}</span></div>
          <div class="flex justify-between text-slate-600"><span>Payment</span><span>${paidLabel}</span></div>
        </div>
        ${isDraft ? `<a href="#/c/checkout/${o.id}" class="block text-center mt-3 w-full bg-emerald-600 text-white py-2 rounded text-sm">Resume checkout</a>` : ''}
        ${canCancel ? `<button id="cancel" class="mt-3 w-full bg-red-600 text-white py-2 rounded text-sm">Cancel order</button>` : ''}`;
      const cancelBtn = document.getElementById('cancel');
      if (cancelBtn) cancelBtn.onclick = async () => {
        try { await API.setOrderStatus(o.id, 'CANCELLED'); refresh(); }
        catch (err) { flash(err.message); }
      };
      const dest = (o.delivery_latitude != null && o.delivery_longitude != null)
        ? { lat: o.delivery_latitude, lng: o.delivery_longitude } : null;
      if (o.status === 'PICKED_UP') {
        if (!trackEventSource) startCustomerTracking(o.id, dest);
      } else {
        stopPolling();
      }
    } catch (err) { flash(err.message); }
  };
  await refresh();
  openOrdersStream({ idFilter: id }, refresh);
}

// Destination marker uses a coloured icon so it's distinguishable from the driver.
const DEST_ICON = L.divIcon({
  className: 'fd-dest-icon',
  html: '<div style="background:#dc2626;width:18px;height:18px;border-radius:50%;border:3px solid white;box-shadow:0 0 0 1px #dc2626"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

function ensureMap(elId, driver, destination) {
  // driver/destination are {lat,lng}|null. Either or both may be present.
  const center = driver || destination;
  if (!center) return;
  if (!mapInstance) {
    mapInstance = L.map(elId).setView([center.lat, center.lng], 14);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(mapInstance);
  }
  if (destination) {
    if (!destMarker) destMarker = L.marker([destination.lat, destination.lng], { icon: DEST_ICON, title: 'Destination' }).addTo(mapInstance);
    else destMarker.setLatLng([destination.lat, destination.lng]);
  }
  if (driver) {
    if (!mapMarker) mapMarker = L.marker([driver.lat, driver.lng], { title: 'Driver' }).addTo(mapInstance);
    else mapMarker.setLatLng([driver.lat, driver.lng]);
  }
  // Fit bounds when we have both endpoints; otherwise center on driver.
  if (driver && destination) {
    mapInstance.fitBounds([[driver.lat, driver.lng], [destination.lat, destination.lng]], { padding: [30, 30] });
  } else if (driver) {
    mapInstance.panTo([driver.lat, driver.lng]);
  }
}

function startCustomerTracking(orderId, destination) {
  document.getElementById('map-note').textContent = 'Live tracking via SSE.';
  if (destination) ensureMap('map', null, destination);

  if (trackEventSource) trackEventSource.close();
  trackEventSource = startSSE(`/orders/${orderId}/location/stream`, {
    onMessage: (raw) => {
      const loc = JSON.parse(raw);
      if (loc && loc.latitude != null) {
        ensureMap('map', { lat: loc.latitude, lng: loc.longitude }, destination);
      }
    },
  });
}

// ---------- views: restaurant ----------------------------------------------

async function resolveMyRestaurantId() {
  let myId = localStorage.getItem(RESTAURANT_KEY);
  if (myId) return myId;
  try {
    const r = await API.myRestaurant();
    localStorage.setItem(RESTAURANT_KEY, r.id);
    return r.id;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function viewRestaurantOrders() {
  const u = currentUser();
  const myId = await resolveMyRestaurantId();
  if (!myId) return viewRestaurantSetup();
  render(el(`<section><h1 class="text-xl font-semibold mb-4">Restaurant Orders</h1><div id="list" class="space-y-2"></div></section>`));
  const refresh = async () => {
    try {
      const list = await API.listOrders(`?restaurant_id=${myId}`);
      document.getElementById('list').innerHTML = (list || []).map(o => `
        <div class="bg-white p-3 rounded shadow">
          <div class="flex justify-between items-start">
            <div>
              <div class="font-medium">Order ${o.id.slice(0, 8)}…</div>
              <div class="text-sm text-slate-500">${new Date(o.created_at).toLocaleString()}</div>
              <ul class="text-sm text-slate-700 mt-1">${(o.items || []).map(i => `<li>${i.quantity}× ${i.name}</li>`).join('')}</ul>
            </div>
            <div class="text-right text-sm">
              <div>${o.status}</div>
              <div class="text-slate-600">${fmtMoney(o.total)}</div>
            </div>
          </div>
          <div class="mt-2 flex gap-2 text-sm">${restaurantActions(o)}</div>
        </div>`).join('') || '<p class="text-slate-600">No orders.</p>';
      document.getElementById('list').querySelectorAll('button[data-act]').forEach(b => {
        b.onclick = async () => {
          try { await API.setOrderStatus(b.dataset.id, b.dataset.act); refresh(); }
          catch (err) { flash(err.message); }
        };
      });
    } catch (err) { flash(err.message); }
  };
  await refresh();
  openOrdersStream({ query: `restaurant_id=${encodeURIComponent(myId)}` }, refresh);
}

function restaurantActions(o) {
  const btn = (s, label, color = 'bg-slate-900') =>
    `<button data-id="${o.id}" data-act="${s}" class="${color} text-white px-3 py-1 rounded">${label}</button>`;
  const cancel = btn('CANCELLED', 'Cancel', 'bg-red-600');
  switch (o.status) {
    case 'PENDING': return btn('ACCEPTED', 'Accept', 'bg-emerald-600') + btn('REJECTED', 'Reject', 'bg-red-600');
    case 'ACCEPTED': return btn('PREPARING', 'Start preparing') + cancel;
    case 'PREPARING': return btn('READY', 'Mark ready') + cancel;
    case 'READY': return cancel;
    default: return '';
  }
}

async function viewRestaurantSetup() {
  render(el(`
    <section class="max-w-2xl mx-auto bg-white p-6 rounded shadow">
      <h1 class="text-xl font-semibold mb-4">Set up your restaurant</h1>
      <form class="space-y-3">
        <input name="name" placeholder="name" required class="w-full border rounded px-3 py-2" />
        <textarea name="description" placeholder="description" class="w-full border rounded px-3 py-2"></textarea>
        <input name="address" placeholder="address" required class="w-full border rounded px-3 py-2" />
        <input name="cuisine" placeholder="cuisine" required class="w-full border rounded px-3 py-2" />
        <input name="image_url" placeholder="image url (optional)" class="w-full border rounded px-3 py-2" />
        <div>
          <label class="block text-sm text-slate-700 mb-1">Pin your location (click the map)</label>
          <div id="loc-map"></div>
          <p id="loc-readout" class="text-xs text-slate-500 mt-1">No location picked yet — click the map.</p>
        </div>
        <button class="w-full bg-slate-900 text-white py-2 rounded">Create</button>
      </form>
    </section>`));
  let picked = null;
  pickerMap('loc-map', null, ({ lat, lng }) => {
    picked = { lat, lng };
    document.getElementById('loc-readout').textContent =
      `Picked: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  });
  app().querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    if (picked) { fd.latitude = picked.lat; fd.longitude = picked.lng; }
    try {
      const r = await API.createRestaurant(fd);
      localStorage.setItem(RESTAURANT_KEY, r.id);
      flash('Restaurant created', 'ok');
      // Setup view is rendered as a fallback from #/r/orders, so the hash is
      // already #/r/orders — assigning the same value won't fire hashchange.
      // Re-run the router to leave the setup form.
      if (location.hash === '#/r/orders') route();
      else location.hash = '#/r/orders';
    } catch (err) { flash(err.message); }
  };
}

async function viewRestaurantMenu() {
  const myId = await resolveMyRestaurantId();
  if (!myId) return viewRestaurantSetup();
  render(el(`<section>
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-xl font-semibold">Menu</h1>
      <button id="open-toggle" class="text-sm px-3 py-1 rounded bg-slate-200 text-slate-700">…</button>
    </div>
    <div class="bg-white p-4 rounded shadow mb-4">
      <h2 class="font-medium mb-2">Add item</h2>
      <form id="add" class="grid sm:grid-cols-2 gap-2">
        <input name="name" placeholder="name" required class="border rounded px-2 py-1" />
        <input name="category" placeholder="category" required class="border rounded px-2 py-1" />
        <input name="price" placeholder="price in EGP (e.g. 75.00)" required class="border rounded px-2 py-1" />
        <input name="image_url" placeholder="image url" class="border rounded px-2 py-1" />
        <textarea name="description" placeholder="description" class="border rounded px-2 py-1 sm:col-span-2"></textarea>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="is_available" checked /> Available</label>
        <button class="bg-slate-900 text-white py-2 rounded sm:col-span-2">Add</button>
      </form>
    </div>
    <div id="list" class="space-y-2"></div>
  </section>`));
  const refresh = async () => {
    try {
      const items = await API.getMenu(myId);
      document.getElementById('list').innerHTML = (items || []).map(m => `
        <div class="bg-white p-3 rounded shadow flex items-center justify-between">
          <div>
            <div class="font-medium">${m.name} <span class="text-xs text-slate-500">${m.category}</span></div>
            <div class="text-sm text-slate-600">${fmtMoney(m.price)} ${m.is_available ? '' : '<span class="text-red-600">unavailable</span>'}</div>
          </div>
          <div class="flex gap-2">
            <button data-id="${m.id}" data-toggle="${m.is_available}" class="toggle bg-slate-200 px-3 py-1 rounded text-sm">${m.is_available ? 'Disable' : 'Enable'}</button>
            <button data-id="${m.id}" class="del bg-red-600 text-white px-3 py-1 rounded text-sm">Delete</button>
          </div>
        </div>`).join('') || '<p class="text-slate-600">No items.</p>';
      document.getElementById('list').querySelectorAll('button.del').forEach(b => {
        b.onclick = async () => {
          try { await API.deleteMenuItem(myId, b.dataset.id); refresh(); }
          catch (err) { flash(err.message); }
        };
      });
      document.getElementById('list').querySelectorAll('button.toggle').forEach(b => {
        b.onclick = async () => {
          try { await API.patchMenuItem(myId, b.dataset.id, { is_available: b.dataset.toggle !== 'true' }); refresh(); }
          catch (err) { flash(err.message); }
        };
      });
    } catch (err) { flash(err.message); }
  };
  const renderOpenToggle = (isOpen) => {
    const btn = document.getElementById('open-toggle');
    btn.textContent = isOpen ? 'Open — accepting orders' : 'Closed — click to open';
    btn.className = 'text-sm px-3 py-1 rounded ' + (isOpen ? 'bg-emerald-600 text-white' : 'bg-slate-300 text-slate-800');
    btn.onclick = async () => {
      try {
        const updated = await API.patchRestaurant(myId, { is_open: !isOpen });
        renderOpenToggle(updated.is_open);
        flash(updated.is_open ? 'Now accepting orders' : 'Closed', 'ok');
      } catch (err) { flash(err.message); }
    };
  };
  try {
    const r = await API.getRestaurant(myId);
    renderOpenToggle(!!r.is_open);
  } catch (err) { flash(err.message); }

  document.getElementById('add').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.price = parseFloat(body.price);
    body.is_available = fd.get('is_available') === 'on';
    try { await API.createMenuItem(myId, body); e.target.reset(); refresh(); }
    catch (err) { flash(err.message); }
  };
  await refresh();
}

// ---------- views: delivery -------------------------------------------------

// Driver dashboard. Replaces the old self-claim lobby with the dispatch
// service's push flow: rider goes Available → heartbeats every 8s →
// receives offers via SSE → accepts/rejects → if accepted, the order shows
// up in the active list (driver_id was set by order-service consuming
// dispatch's delivery.assigned event).

const DISPATCH_KEY = 'fd.dispatch.available';
const DISPATCH_SIM_KEY = 'fd.dispatch.sim';
const DISPATCH_SIM_LOC_KEY = 'fd.dispatch.simLocation';
const DISPATCH_HEARTBEAT_MS = 8_000;

let dispatchHeartbeatTimer = null;
let dispatchStream = null;
let dispatchGeoWatchId = null;
let dispatchLastFix = null;

function isDispatchAvailable() { return localStorage.getItem(DISPATCH_KEY) === '1'; }
function setDispatchAvailable(v) {
  if (v) localStorage.setItem(DISPATCH_KEY, '1');
  else localStorage.removeItem(DISPATCH_KEY);
}
function isDispatchSim() { return localStorage.getItem(DISPATCH_SIM_KEY) === '1'; }
function setDispatchSim(v) {
  if (v) localStorage.setItem(DISPATCH_SIM_KEY, '1');
  else localStorage.removeItem(DISPATCH_SIM_KEY);
}
function getSimLocation() {
  try { return JSON.parse(localStorage.getItem(DISPATCH_SIM_LOC_KEY) || 'null'); }
  catch { return null; }
}
function setSimLocation(loc) {
  if (loc) localStorage.setItem(DISPATCH_SIM_LOC_KEY, JSON.stringify(loc));
  else localStorage.removeItem(DISPATCH_SIM_LOC_KEY);
}

async function postHeartbeat() {
  const fix = isDispatchSim()
    ? getSimLocation()
    : (dispatchLastFix ? { lat: dispatchLastFix.lat, lon: dispatchLastFix.lon } : null);
  if (!fix) return;
  try { await API.driverHeartbeat(fix); } catch (err) { console.warn('heartbeat failed', err); }
}

function startDispatchPresence() {
  stopDispatchPresence();
  if (isDispatchSim()) {
    if (!getSimLocation()) {
      flash('Pick your location on the map first.');
      return;
    }
    dispatchHeartbeatTimer = setInterval(postHeartbeat, DISPATCH_HEARTBEAT_MS);
    postHeartbeat();
  } else {
    if (!navigator.geolocation) {
      flash('Geolocation not supported. Switch to simulated mode.');
      return;
    }
    dispatchGeoWatchId = navigator.geolocation.watchPosition(
      (p) => { dispatchLastFix = { lat: p.coords.latitude, lon: p.coords.longitude }; },
      (err) => console.warn('geolocation error', err),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 },
    );
    dispatchHeartbeatTimer = setInterval(postHeartbeat, DISPATCH_HEARTBEAT_MS);
  }
  openDispatchStream();
}

function stopDispatchPresence() {
  if (dispatchHeartbeatTimer) { clearInterval(dispatchHeartbeatTimer); dispatchHeartbeatTimer = null; }
  if (dispatchGeoWatchId != null) {
    try { navigator.geolocation.clearWatch(dispatchGeoWatchId); } catch { /* ignore */ }
    dispatchGeoWatchId = null;
  }
  dispatchLastFix = null;
  closeDispatchStream();
}

// SSE for offer events. Server pushes {orderId, driverId, pickup,
// expires_in_s} when this driver wins the loop's current iteration.
function openDispatchStream() {
  closeDispatchStream();
  dispatchStream = startSSE('/dispatch/drivers/stream', {
    onMessage: (raw) => {
      const data = JSON.parse(raw);
      if (data.type === 'cancelled') {
        closeOfferModal();
        return;
      }
      if (data.orderId && data.expires_in_s) {
        showOfferModal(data);
      }
    },
  });
}

function closeDispatchStream() {
  if (dispatchStream) { dispatchStream.close(); dispatchStream = null; }
  closeOfferModal();
}

let offerModalEl = null;
let offerCountdown = null;
function closeOfferModal() {
  if (offerCountdown) { clearInterval(offerCountdown); offerCountdown = null; }
  if (offerModalEl) { offerModalEl.remove(); offerModalEl = null; }
}

function showOfferModal({ orderId, expires_in_s, pickup }) {
  closeOfferModal();
  let remaining = expires_in_s;
  offerModalEl = el(`
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center" style="z-index: 1000;">
      <div class="bg-white rounded shadow-lg p-5 w-80">
        <h2 class="text-lg font-semibold mb-1">New delivery offer</h2>
        <p class="text-sm text-slate-600">Order ${orderId.slice(0, 8)}…</p>
        ${pickup ? `<p class="text-xs text-slate-500 mt-1">Pickup: ${pickup.lat.toFixed(4)}, ${pickup.lon.toFixed(4)}</p>` : ''}
        <div class="mt-3 h-2 bg-slate-200 rounded overflow-hidden">
          <div id="offer-bar" class="h-full bg-emerald-500 transition-all" style="width: 100%"></div>
        </div>
        <p id="offer-countdown" class="text-xs text-slate-500 mt-1">${remaining}s left</p>
        <div class="mt-4 flex gap-2">
          <button id="offer-reject" class="flex-1 bg-slate-200 text-slate-800 px-3 py-2 rounded text-sm">Reject</button>
          <button id="offer-accept" class="flex-1 bg-emerald-600 text-white px-3 py-2 rounded text-sm">Accept</button>
        </div>
      </div>
    </div>`);
  document.body.appendChild(offerModalEl);
  const bar = offerModalEl.querySelector('#offer-bar');
  const cd = offerModalEl.querySelector('#offer-countdown');
  offerCountdown = setInterval(() => {
    remaining -= 1;
    if (bar) bar.style.width = `${Math.max(0, (remaining / expires_in_s) * 100)}%`;
    if (cd) cd.textContent = `${Math.max(0, remaining)}s left`;
    if (remaining <= 0) { closeOfferModal(); }
  }, 1000);
  offerModalEl.querySelector('#offer-accept').onclick = async () => {
    try {
      await API.acceptOffer(orderId);
      closeOfferModal();
      // Going Off-duty so we don't get more offers while delivering.
      setDispatchAvailable(false);
      stopDispatchPresence();
      flash('Order accepted', 'ok');
      location.hash = `#/d/orders/${orderId}`;
    } catch (err) {
      closeOfferModal();
      flash(err.message);
    }
  };
  offerModalEl.querySelector('#offer-reject').onclick = async () => {
    try { await API.rejectOffer(orderId); } catch { /* best effort */ }
    closeOfferModal();
  };
}

async function viewDeliveryOrders() {
  const u = currentUser();
  const available = isDispatchAvailable();
  const sim = isDispatchSim();
  const simLoc = getSimLocation();
  render(el(`<section>
    <h1 class="text-xl font-semibold mb-2">Deliveries</h1>
    <div class="bg-white p-3 rounded shadow mb-4">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <span id="presence-pill" class="text-xs px-2 py-1 rounded ${available ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'}">${available ? 'Available' : 'Off-duty'}</span>
          <button id="presence-toggle" class="text-sm px-3 py-1 rounded ${available ? 'bg-slate-200 text-slate-700' : 'bg-emerald-600 text-white'}">
            ${available ? 'Go Off-duty' : 'Go Available'}
          </button>
        </div>
        <label class="text-xs text-slate-600 flex items-center gap-1">
          <input id="sim-toggle" type="checkbox" ${sim ? 'checked' : ''}/> Simulated GPS (demo)
        </label>
      </div>
      <p class="text-xs text-slate-500">Available drivers receive delivery offers from dispatch. Accept to start a trip.</p>
      ${sim ? `
        <div class="mt-3">
          <p class="text-xs text-slate-600 mb-1">Click the map to set your simulated location.</p>
          <div id="sim-map" class="h-56 rounded border"></div>
          <p id="sim-coords" class="text-xs text-slate-500 mt-1">${simLoc ? `Picked: ${simLoc.lat.toFixed(5)}, ${simLoc.lon.toFixed(5)}` : 'No location picked yet.'}</p>
        </div>` : ''}
    </div>
    <h2 class="text-sm font-semibold text-slate-600 mb-2">Active deliveries</h2>
    <div id="list" class="space-y-2"></div>
  </section>`));

  if (sim) {
    pickerMap('sim-map', simLoc ? [simLoc.lat, simLoc.lon] : null, ({ lat, lng }) => {
      const loc = { lat, lon: lng };
      setSimLocation(loc);
      const c = document.getElementById('sim-coords');
      if (c) c.textContent = `Picked: ${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`;
      // Push the new fix immediately so dispatch sees it without waiting
      // for the next interval tick.
      if (isDispatchAvailable()) postHeartbeat();
    });
  }

  document.getElementById('sim-toggle').onchange = async (e) => {
    setDispatchSim(e.target.checked);
    if (isDispatchAvailable()) {
      stopDispatchPresence();
      try { await API.driverOff(); } catch { /* best effort */ }
      setDispatchAvailable(false);
    }
    viewDeliveryOrders();
  };

  document.getElementById('presence-toggle').onclick = async () => {
    if (isDispatchAvailable()) {
      setDispatchAvailable(false);
      stopDispatchPresence();
      try { await API.driverOff(); } catch { /* best effort */ }
    } else {
      if (isDispatchSim() && !getSimLocation()) {
        flash('Pick your location on the map first.');
        return;
      }
      setDispatchAvailable(true);
      startDispatchPresence();
    }
    viewDeliveryOrders();
  };

  const refresh = async () => {
    const list = await API.listOrders(`?delivery_user_id=${u.id}`);
    const target = document.getElementById('list');
    if (!target) return;
    target.innerHTML = (list || []).map(o => `
      <a href="#/d/orders/${o.id}" class="block bg-white p-3 rounded shadow flex justify-between items-center">
        <div>
          <div class="font-medium">Order ${o.id.slice(0, 8)}…</div>
          <div class="text-sm text-slate-600">${o.delivery_address || ''}</div>
        </div>
        <div class="text-right text-sm">
          <div>${o.status}</div>
          <div class="text-slate-600">${fmtMoney(o.total)}</div>
        </div>
      </a>`).join('') || '<p class="text-slate-600">No active deliveries.</p>';
  };
  try { await refresh(); } catch (err) { flash(err.message); }
  openOrdersStream({}, refresh);

  // If the driver toggled Available previously and reloaded the page, restart
  // the heartbeat + SSE on entering this view.
  if (available && !dispatchHeartbeatTimer) {
    startDispatchPresence();
  }
}

let geoWatchId = null;
let postTimer = null;
let lastFix = null;

// DEMO ONLY: set per-order by the toggle button on the delivery order view.
// Persisted across page reloads so the chosen mode survives a refresh.
const SIM_KEY = 'fd.simulatedDelivery';
let simTimer = null;
// Tracks which order's sim has finished so the polling refresh in
// viewDeliveryOrder doesn't keep restarting it from 0% in a loop.
let simDoneOrderId = null;

function isSimulated() { return localStorage.getItem(SIM_KEY) === '1'; }
function setSimulated(v) {
  if (v) localStorage.setItem(SIM_KEY, '1');
  else localStorage.removeItem(SIM_KEY);
}

function stopGeo() {
  if (geoWatchId != null) { navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
  if (postTimer) { clearInterval(postTimer); postTimer = null; }
  if (simTimer) { clearInterval(simTimer); simTimer = null; }
  lastFix = null;
  simDoneOrderId = null;
}

// DEMO ONLY: linearly interpolate driver position from `from` to `to` over
// SIM_DURATION_MS, posting every SIM_TICK_MS. Real geolocation is not used
// in this mode — this exists purely so the demo can show movement on the map
// without the delivery user actually walking around.
const SIM_DURATION_MS = 30_000;
const SIM_TICK_MS = 2_000;
function startSimulatedDelivery(orderId, from, to) {
  if (simTimer) return;
  if (simDoneOrderId === orderId) return; // already completed this order
  const t0 = Date.now();
  const tick = async () => {
    const t = Math.min(1, (Date.now() - t0) / SIM_DURATION_MS);
    const lat = from.lat + (to.lat - from.lat) * t;
    const lng = from.lng + (to.lng - from.lng) * t;
    // Re-query each tick — innerHTML re-renders during polling replace the node.
    const el = document.getElementById('geo-status');
    if (el) el.textContent =
      `Simulated (demo): ${lat.toFixed(5)}, ${lng.toFixed(5)} — ${(t * 100).toFixed(0)}%`;
    try { await API.postLocation(orderId, { latitude: lat, longitude: lng }); } catch { }
    if (t >= 1 && simTimer) {
      clearInterval(simTimer); simTimer = null;
      simDoneOrderId = orderId;
    }
  };
  tick();
  simTimer = setInterval(tick, SIM_TICK_MS);
}

async function viewDeliveryOrder(id) {
  render(el(`<section><a href="#/d/orders" class="text-sm text-slate-600">← Deliveries</a>
    <div id="body" class="mt-3"></div></section>`));
  let restaurant = null;
  const refresh = async () => {
    try {
      const o = await API.getOrder(id);
      if (!restaurant || restaurant.id !== o.restaurant_id) {
        try { restaurant = await API.getRestaurant(o.restaurant_id); } catch { restaurant = null; }
      }
      let payment = null;
      try { payment = await API.getOrderPayment(id); }
      catch (e) { if (e.status !== 404) console.warn(e); }
      const needsCash = payment && payment.method === 'cash' && payment.status === 'PENDING';
      const sim = isSimulated();
      const dest = (o.delivery_latitude != null && o.delivery_longitude != null)
        ? { lat: o.delivery_latitude, lng: o.delivery_longitude } : null;
      const from = (restaurant && restaurant.latitude != null && restaurant.longitude != null)
        ? { lat: restaurant.latitude, lng: restaurant.longitude } : null;
      const canSim = !!(from && dest);

      document.getElementById('body').innerHTML = `
        <h1 class="text-xl font-semibold mb-2">Order ${o.id.slice(0, 8)}…</h1>
        ${statusTimeline(o.status)}
        <div class="bg-white p-4 rounded shadow mt-4">
          <div class="text-sm text-slate-700">Drop at: <strong>${o.delivery_address || ''}</strong></div>
          <ul class="text-sm text-slate-600 mt-1">${(o.items || []).map(i => `<li>${i.quantity}× ${i.name}</li>`).join('')}</ul>
          ${needsCash ? `<div class="mt-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">Collect <strong>${fmtMoney(o.total)}</strong> in cash on delivery.</div>` : ''}
          <div class="mt-3 flex gap-2 flex-wrap">
            ${deliveryActions(o)}
            ${needsCash ? `<button id="cash-collected" class="bg-amber-600 text-white px-3 py-1 rounded text-sm">Cash collected</button>` : ''}
          </div>
        </div>
        <div class="bg-white p-4 rounded shadow mt-4">
          <div class="flex items-center justify-between gap-2 mb-2">
            <h2 class="font-semibold">Live location</h2>
            <button id="sim-toggle" class="text-xs px-2 py-1 rounded ${sim ? 'bg-amber-500 text-white' : 'bg-slate-200 text-slate-700'}" ${canSim ? '' : 'disabled title="Restaurant or destination missing coordinates"'}>
              ${sim ? 'Simulated (demo) — switch to real GPS' : 'Use simulated path (demo)'}
            </button>
          </div>
          <p id="geo-status" class="text-xs text-slate-500"></p>
        </div>`;
      document.getElementById('body').querySelectorAll('button[data-act]').forEach(b => {
        b.onclick = async () => {
          try { await API.setOrderStatus(b.dataset.id, b.dataset.act); refresh(); }
          catch (err) { flash(err.message); }
        };
      });
      const cashBtn = document.getElementById('cash-collected');
      if (cashBtn) cashBtn.onclick = async () => {
        try { await API.collectCash(id); flash('Cash collected', 'ok'); refresh(); }
        catch (err) { flash(err.message); }
      };
      const toggleBtn = document.getElementById('sim-toggle');
      if (toggleBtn && !toggleBtn.disabled) {
        toggleBtn.onclick = () => {
          setSimulated(!isSimulated());
          stopGeo();
          refresh();
        };
      }

      if (o.status === 'PICKED_UP') {
        if (sim && canSim) {
          startSimulatedDelivery(o.id, from, dest);
        } else {
          startDeliveryTracking(o.id, from);
        }
      } else {
        stopGeo();
      }
    } catch (err) { flash(err.message); }
  };
  await refresh();
  openOrdersStream({ idFilter: id }, refresh);
}

function deliveryActions(o) {
  const btn = (s, label, color = 'bg-slate-900') =>
    `<button data-id="${o.id}" data-act="${s}" class="${color} text-white px-3 py-1 rounded text-sm">${label}</button>`;
  switch (o.status) {
    case 'READY': return btn('PICKED_UP', 'Mark picked up', 'bg-emerald-600');
    case 'PICKED_UP': return btn('DELIVERED', 'Mark delivered', 'bg-emerald-700');
    default: return '';
  }
}

function startDeliveryTracking(orderId, restaurantOrigin) {
  if (geoWatchId != null) return;
  // Seed the customer's map with the restaurant's location until the first
  // real GPS fix arrives — otherwise the marker is missing for the first
  // few seconds after pickup.
  if (restaurantOrigin) {
    API.postLocation(orderId, {
      latitude: restaurantOrigin.lat,
      longitude: restaurantOrigin.lng,
    }).catch(() => { });
  }
  if (!navigator.geolocation) {
    document.getElementById('geo-status').textContent = 'Geolocation not supported.';
    return;
  }
  document.getElementById('geo-status').textContent = 'Acquiring GPS…';
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      lastFix = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      document.getElementById('geo-status').textContent =
        `Last fix: ${lastFix.latitude.toFixed(5)}, ${lastFix.longitude.toFixed(5)}`;
    },
    (err) => { document.getElementById('geo-status').textContent = `GPS error: ${err.message}`; },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
  );
  postTimer = setInterval(async () => {
    if (!lastFix) return;
    try { await API.postLocation(orderId, lastFix); }
    catch (err) { /* swallow transient errors */ }
  }, 5000);
}

// ---------- router ----------------------------------------------------------

function goHome() {
  const u = currentUser();
  if (!u) { location.hash = '#/login'; return; }
  location.hash = ({ customer: '#/c/restaurants', restaurant: '#/r/orders', delivery: '#/d/orders' }[u.role]) || '#/login';
}

function route() {
  stopPolling(); stopGeo(); stopListPolling();
  renderNav();
  const h = location.hash || '#/';
  const u = currentUser();

  if (h === '#/' || h === '') return goHome();
  if (h === '#/login') return viewLogin();
  if (h === '#/register') return viewRegister();

  if (!u) { location.hash = '#/login'; return; }

  // Customer
  let m;
  if ((m = h.match(/^#\/c\/restaurants$/))) return viewCustomerRestaurants();
  if ((m = h.match(/^#\/c\/restaurants\/(.+)$/))) return viewCustomerRestaurant(m[1]);
  if ((m = h.match(/^#\/c\/orders$/))) return viewCustomerOrders();
  if ((m = h.match(/^#\/c\/orders\/(.+)$/))) return viewCustomerOrder(m[1]);
  if ((m = h.match(/^#\/c\/checkout\/(.+)$/))) return viewCustomerCheckout(m[1]);

  // Restaurant
  if ((m = h.match(/^#\/r\/orders$/))) return viewRestaurantOrders();
  if ((m = h.match(/^#\/r\/menu$/))) return viewRestaurantMenu();
  if ((m = h.match(/^#\/r\/setup$/))) return viewRestaurantSetup();

  // Delivery
  if ((m = h.match(/^#\/d\/orders$/))) return viewDeliveryOrders();
  if ((m = h.match(/^#\/d\/orders\/(.+)$/))) return viewDeliveryOrder(m[1]);

  goHome();
}

window.addEventListener('hashchange', route);
window.addEventListener('load', route);
