// Minimal vanilla SPA. Hash router, role-based views, JWT in localStorage.
// All API calls hit same-origin /api/* — NGINX in front of us proxies to the
// correct backend service.

// ---------- auth store ------------------------------------------------------

const TOKEN_KEY = 'fd.token';
const RESTAURANT_KEY = 'fd.myRestaurantId';

function saveToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function getToken()    { return localStorage.getItem(TOKEN_KEY); }
function clearAuth()   { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(RESTAURANT_KEY); }

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

const API = {
  register: (b)            => api('POST', '/auth/register', b),
  login:    (b)            => api('POST', '/auth/login',    b),
  me:       ()             => api('GET',  '/users/me'),

  listRestaurants: (q='')  => api('GET', `/restaurants${q}`),
  getRestaurant:   (id)    => api('GET', `/restaurants/${id}`),
  createRestaurant:(b)     => api('POST',`/restaurants`, b),
  patchRestaurant: (id, b) => api('PATCH',`/restaurants/${id}`, b),
  getMenu:         (id)    => api('GET', `/restaurants/${id}/menu`),
  createMenuItem:  (id,b)  => api('POST',`/restaurants/${id}/menu`, b),
  patchMenuItem:   (id,it,b)=>api('PATCH',`/restaurants/${id}/menu/${it}`, b),
  deleteMenuItem:  (id,it) => api('DELETE',`/restaurants/${id}/menu/${it}`),

  placeOrder:      (b)     => api('POST', '/orders', b),
  getOrder:        (id)    => api('GET',  `/orders/${id}`),
  listOrders:      (q)     => api('GET',  `/orders${q}`),
  setOrderStatus:  (id, s) => api('PATCH',`/orders/${id}/status`, { status: s }),
  assignOrder:     (id)    => api('POST', `/orders/${id}/assign`),
  postLocation:    (id, b) => api('POST', `/orders/${id}/location`, b),
  getLocation:     (id)    => api('GET',  `/orders/${id}/location`),
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

function flash(msg, kind='error') {
  const colour = kind === 'error' ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800';
  const banner = el(`<div class="fixed top-3 right-3 px-4 py-2 rounded shadow ${colour}">${msg}</div>`);
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 3000);
}

function fmtMoney(s) {
  if (s == null) return '';
  const n = typeof s === 'string' ? parseFloat(s) : s;
  return `$${n.toFixed(2)}`;
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
    customer:   [['#/c/restaurants','Browse'], ['#/c/orders','My Orders']],
    restaurant: [['#/r/orders','Orders'],      ['#/r/menu','Menu']],
    delivery:   [['#/d/orders','Deliveries']],
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

const cart = { restaurantId: null, items: {} }; // { menuItemId -> { item, qty } }

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
      <aside id="cart" class="bg-white p-4 rounded shadow self-start"></aside>
    </div></section>`));
  if (cart.restaurantId !== id) { cart.restaurantId = id; cart.items = {}; }
  try {
    const [r, menu] = await Promise.all([API.getRestaurant(id), API.getMenu(id)]);
    document.getElementById('head').innerHTML = `<h1 class="text-xl font-semibold">${r.name}</h1><p class="text-slate-600">${r.description || ''}</p>`;
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
        renderCart(id);
      };
    });
    renderCart(id);
  } catch (err) { flash(err.message); }
}

function renderCart(restaurantId) {
  const lines = Object.values(cart.items);
  const html = `
    <h2 class="font-semibold mb-2">Cart</h2>
    ${lines.length === 0 ? '<p class="text-sm text-slate-500">Empty.</p>' : `
      <ul class="text-sm space-y-1">
        ${lines.map(l => `<li class="flex justify-between"><span>${l.qty}× ${l.item.name}</span><span>${fmtMoney(l.qty*parseFloat(l.item.price))}</span></li>`).join('')}
      </ul>
      <div class="border-t mt-2 pt-2 text-sm flex justify-between font-medium"><span>Subtotal</span><span>${fmtMoney(cartTotal())}</span></div>
      <input id="addr" placeholder="Delivery address" class="w-full border rounded px-2 py-1 mt-3 text-sm" />
      <button id="place" class="w-full bg-emerald-600 text-white py-2 rounded mt-2 text-sm">Place order</button>`}
    `;
  document.getElementById('cart').innerHTML = html;
  if (lines.length === 0) return;
  document.getElementById('place').onclick = async () => {
    const addr = document.getElementById('addr').value.trim();
    if (!addr) return flash('Address required');
    try {
      const order = await API.placeOrder({
        restaurant_id: restaurantId,
        delivery_address: addr,
        items: lines.map(l => ({ menu_item_id: l.item.id, quantity: l.qty })),
      });
      cart.items = {}; cart.restaurantId = null;
      flash('Order placed', 'ok');
      location.hash = `#/c/orders/${order.id}`;
    } catch (err) { flash(err.message); }
  };
}

