// KM DocH test console. Plain browser JavaScript, same origin as the API.
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k instanceof Node ? k : String(k));
  return n;
};
const rupees = (p) => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : 'As soon as possible');
const randomMobile = () => '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
const deviceId = (who) => {
  const k = 'kmdoch-dev-device-' + who;
  try {
    let v = localStorage.getItem(k);
    if (!v) localStorage.setItem(k, (v = 'web-' + crypto.randomUUID()));
    return v;
  } catch {
    return 'web-' + who + '-device';
  }
};

// ── API helper with a visible log ──
async function api(token, method, path, body) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const li = el('li', { class: res.ok ? '' : 'bad' }, `${method} ${path} → ${res.status}${res.ok ? '' : ' ' + (data?.error?.code ?? '')}`);
  $('log-list').prepend(li);
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? res.statusText);
    err.code = data?.error?.code;
    err.details = data?.error?.details;
    throw err;
  }
  return data;
}
const show = (id, msg, cls = '') => { const n = $(id); n.className = cls; n.textContent = msg; };
const fail = (id) => (e) => show(id, e.message, 'err');

async function sendCode(phoneInput, channel, appRole, extra, sentId) {
  const digits = phoneInput.value.replace(/\D/g, '');
  const r = await api(null, 'POST', '/v1/auth/otp/request', { phone: digits, app_role: appRole, channel, ...extra });
  let msg = `Code sent by ${r.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}${r.fallback ? ' (WhatsApp failed, so SMS was used)' : ''}.`;
  try {
    const dev = await api(null, 'GET', '/v1/__dev/otp?phone=' + digits);
    msg += ` Test mode: the code is ${dev.code} (filled in for you).`;
    return { challenge: r.challenge_id, code: dev.code, msg };
  } catch {
    return { challenge: r.challenge_id, code: '', msg: msg + ' Check your phone.' };
  }
}

// ═════════════════════════════ Patient ═════════════════════════════
const P = { token: null, patientId: null, addressId: null, challenge: null, quote: null, service: null, requestId: null, services: [], timer: null, session: crypto.randomUUID() };
$('p-phone').value = randomMobile();

$('p-send').addEventListener('click', async () => {
  try {
    const r = await sendCode($('p-phone'), $('p-channel').value, 'patient', {}, 'p-sent');
    P.challenge = r.challenge;
    $('p-code').value = r.code;
    show('p-sent', r.msg, 'hint');
    $('p-verify').disabled = false;
  } catch (e) { fail('p-sent')(e); }
});

$('p-verify').addEventListener('click', async () => {
  try {
    const phone = $('p-phone').value.replace(/\D/g, '');
    const r = await api(null, 'POST', '/v1/auth/otp/verify', { challenge_id: P.challenge, phone, code: $('p-code').value, device: { id: deviceId('patient'), platform: 'web' }, name: 'Test Patient' });
    P.token = r.access_token;
    const me = await api(P.token, 'GET', '/v1/me');
    P.patientId = me.patient.id;
    show('p-me', `Signed in as ${me.user.phone}.`, 'ok');
    $('p-search').disabled = false;
    $('p-here').disabled = false;
    await loadServices();
  } catch (e) { fail('p-me')(e); }
});

// Address search
let searchTimer = null;
$('p-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('p-search').value.trim();
  if (q.length < 2) return void $('p-suggest').replaceChildren();
  searchTimer = setTimeout(async () => {
    try {
      const r = await api(P.token, 'GET', `/v1/places/autocomplete?q=${encodeURIComponent(q)}&session_token=${P.session}`);
      $('p-suggest').replaceChildren(
        ...r.suggestions.map((s) => el('li', { onclick: () => pickPlace(s.place_id) }, s.title, el('small', {}, s.subtitle))),
        ...(r.suggestions.length ? [] : [el('li', { class: 'muted' }, 'No matches')]),
      );
    } catch (e) { fail('p-address')(e); }
  }, 250);
});

async function pickPlace(placeId) {
  try {
    const r = await api(P.token, 'GET', `/v1/places/${encodeURIComponent(placeId)}?session_token=${P.session}`);
    P.session = crypto.randomUUID();
    await saveAddress(r);
  } catch (e) { fail('p-address')(e); }
}

