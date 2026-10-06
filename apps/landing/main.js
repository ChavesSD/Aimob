// Nome provisório: um único ponto para trocar. Elementos [data-brand] recebem este valor.
const BRAND = 'Aimob';
document.querySelectorAll('[data-brand]').forEach((el) => { el.textContent = BRAND; });
document.title = document.title.replace('Aimob', BRAND);

const safe = (fn) => { try { return fn(); } catch { return null; } };
const device = () => (innerWidth < 600 ? 'mobile' : innerWidth < 1024 ? 'tablet' : 'desktop');

// Sessão anônima: id aleatório só na aba (sessionStorage), sem cookies e sem dados pessoais.
const sessionId = safe(() => {
  let id = sessionStorage.getItem('lp.sid');
  if (!id) { id = crypto.randomUUID().replaceAll('-', ''); sessionStorage.setItem('lp.sid', id); }
  return id;
}) ?? crypto.randomUUID().replaceAll('-', '');

// UTM: guarda a primeira origem da sessão.
const utm = safe(() => {
  const saved = JSON.parse(sessionStorage.getItem('lp.utm') ?? 'null');
  if (saved) return saved;
  const q = new URLSearchParams(location.search);
  const u = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) { const v = q.get(`utm_${k}`); if (v) u[k] = v.slice(0, 120); }
  sessionStorage.setItem('lp.utm', JSON.stringify(u));
  return u;
}) ?? {};

function track(event, detail) {
  const body = JSON.stringify({ sessionId, event, detail, utm, page: location.pathname, device: device() });
  const ok = navigator.sendBeacon?.('/api/public/evento', new Blob([body], { type: 'application/json' }));
  if (!ok) fetch('/api/public/evento', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

track('pageview');
document.querySelectorAll('[data-cta]').forEach((a) => a.addEventListener('click', () => track('cta_click', a.dataset.cta)));

// Profundidade de rolagem (50% e 90%), uma vez cada.
const seen = new Set();
addEventListener('scroll', () => {
  const max = document.documentElement.scrollHeight - innerHeight;
  if (max <= 0) return;
  const p = scrollY / max;
  for (const [t, name] of [[0.5, 'scroll_50'], [0.9, 'scroll_90']]) if (p >= t && !seen.has(name)) { seen.add(name); track(name); }
}, { passive: true });

const demo = document.querySelector('.mock');
if (demo && 'IntersectionObserver' in window) {
  new IntersectionObserver((es, o) => { if (es.some((e) => e.isIntersecting)) { track('demo_view'); o.disconnect(); } }, { threshold: 0.6 }).observe(demo);
}

// Formulário de diagnóstico
const form = document.getElementById('form');
const errBox = document.getElementById('form-error');
const btn = document.getElementById('submit');
let started = false, submitted = false;

form.addEventListener('focusin', () => { if (!started) { started = true; track('form_start'); } });
addEventListener('pagehide', () => { if (started && !submitted) track('form_abandon'); });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.hidden = true;
  const fd = new FormData(form);
  const payload = {
    name: fd.get('name'), company: fd.get('company'), phone: fd.get('phone'), email: fd.get('email'),
    brokers: fd.get('brokers') || undefined, properties: fd.get('properties') || undefined,
    sells: fd.get('sells') === 'on', rents: fd.get('rents') === 'on',
    currentSystem: fd.get('currentSystem') || undefined,
    pains: fd.getAll('pains'), consent: fd.get('consent') === 'on', website: fd.get('website') || undefined,
    utm, page: location.pathname, device: device(),
  };
  if (!payload.consent) { showError('Para receber o diagnóstico, autorize o uso dos dados no campo ao final do formulário.'); return; }
  btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    const res = await fetch('/api/public/diagnostico', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error('Recebemos muitos envios deste dispositivo. Tente novamente em alguns minutos.');
    if (res.status === 400) throw new Error('Confira os campos: nome, imobiliária, telefone com DDD e e-mail válidos.');
    if (!res.ok) throw new Error('Não conseguimos enviar agora. Tente novamente em instantes.');
    submitted = true;
    track('form_submit');
    form.hidden = true;
    const result = document.getElementById('result');
    document.getElementById('result-text').textContent = body.diagnosis ?? 'Recebemos seus dados e entraremos em contato.';
    result.hidden = false;
    result.scrollIntoView({ block: 'center' });
  } catch (err) {
    showError(err.message);
    btn.disabled = false; btn.textContent = 'Receber meu diagnóstico';
  }
});

function showError(msg) { errBox.textContent = msg; errBox.hidden = false; errBox.scrollIntoView({ block: 'nearest' }); }