async function viewCustomerOrders() {
  const u = currentUser();
  render(el(`<section><h1 class="text-xl font-semibold mb-4">My Orders</h1><div id="list" class="space-y-2"></div></section>`));
  try {
    const list = await API.listOrders(`?customer_id=${u.id}`);
    document.getElementById('list').innerHTML = (list || []).map(orderRow).join('') || '<p class="text-slate-600">No orders yet.</p>';
  } catch (err) { flash(err.message); }
}

function orderRow(o) {
  return `<a href="#/c/orders/${o.id}" class="block bg-white p-3 rounded shadow flex justify-between items-center">
    <div>
      <div class="font-medium">Order ${o.id.slice(0,8)}…</div>
      <div class="text-sm text-slate-500">${new Date(o.created_at).toLocaleString()}</div>
    </div>
    <div class="text-right">
      <div class="text-sm">${o.status}</div>
      <div class="text-sm text-slate-600">${fmtMoney(o.total)}</div>
    </div>
  </a>`;
}

const STATUS_FLOW = ['PENDING','ACCEPTED','PREPARING','READY','PICKED_UP','DELIVERED'];

function statusTimeline(status) {
  if (status === 'REJECTED' || status === 'CANCELLED') {
    return `<div class="text-red-700 font-medium">${status}</div>`;
  }
  const idx = STATUS_FLOW.indexOf(status);
  return `<ol class="flex flex-wrap gap-2 text-xs">
    ${STATUS_FLOW.map((s,i) => `<li class="px-2 py-1 rounded ${i<=idx?'bg-emerald-600 text-white':'bg-slate-200 text-slate-600'}">${s}</li>`).join('')}
  </ol>`;
}

let pollTimer = null;
let mapInstance = null;
let mapMarker = null;

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (mapInstance) { mapInstance.remove(); mapInstance = null; mapMarker = null; }
}

async function viewCustomerOrder(id) {
  render(el(`<section><a href="#/c/orders" class="text-sm text-slate-600">← Orders</a>
    <div id="body" class="mt-3"></div></section>`));
  const refresh = async () => {
    try {
      const o = await API.getOrder(id);
      const itemsHtml = (o.items || []).map(i => `<li class="flex justify-between"><span>${i.quantity}× ${i.name}</span><span>${fmtMoney(parseFloat(i.unit_price)*i.quantity)}</span></li>`).join('');
      document.getElementById('body').innerHTML = `
        <h1 class="text-xl font-semibold mb-2">Order ${o.id.slice(0,8)}…</h1>
        ${statusTimeline(o.status)}
        <div class="grid md:grid-cols-2 gap-4 mt-4">
          <div class="bg-white p-4 rounded shadow">
            <h2 class="font-semibold mb-2">Items</h2>
            <ul class="text-sm space-y-1">${itemsHtml}</ul>
            <div class="border-t mt-2 pt-2 text-sm space-y-1">
              <div class="flex justify-between"><span>Subtotal</span><span>${fmtMoney(o.subtotal)}</span></div>
              <div class="flex justify-between"><span>Delivery</span><span>${fmtMoney(o.delivery_fee)}</span></div>
              <div class="flex justify-between font-medium"><span>Total</span><span>${fmtMoney(o.total)}</span></div>
              <div class="flex justify-between text-slate-600"><span>Paid</span><span>${o.paid ? 'yes' : 'no'}</span></div>
            </div>
            ${o.status === 'PENDING' ? `<button id="cancel" class="mt-3 w-full bg-red-600 text-white py-2 rounded text-sm">Cancel order</button>` : ''}
          </div>
          <div class="bg-white p-4 rounded shadow">
            <h2 class="font-semibold mb-2">Live tracking</h2>
            <div id="map" class="bg-slate-100"></div>
            <p id="map-note" class="text-xs text-slate-500 mt-2">Map activates when the order is picked up.</p>
          </div>
        </div>`;
      const cancelBtn = document.getElementById('cancel');
      if (cancelBtn) cancelBtn.onclick = async () => {
        try { await API.setOrderStatus(o.id, 'CANCELLED'); refresh(); }
        catch (err) { flash(err.message); }
      };
      if (o.status === 'PICKED_UP' && !pollTimer) startCustomerTracking(o.id);
      if (o.status !== 'PICKED_UP') stopPolling();
    } catch (err) { flash(err.message); }
  };
  await refresh();
}

function ensureMap(elId, lat, lng) {
  if (!mapInstance) {
    mapInstance = L.map(elId).setView([lat, lng], 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19,
    }).addTo(mapInstance);
    mapMarker = L.marker([lat, lng]).addTo(mapInstance);
  } else {
    mapMarker.setLatLng([lat, lng]);
    mapInstance.panTo([lat, lng]);
  }
}