$('p-here').addEventListener('click', async () => {
  try { await saveAddress(await api(P.token, 'GET', '/v1/places/reverse?lat=12.9719&lng=77.6412')); } catch (e) { fail('p-address')(e); }
});

async function saveAddress(r) {
  $('p-suggest').replaceChildren();
  if (!r.serviceable) return show('p-address', `${r.address.formatted}: KM DocH does not serve this area yet. Try Indiranagar or Kumbakonam.`, 'err');
  const a = r.address;
  const saved = await api(P.token, 'POST', '/v1/addresses', {
    patient_id: P.patientId, label: 'Home', line1: a.line1, locality: a.locality ?? undefined, pincode: a.pincode, lat: a.lat, lng: a.lng, gate_code: '#1234', floor: '1', lift: false,
  });
  P.addressId = saved.id;
  show('p-address', `Saved: ${a.formatted} (${r.zone}).`, 'ok');
  $('p-service').disabled = false;
  $('p-quote').disabled = false;
}

// Booking
const SIMPLE_OPTIONS = {
  doctor_visit: () => ({}),
  catheterisation: () => ({}),
  als_emergency: () => ({}),
  nurse_visit: () => ({ reason: $('o-reason').value }),
  wound_dressing: () => ({ wound_type: 'surgical', frequency: $('o-frequency').value }),
  elder_care: () => ({ shift: $('o-shift').value, duration: $('o-duration').value, start_date: $('o-start').value }),
  lab_tests: () => ({ tests: [...document.querySelectorAll('.o-test:checked')].map((c) => c.value), fasting: false }),
};
const select = (id, label, opts) => el('label', {}, label, el('select', { id }, ...opts.map(([v, t]) => el('option', { value: v }, t))));

async function loadServices() {
  const r = await api(null, 'GET', '/v1/services');
  P.services = r.services.filter((s) => SIMPLE_OPTIONS[s.code]);
  $('p-service').replaceChildren(...P.services.map((s) => el('option', { value: s.code }, s.name)));
  renderOptions();
}
$('p-service').addEventListener('change', renderOptions);

function renderOptions() {
  const code = $('p-service').value;
  const box = $('p-options');
  const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const parts = {
    nurse_visit: [select('o-reason', 'Reason', [['vitals', 'Vitals check'], ['post_op', 'Post-op care'], ['elder_checkup', 'Elder check-up'], ['catheter_care', 'Catheter care']])],
    wound_dressing: [select('o-frequency', 'How often', [['single', 'One visit'], ['daily_x5', 'Daily × 5'], ['alternate_x7', 'Alternate days × 7']])],
    elder_care: [
      select('o-shift', 'Shift', [['day', 'Day (10 am–5 pm)'], ['night', 'Night (9 pm–7 am)']]),
      select('o-duration', 'For', [['day', '1 day'], ['week', '1 week'], ['month', '1 month']]),
      el('label', {}, 'Start', el('input', { id: 'o-start', type: 'date', value: tomorrow })),
    ],
    lab_tests: [el('div', {}, ...[['cbc', 'CBC'], ['hba1c', 'HbA1c'], ['lipid', 'Lipid'], ['tsh', 'TSH'], ['ecg', 'ECG']].map(([v, t]) =>
      el('label', { class: 'consent' }, el('input', { type: 'checkbox', class: 'o-test', value: v, ...(v === 'cbc' ? { checked: '' } : {}) }), t)))],
  }[code] ?? [];
  box.replaceChildren(el('div', { class: 'row' }, ...parts));
  $('p-price').replaceChildren();
  $('p-consents').replaceChildren();
  $('p-book').disabled = true;
}

$('p-quote').addEventListener('click', async () => {
  try {
    const code = $('p-service').value;
    P.service = code;
    P.quote = await api(P.token, 'POST', '/v1/quotes', { service_code: code, options: SIMPLE_OPTIONS[code]() });
    $('p-price').replaceChildren(
      el('table', {}, ...P.quote.line_items.map((l) => el('tr', {}, el('td', {}, l.name + (l.qty > 1 ? ` × ${l.qty}` : '')), el('td', { class: 'r' }, rupees(l.amount_paise)))),
        el('tr', {}, el('td', {}, el('strong', {}, 'Total')), el('td', { class: 'r' }, el('strong', {}, rupees(P.quote.total_paise))))),
      el('p', { class: 'muted' }, 'Price fixed by KM DocH. Valid for 10 minutes.'),
    );
    const t = await api(null, 'GET', '/v1/consent-templates?service=' + code);
    $('p-consents').replaceChildren(...t.templates.map((c) =>
      el('label', { class: 'consent' }, el('input', { type: 'checkbox', class: 'consent-box', 'data-key': c.key, 'data-version': c.version, ...(c.required ? { checked: '' } : {}) }), c.text.en + (c.required ? '' : ' (optional)'))));
    $('p-book').disabled = false;
  } catch (e) { $('p-price').replaceChildren(el('p', { class: 'err' }, e.message)); }
});

$('p-book').addEventListener('click', async () => {
  try {
    const consents = [...document.querySelectorAll('.consent-box:checked')].map((c) => ({ template_key: c.dataset.key, version: Number(c.dataset.version) }));
    const r = await api(P.token, 'POST', '/v1/service-requests', { quote_token: P.quote.quote_token, patient_id: P.patientId, address_id: P.addressId, symptoms: ['fever'], note: 'Booked from the test console', consents });
    P.requestId = r.id;
    $('p-book').disabled = true;
    startTracking();
  } catch (e) {
    const extra = e.code === 'CONSENT_REQUIRED' ? ' Tick all required boxes.' : '';
    $('p-price').append(el('p', { class: 'err' }, e.message + extra));
  }
});

function startTracking() {
  clearInterval(P.timer);
  refreshTracking();
  P.timer = setInterval(refreshTracking, 3000);
}

async function refreshTracking() {
  if (!P.requestId) return;
  try {
    const t = await api(P.token, 'GET', '/v1/service-requests/' + P.requestId);
    const kids = [el('p', {}, el('span', { class: 'status' }, t.status_label))];
    if (t.provider) kids.push(el('p', {}, el('strong', {}, t.provider.name), ' · ', t.provider.credentials, t.provider.verified ? ' · ✓ verified' : ''));
    if (t.provider?.bio) kids.push(el('p', { class: 'muted' }, t.provider.bio));
    if (t.eta_minutes) kids.push(el('p', {}, `Arriving in about ${t.eta_minutes} minutes`));
    if (t.visit_code) kids.push(el('p', {}, 'Door code — share with your professional when they arrive:'), el('p', { class: 'code' }, t.visit_code));
    if (t.visits.length > 1) kids.push(el('table', {}, ...t.visits.map((v) => el('tr', {}, el('td', {}, `Visit ${v.seq}`), el('td', {}, when(v.scheduled_for)), el('td', { class: 'r' }, v.status)))));
    kids.push(el('p', { class: 'muted' }, `Total ${rupees(t.final_total_paise ?? t.total_paise)}${t.final_total_paise != null && t.final_total_paise !== t.total_paise ? ` (quoted ${rupees(t.total_paise)})` : ''}`));
    $('p-track').replaceChildren(...kids);

    const actions = [];
    if (t.cancellable) actions.push(el('button', { class: 'danger', onclick: async () => { try { await api(P.token, 'POST', `/v1/service-requests/${P.requestId}/cancel`, {}); } catch (e) { alert(e.message); } } }, 'Cancel booking'));
    if (t.can_rate) actions.push(...[5, 4, 3, 2, 1].map((s) => el('button', { class: 'secondary', onclick: async () => { try { await api(P.token, 'POST', `/v1/service-requests/${P.requestId}/ratings`, { stars: s }); } catch (e) { alert(e.message); } } }, '★'.repeat(s))));
    if (t.invoice_id) actions.push(el('button', { class: 'secondary', onclick: async () => { const r = await api(P.token, 'GET', `/v1/invoices/${t.invoice_id}/pdf`); window.open(r.url, '_blank'); } }, 'Download receipt'));
    if (['completed', 'cancelled_by_patient', 'no_provider', 'failed'].includes(t.status)) {
      actions.push(el('button', { class: 'secondary', onclick: () => { P.requestId = null; clearInterval(P.timer); $('p-track').textContent = 'No booking yet.'; $('p-actions').replaceChildren(); $('p-book').disabled = true; } }, 'Book another'));
    }
    $('p-actions').replaceChildren(...actions);
  } catch (e) { $('p-track').replaceChildren(el('p', { class: 'err' }, e.message)); }
}