function startCustomerTracking(orderId) {
  document.getElementById('map-note').textContent = 'Polling driver location every 3s.';
  const tick = async () => {
    try {
      const loc = await API.getLocation(orderId);
      if (loc && loc.latitude != null) ensureMap('map', loc.latitude, loc.longitude);
    } catch { /* swallow — driver may not have posted yet */ }
  };
  tick();
  pollTimer = setInterval(tick, 3000);
}

// ---------- views: restaurant ----------------------------------------------

async function viewRestaurantOrders() {
  const u = currentUser();
  const myId = localStorage.getItem(RESTAURANT_KEY);
  if (!myId) return viewRestaurantSetup();
  render(el(`<section><h1 class="text-xl font-semibold mb-4">Restaurant Orders</h1><div id="list" class="space-y-2"></div></section>`));
  const refresh = async () => {
    try {
      const list = await API.listOrders(`?restaurant_id=${myId}`);
      document.getElementById('list').innerHTML = (list || []).map(o => `
        <div class="bg-white p-3 rounded shadow">
          <div class="flex justify-between items-start">
            <div>
              <div class="font-medium">Order ${o.id.slice(0,8)}…</div>
              <div class="text-sm text-slate-500">${new Date(o.created_at).toLocaleString()}</div>
              <ul class="text-sm text-slate-700 mt-1">${(o.items||[]).map(i=>`<li>${i.quantity}× ${i.name}</li>`).join('')}</ul>
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
}

function restaurantActions(o) {
  const btn = (s, label, color='bg-slate-900') =>
    `<button data-id="${o.id}" data-act="${s}" class="${color} text-white px-3 py-1 rounded">${label}</button>`;
  switch (o.status) {
    case 'PENDING':   return btn('ACCEPTED','Accept','bg-emerald-600') + btn('REJECTED','Reject','bg-red-600');
    case 'ACCEPTED':  return btn('PREPARING','Start preparing');
    case 'PREPARING': return btn('READY','Mark ready');
    default:          return '';
  }
}

async function viewRestaurantSetup() {
  render(el(`
    <section class="max-w-md mx-auto bg-white p-6 rounded shadow">
      <h1 class="text-xl font-semibold mb-4">Set up your restaurant</h1>
      <form class="space-y-3">
        <input name="name" placeholder="name" required class="w-full border rounded px-3 py-2" />
        <textarea name="description" placeholder="description" class="w-full border rounded px-3 py-2"></textarea>
        <input name="address" placeholder="address" required class="w-full border rounded px-3 py-2" />
        <input name="cuisine" placeholder="cuisine" required class="w-full border rounded px-3 py-2" />
        <input name="image_url" placeholder="image url (optional)" class="w-full border rounded px-3 py-2" />
        <button class="w-full bg-slate-900 text-white py-2 rounded">Create</button>
      </form>
    </section>`));
  app().querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await API.createRestaurant(fd);
      localStorage.setItem(RESTAURANT_KEY, r.id);
      flash('Restaurant created', 'ok');
      location.hash = '#/r/orders';
    } catch (err) { flash(err.message); }
  };
}

async function viewRestaurantMenu() {
  const myId = localStorage.getItem(RESTAURANT_KEY);
  if (!myId) return viewRestaurantSetup();
  render(el(`<section>
    <h1 class="text-xl font-semibold mb-4">Menu</h1>
    <div class="bg-white p-4 rounded shadow mb-4">
      <h2 class="font-medium mb-2">Add item</h2>
      <form id="add" class="grid sm:grid-cols-2 gap-2">
        <input name="name" placeholder="name" required class="border rounded px-2 py-1" />
        <input name="category" placeholder="category" required class="border rounded px-2 py-1" />
        <input name="price" placeholder="price (e.g. 9.99)" required class="border rounded px-2 py-1" />
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

async function viewDeliveryOrders() {
  const u = currentUser();
  render(el(`<section>
    <h1 class="text-xl font-semibold mb-2">Deliveries</h1>
    <div class="bg-white p-3 rounded shadow mb-4 flex gap-2">
      <input id="claim" placeholder="Order ID to claim (READY)" class="flex-1 border rounded px-2 py-1 text-sm" />
      <button id="claim-btn" class="bg-emerald-600 text-white px-3 py-1 rounded text-sm">Claim</button>
    </div>
    <div id="list" class="space-y-2"></div>
  </section>`));
  document.getElementById('claim-btn').onclick = async () => {
    const id = document.getElementById('claim').value.trim();
    if (!id) return;
    try {
      await API.assignOrder(id);
      flash('Claimed', 'ok');
      location.hash = `#/d/orders/${id}`;
    } catch (err) { flash(err.message); }
  };
  try {
    const list = await API.listOrders(`?delivery_user_id=${u.id}`);
    document.getElementById('list').innerHTML = (list || []).map(o => `
      <a href="#/d/orders/${o.id}" class="block bg-white p-3 rounded shadow flex justify-between items-center">
        <div>
          <div class="font-medium">Order ${o.id.slice(0,8)}…</div>
          <div class="text-sm text-slate-600">${o.delivery_address || ''}</div>
        </div>
        <div class="text-right text-sm">
          <div>${o.status}</div>
          <div class="text-slate-600">${fmtMoney(o.total)}</div>
        </div>
      </a>`).join('') || '<p class="text-slate-600">No active deliveries.</p>';
  } catch (err) { flash(err.message); }
}

let geoWatchId = null;
let postTimer = null;
let lastFix = null;

function stopGeo() {
  if (geoWatchId != null) { navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
  if (postTimer) { clearInterval(postTimer); postTimer = null; }
  lastFix = null;
}

async function viewDeliveryOrder(id) {
  render(el(`<section><a href="#/d/orders" class="text-sm text-slate-600">← Deliveries</a>
    <div id="body" class="mt-3"></div></section>`));
  const refresh = async () => {
    try {
      const o = await API.getOrder(id);
      document.getElementById('body').innerHTML = `
        <h1 class="text-xl font-semibold mb-2">Order ${o.id.slice(0,8)}…</h1>
        ${statusTimeline(o.status)}
        <div class="bg-white p-4 rounded shadow mt-4">
          <div class="text-sm text-slate-700">Drop at: <strong>${o.delivery_address || ''}</strong></div>
          <ul class="text-sm text-slate-600 mt-1">${(o.items||[]).map(i=>`<li>${i.quantity}× ${i.name}</li>`).join('')}</ul>
          <div class="mt-3 flex gap-2">${deliveryActions(o)}</div>
        </div>
        <div class="bg-white p-4 rounded shadow mt-4">
          <h2 class="font-semibold mb-2">Live location</h2>
          <p id="geo-status" class="text-xs text-slate-500"></p>
        </div>`;
      document.getElementById('body').querySelectorAll('button[data-act]').forEach(b => {
        b.onclick = async () => {
          try { await API.setOrderStatus(b.dataset.id, b.dataset.act); refresh(); }
          catch (err) { flash(err.message); }
        };
      });
      if (o.status === 'PICKED_UP') startDeliveryTracking(o.id);
      else stopGeo();
    } catch (err) { flash(err.message); }
  };
  await refresh();
}

function deliveryActions(o) {
  const btn = (s, label, color='bg-slate-900') =>
    `<button data-id="${o.id}" data-act="${s}" class="${color} text-white px-3 py-1 rounded text-sm">${label}</button>`;
  switch (o.status) {
    case 'READY':     return btn('PICKED_UP','Mark picked up','bg-emerald-600');
    case 'PICKED_UP': return btn('DELIVERED','Mark delivered','bg-emerald-700');
    default: return '';
  }
}

function startDeliveryTracking(orderId) {
  if (!navigator.geolocation) {
    document.getElementById('geo-status').textContent = 'Geolocation not supported.';
    return;
  }
  if (geoWatchId != null) return;
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
  stopPolling(); stopGeo();
  renderNav();
  const h = location.hash || '#/';
  const u = currentUser();

  if (h === '#/' || h === '') return goHome();
  if (h === '#/login')    return viewLogin();
  if (h === '#/register') return viewRegister();

  if (!u) { location.hash = '#/login'; return; }

  // Customer
  let m;
  if ((m = h.match(/^#\/c\/restaurants$/)))         return viewCustomerRestaurants();
  if ((m = h.match(/^#\/c\/restaurants\/(.+)$/)))   return viewCustomerRestaurant(m[1]);
  if ((m = h.match(/^#\/c\/orders$/)))              return viewCustomerOrders();
  if ((m = h.match(/^#\/c\/orders\/(.+)$/)))        return viewCustomerOrder(m[1]);

  // Restaurant
  if ((m = h.match(/^#\/r\/orders$/)))              return viewRestaurantOrders();
  if ((m = h.match(/^#\/r\/menu$/)))                return viewRestaurantMenu();
  if ((m = h.match(/^#\/r\/setup$/)))               return viewRestaurantSetup();

  // Delivery
  if ((m = h.match(/^#\/d\/orders$/)))              return viewDeliveryOrders();
  if ((m = h.match(/^#\/d\/orders\/(.+)$/)))        return viewDeliveryOrder(m[1]);

  goHome();
}

window.addEventListener('hashchange', route);
window.addEventListener('load', route);