// ═════════════════════════════ Provider ═════════════════════════════
const V = { token: null, providerId: null, challenge: null, timer: null, pingTimer: null, current: null };
$('v-phone').value = randomMobile();
$('v-reg').value = 'KMC-TEST-' + Math.floor(Math.random() * 1e6);

$('v-send').addEventListener('click', async () => {
  try {
    const r = await sendCode($('v-phone'), 'whatsapp', 'provider', { provider_role: $('v-role').value, reg_number: $('v-reg').value }, 'v-sent');
    V.challenge = r.challenge;
    $('v-code').value = r.code;
    show('v-sent', r.msg, 'hint');
    $('v-verify').disabled = false;
  } catch (e) { fail('v-sent')(e); }
});

$('v-verify').addEventListener('click', async () => {
  try {
    const phone = $('v-phone').value.replace(/\D/g, '');
    const r = await api(null, 'POST', '/v1/auth/otp/verify', { challenge_id: V.challenge, phone, code: $('v-code').value, device: { id: deviceId('provider'), platform: 'web' }, name: 'Dr. Test Provider' });
    V.token = r.access_token;
    V.providerId = r.provider_id;
    const me = await api(V.token, 'GET', '/v1/me');
    show('v-me', `Signed in · ${me.provider.role.replace(/_/g, ' ')} · ${me.provider.reg_number} · ${me.provider.verification_status}`, 'ok');
    for (const id of ['v-approve', 'v-terms', 'v-loc', 'v-duty']) $(id).disabled = false;
  } catch (e) { fail('v-me')(e); }
});

$('v-approve').addEventListener('click', async () => {
  try { await api(V.token, 'POST', '/v1/__dev/provider-ready'); show('v-status', 'Approved and assigned to all service areas.', 'ok'); } catch (e) { fail('v-status')(e); }
});
$('v-terms').addEventListener('click', async () => {
  try {
    const t = await api(V.token, 'GET', '/v1/provider/terms/current');
    if (!confirm('Practice terms:\n\n' + t.items.map((i) => `• ${i.title}: ${i.text}`).join('\n') + '\n\nAccept?')) return;
    await api(V.token, 'POST', '/v1/provider/terms/accept', { version: t.version });
    show('v-status', `Accepted terms v${t.version}.`, 'ok');
  } catch (e) { fail('v-status')(e); }
});
$('v-loc').addEventListener('click', async () => {
  try { await api(V.token, 'POST', '/v1/provider/location-consent', { granted: true }); show('v-status', 'Location allowed (only used while on duty, never shown to patients).', 'ok'); } catch (e) { fail('v-status')(e); }
});

// Test location: about 1 km from the Indiranagar sample address.
const ping = () => api(V.token, 'POST', '/v1/provider/location', { pings: [{ lat: 12.9784, lng: 77.6408, recorded_at: new Date().toISOString() }] });
$('v-duty').addEventListener('click', async () => {
  try {
    const on = $('v-duty').textContent === 'Go on duty';
    await api(V.token, 'POST', '/v1/provider/duty', { on });
    clearInterval(V.timer);
    clearInterval(V.pingTimer);
    if (on) {
      await ping();
      V.pingTimer = setInterval(() => ping().catch(() => {}), 60000);
      V.timer = setInterval(refreshProvider, 3000);
      refreshProvider();
      show('v-status', 'On duty near Indiranagar. Requests appear below.', 'ok');
    } else {
      show('v-status', 'Off duty. Location collection stopped.', 'muted');
    }
    $('v-duty').textContent = on ? 'Go off duty' : 'Go on duty';
  } catch (e) {
    const hint = { TERMS_REQUIRED: ' Accept the practice terms first.', PROVIDER_NOT_VERIFIED: ' Click "Approve me" first.', LOCATION_CONSENT_REQUIRED: ' Allow location first.' }[e.code] ?? '';
    show('v-status', e.message + hint, 'err');
  }
});

async function refreshProvider() {
  try {
    const t = await api(V.token, 'GET', '/v1/provider/today');
    $('v-offers').replaceChildren(
      ...(t.pending_requests.length ? t.pending_requests.map((o) => el('div', { class: 'offer' },
        el('strong', {}, o.service_name), ` · ${o.area ?? 'Nearby'} · ${o.distance_km ?? '?'} km · ~${o.eta_minutes ?? '?'} min`,
        el('div', { class: 'row' },
          el('button', { onclick: () => respond(o.request_id, 'accept') }, 'Accept'),
          el('button', { class: 'secondary', onclick: () => respond(o.request_id, 'decline') }, 'Decline')))) : [el('span', { class: 'muted' }, 'No new requests. Book something on the left.')]),
    );
    const v = t.ongoing_visit ?? t.schedule[0] ?? t.upcoming?.[0];
    if (v && v.request_id !== V.current?.request_id) V.current = { request_id: v.request_id };
    if (V.current) await renderVisit(V.current.request_id);
  } catch (e) { $('v-offers').replaceChildren(el('p', { class: 'err' }, e.message)); }
}

async function respond(id, action) {
  try {
    await api(V.token, 'POST', `/v1/provider/requests/${id}/${action}`, action === 'accept' ? {} : { reason: 'Not available (test)' });
    if (action === 'accept') V.current = { request_id: id };
    refreshProvider();
  } catch (e) { alert(e.message); }
}

async function renderVisit(id) {
  const d = await api(V.token, 'GET', '/v1/provider/requests/' + id);
  const box = $('v-visit');
  if (!d.accepted) return;
  const done = ['completed', 'cancelled_by_patient', 'failed', 'no_provider'].includes(d.status);
  const kids = [
    el('p', {}, el('span', { class: 'status' }, d.status.replace(/_/g, ' ')), ' ', el('strong', {}, d.service_name)),
    el('p', {}, `${d.patient.name} · ${d.address.line1}${d.address.landmark ? ', ' + d.address.landmark : ''}, ${d.address.pincode} · gate ${d.address.gate_code ?? '—'} · floor ${d.address.floor ?? '—'}`),
    el('p', { class: 'muted' }, `Symptoms: ${d.symptoms.join(', ') || '—'}${d.note ? ' · Note: ' + d.note : ''}`),
  ];
  if (d.visits?.length > 1) kids.push(el('p', { class: 'muted' }, `Visit ${d.visits.find((x) => ['scheduled', 'in_progress'].includes(x.status))?.seq ?? '—'} of ${d.visits.length}`));
  const row = el('div', { class: 'row wrap' });
  if (d.status === 'confirmed') {
    const code = el('input', { placeholder: 'Door code', maxlength: '4', inputmode: 'numeric' });
    row.append(
      el('button', { class: 'secondary', onclick: () => act(id, 'on-my-way') }, 'On my way'),
      el('label', {}, 'Door code from patient', code),
      el('button', { onclick: () => act(id, 'arrived', { visit_code: code.value }) }, 'Arrived'),
      el('button', { class: 'danger', onclick: () => act(id, 'cancel-request', { reason: 'Unable to attend (test)' }) }, 'Cancel'),
    );
  }
  if (d.status === 'provider_arrived') row.append(el('button', { onclick: () => act(id, 'start') }, 'Start visit'));
  if (d.status === 'in_progress') row.append(el('button', { onclick: () => act(id, 'complete') }, 'Complete visit'));
  if (done) row.append(el('span', { class: 'muted' }, 'This visit is closed.'));
  kids.push(row);
  box.replaceChildren(...kids);
  if (done) V.current = null;
}

async function act(id, what, body) {
  try {
    const path = what === 'cancel-request' ? `/v1/provider/requests/${id}/cancel` : `/v1/provider/visits/${id}/${what}`;
    await api(V.token, 'POST', path, body ?? {});
    refreshProvider();
  } catch (e) { alert(e.message); }
}
