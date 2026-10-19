/* Mordisco — contador de calorías con foto. ChatGPT analiza el plato; la app hace todo lo demás. */

/* ---------- utilities ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v, d = 0) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : d; };
const R = n => Math.round(n);
const fmt = n => R(n).toLocaleString('es-ES');
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const uid = () => Math.random().toString(36).slice(2, 10);
const isoOf = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const todayISO = () => isoOf(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoOf(d); };
const SLOTS = [['desayuno','Desayuno'],['comida','Comida'],['merienda','Merienda'],['cena','Cena'],['snack','Picoteo']];
const slotName = k => (SLOTS.find(s => s[0] === k) || SLOTS[4])[1];
const autoSlot = () => { const h = new Date().getHours(); return h < 11 ? 'desayuno' : h < 16 ? 'comida' : h < 19 ? 'merienda' : h < 23 ? 'cena' : 'snack'; };
const APP_URL = location.origin + location.pathname.replace(/index\.html$/, '');
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2800); }

/* ---------- storage: everything stays on this phone ---------- */
const Store = {
  lk: k => 'mordisco:' + k,
  get(k) { try { return JSON.parse(localStorage.getItem(this.lk(k))); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(this.lk(k), JSON.stringify(v)); return true; } catch { toast('El móvil no deja guardar más. Exporta una copia y borra fotos antiguas.'); return false; } },
  del(k) { try { localStorage.removeItem(this.lk(k)); } catch {} },
  keys() { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('mordisco:')) out.push(k.slice(9)); } } catch {} return out; }
};
navigator.storage?.persist?.().catch(() => {});

/* ---------- state ---------- */
const defaultProfile = () => ({ sex: 'm', age: 22, height: 175, weight: 82, goal: 74, pace: 0.5, proteinPerKg: 1.8,
  weights: [{ date: todayISO(), kg: 82 }], history: {}, recent: [], gptUrl: '', gptReady: false });
const emptyDay = date => ({ date, meals: [], water: 0, steps: 0, exKcal: 0 });
const S = { tab: 'hoy', date: todayISO(), profile: null, day: null, draft: null, slotFor: null };

/* ---------- the numbers ---------- */
function targets(p, day) {
  const w = p.weight, male = p.sex !== 'f';
  const bmr = 10 * w + 6.25 * p.height - 5 * p.age + (male ? 5 : -161);
  const base = bmr * 1.2;                                   // sedentary baseline; walking is added on top
  const steps = day?.steps || 0;
  const stepKcal = Math.max(0, steps - 3000) * 0.00057 * w;  // ~0.047 kcal per step at 82 kg
  const burned = stepKcal + (day?.exKcal || 0);
  const deficit = p.pace * 7700 / 7;                         // 7,700 kcal ≈ 1 kg of fat
  const kcal = Math.max(male ? 1500 : 1200, R((base - deficit + burned * 0.6) / 10) * 10); // eat back 60% only
  const pr = R(p.proteinPerKg * w / 5) * 5;
  const f = R(Math.max(0.7 * w, kcal * 0.25 / 9));
  const c = Math.max(50, R((kcal - pr * 4 - f * 9) / 4));
  const fib = Math.max(25, R(kcal / 1000 * 14));
  const water = R((35 * w + steps / 1000 * 60) / 100) * 100;
  return { kcal, p: pr, c, f, fib, sug: 50, na: 2300, water, bmr: R(bmr), base: R(base), burned: R(burned), eatBack: R(burned * 0.6), deficit: R(deficit) };
}
function totals(day) {
  const t = { kcal: 0, p: 0, c: 0, f: 0, fib: 0, sug: 0, na: 0 };
  for (const m of day.meals) for (const it of m.items) for (const k in t) t[k] += num(it[k]);
  return t;
}
const mealKcal = m => m.items.reduce((a, it) => a + num(it.kcal), 0);
const mealP = m => m.items.reduce((a, it) => a + num(it.p), 0);
function dayScore(t, tot, day) {
  if (!day.meals.length) return null;
  const kr = tot.kcal / t.kcal;
  let s = kr >= 0.8 && kr <= 1.05 ? 40 : kr >= 0.65 && kr <= 1.15 ? 25 : 10;
  s += Math.min(1, tot.p / t.p) * 30 + Math.min(1, day.water / t.water) * 15 + Math.min(1, tot.fib / t.fib) * 15;
  return R(s);
}
function streak() {
  const h = S.profile.history; let d = todayISO(), n = 0;
  if (!(h[d]?.kcal > 0)) d = addDays(d, -1);
  while (h[d]?.kcal > 0) { n++; d = addDays(d, -1); }
  return n;
}

/* ---------- persistence helpers ---------- */
const saveProfile = () => Store.set('profile', S.profile);
function saveDay() { Store.set('day-' + S.day.date, S.day); updateHistory(); }
function updateHistory() {
  const d = S.day, t = targets(S.profile, d), tot = totals(d), h = S.profile.history;
  if (!d.meals.length && !d.water && !d.steps) delete h[d.date];
  else h[d.date] = { kcal: R(tot.kcal), p: R(tot.p), c: R(tot.c), f: R(tot.f), fib: R(tot.fib), water: d.water, steps: d.steps, goal: t.kcal, pgoal: t.p, score: dayScore(t, tot, d) };
  const keys = Object.keys(h).sort();
  while (keys.length > 400) delete h[keys.shift()];
  saveProfile();
}
function loadState() {
  S.profile = Object.assign(defaultProfile(), Store.get('profile') || {});
  S.day = Object.assign(emptyDay(S.date), Store.get('day-' + S.date) || {});
}
function loadDay(date) { S.date = date; S.day = Object.assign(emptyDay(date), Store.get('day-' + date) || {}); render(); }

/* ---------- ChatGPT bridge ---------- */
const FORMAT = `FORMATO DEL CÓDIGO (obligatorio, sin espacios):
add=NOMBRE;CONFIANZA;ALIMENTO1|ALIMENTO2|...;NOTA
- NOMBRE y NOTA: palabras unidas con guion bajo, sin tildes ni ñ, sin comas, punto y coma ni barras. Ej: Pasta_al_pesto
- CONFIANZA: alta, media o baja
- Cada ALIMENTO: nombre,gramos,kcal,proteina,carbohidratos,grasa,fibra,azucar,sodio_mg
  Números con punto decimal (12.5), sin unidades. El nombre con guion bajo.
Ejemplo:
add=Pasta_al_pesto;media;Pasta_cocida,250,330,12,66,1.5,4,1.5,5|Pesto,30,150,2,1.5,15,0.5,0.5,300|Parmesano,10,40,3.5,0,2.8,0,0,160;Supongo_plato_hondo_lleno`;
const METHOD = `Eres un dietista-nutricionista experto en estimar comida a partir de fotos o descripciones, más preciso que Cal AI o MyFitnessPal. Vivo en Italia, no tengo báscula de cocina y quiero perder grasa: necesito estimaciones fieles, ni optimistas ni infladas.

Método:
- Separa cada alimento y estima sus gramos tal como está servido.
- Escala: plato llano ≈ 26-27 cm, plato hondo ≈ 22 cm, tenedor ≈ 19 cm, vaso ≈ 250 ml, lata de atún 80 g escurrido, huevo M ≈ 50 g, rebanada de pan ≈ 30-35 g. Mira también la altura de la comida.
- Raciones italianas: pasta 80-120 g en seco ≈ 200-300 g cocida; pizza entera de pizzería ≈ 750-1000 kcal; cornetto ≈ 250-300 kcal.
- Grasa oculta: si hay brillo, salteado, frito o aliño, suma el aceite de oliva como alimento aparte (1 cucharada ≈ 10 g ≈ 90 kcal). También mantequilla, salsas, parmesano, nata.
- Usa tablas (USDA, BEDCA, CREA) para el alimento cocinado tal como se ve. Si reconoces un producto envasado, usa su etiqueta.
- Ante la duda de tamaño, toma el punto medio, no el mínimo.
- Comprueba que kcal ≈ 4·proteína + 4·carbohidratos + 9·grasa (±8 %).`;
function replyRules() {
  return `Responde siempre así, en este orden:
1. Una tabla corta: alimento, g, kcal, proteína, carbos, grasa. Y el total.
2. Una frase con lo que has supuesto (aceite, tamaño…).
3. Este enlace en Markdown: [Añadir a Mordisco](${APP_URL}#CODIGO) donde CODIGO es el código de abajo.
4. El mismo código en un bloque de código, solo, en una línea, para poder copiarlo.
Si te corrijo ("sin aceite", "era la mitad"), rehaz el cálculo y vuelve a dar tabla, enlace y código.

${FORMAT}`;
}
function photoPrompt(extra) {
  return `${METHOD}\n\nAnaliza la comida de la foto que te adjunto.${extra ? '\nContexto: ' + extra : ''}\n\n${replyRules()}`;
}
function textPrompt(desc) {
  return `${METHOD}\n\nAnaliza esta comida: "${desc}"\n\n${replyRules()}`;
}
function gptInstructions() {
  return `${METHOD}\n\nCuando te mande una foto de comida o te describa lo que he comido, analízala.\n\n${replyRules()}\n\nSi te pregunto otra cosa sobre nutrición, contesta corto, en español de España, como un buen entrenador personal.`;
}

function decodeField(s) { let v = s; try { v = decodeURIComponent(s); } catch {} return v.replace(/[_+]/g, ' ').replace(/\s+/g, ' ').trim(); }
function parseCode(text) {
  if (!text) return null;
  const m = String(text).match(/add=([^\s)\]`"'<>]+)/);
  if (!m) return null;
  let raw = m[1];
  if (/%3B|%7C|%2C/i.test(raw)) { try { raw = decodeURIComponent(raw); } catch {} }
  const parts = raw.split(';');
  if (parts.length < 3) return null;
  const items = parts[2].split('|').map(x => x.split(',')).filter(f => f.length >= 6).map(f => ({
    name: decodeField(f[0]) || 'Alimento', grams: R(num(f[1])), kcal: R(num(f[2])), p: +num(f[3]).toFixed(1), c: +num(f[4]).toFixed(1), f: +num(f[5]).toFixed(1),
    fib: +num(f[6]).toFixed(1), sug: +num(f[7]).toFixed(1), na: R(num(f[8]))
  }));
  if (!items.length) return null;
  const conf = decodeField(parts[1]).toLowerCase();
  return { name: decodeField(parts[0]) || items[0].name, confidence: conf.startsWith('a') ? 'alta' : conf.startsWith('b') ? 'baja' : 'media', items, notes: decodeField(parts.slice(3).join(' ')) };
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok;
  }
}
function openGPT() { window.open(S.profile.gptUrl || 'https://chatgpt.com/', '_blank', 'noopener'); }
// Send to ChatGPT: copy the prompt first (in case the share drops the text), then the share sheet with photo + text.
async function sendToGPT(prompt, file) {
  const copied = await copyText(prompt);
  if (file && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: prompt }); toast('Elige ChatGPT. Si no aparece el texto, pégalo: ya está copiado.'); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  } else if (!file && navigator.share) {
    try { await navigator.share({ text: prompt }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  openGPT();
  toast(copied ? (file ? 'Instrucciones copiadas. En ChatGPT adjunta la foto y pega.' : 'Copiado. Pégalo en ChatGPT.') : 'No he podido copiar. Usa tu GPT de Mordisco.');
}

/* pending photo: survives the trip to ChatGPT and back */
const setPending = p => p ? Store.set('pending', p) : Store.del('pending');
const getPending = () => { const p = Store.get('pending'); return p && Date.now() - p.at < 12 * 3600e3 ? p : null; };
function receiveCode(text, fromLink) {
  const res = parseCode(text);
  if (!res) { if (!fromLink) toast('No encuentro el código de Mordisco en ese texto.'); return false; }
  const pend = getPending();
  const date = pend?.date && pend.date <= todayISO() ? pend.date : todayISO();
  if (date !== S.date) loadDay(date);
  S.tab = 'hoy'; render();
  S.draft = { slot: pend?.slot || autoSlot(), thumb: pend?.thumb || null, ...res, status: 'ready', source: pend ? 'foto' : 'chatgpt', portion: 1 };
  renderDraft();
  return true;
}

/* ---------- rendering ---------- */
function render() {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const h = S.profile.history[todayISO()];
  const st = streak();
  $('#pills').innerHTML = (st ? `<span class="pill hot" title="Días seguidos registrando">Racha ${st} ${st === 1 ? 'día' : 'días'}</span>` : '') +
    (h?.score != null ? `<span class="pill" title="Puntuación de hoy">${h.score}/100</span>` : '');
  const v = { hoy: viewToday, progreso: viewProgress, coach: viewCoach, perfil: viewProfile }[S.tab];
  $('#main').innerHTML = v();
}
function ring(val, goal) {
  const r = 56, C = 2 * Math.PI * r, over = val > goal, pct = Math.min(1, val / goal);
  return `<svg viewBox="0 0 132 132" aria-hidden="true"><circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="12"/>
  <circle cx="66" cy="66" r="${r}" fill="none" stroke="${over ? 'var(--bad)' : 'var(--accent)'}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" style="transition:stroke-dashoffset .6s ease"/></svg>`;
}
function bar(label, val, goal, color, unit = 'g') {
  const pct = clamp(val / goal * 100, 0, 100);
  return `<div class="bar"><div class="lab">${label}</div><div class="val">${fmt(val)}<small> / ${fmt(goal)}${unit}</small></div><div class="track"><i style="width:${pct}%;background:${color}"></i></div></div>`;
}
function dateLabel(iso) {
  const t = todayISO();
  if (iso === t) return 'Hoy';
  if (iso === addDays(t, -1)) return 'Ayer';
  return new Date(iso + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
}

function viewToday() {
  const d = S.day, t = targets(S.profile, d), tot = totals(d);
  const left = t.kcal - tot.kcal, over = left < 0;
  const pLeft = Math.max(0, t.p - tot.p);
  const glasses = Math.ceil(t.water / 250), filled = Math.floor(d.water / 250);
  let drops = '';
  for (let i = 0; i < Math.max(glasses, filled); i++) drops += `<button class="drop ${i < filled ? 'on' : ''}" data-act="water" data-ml="${(i + 1) * 250}" aria-label="${(i + 1) * 250} ml"></button>`;
  const stepChips = [[3000, 'Tranquilo'], [7000, 'Normal'], [12000, 'Caminé mucho'], [18000, 'Muchísimo']]
    .map(([n, l]) => `<button class="chip ${d.steps === n ? 'on' : ''}" data-act="steps" data-n="${n}">${l} · ${n / 1000}k</button>`).join('');
  let hint;
  if (!d.meals.length) hint = `Haz una foto de lo que comes con el botón de la cámara. Hoy tienes <strong>${fmt(t.kcal)} kcal</strong> y <strong>${t.p} g de proteína</strong>.`;
  else if (over) hint = `Te has pasado <strong>${fmt(-left)} kcal</strong>. No pasa nada: un día no rompe la semana. Camina un poco más y mañana vuelves al plan.`;
  else if (pLeft > 25) hint = `Te faltan <strong>${R(pLeft)} g de proteína</strong> en <strong>${fmt(left)} kcal</strong>. Mira el Coach para ideas concretas.`;
  else hint = `Vas muy bien. Quedan <strong>${fmt(left)} kcal</strong> y la proteína está casi cubierta.`;
  const pend = getPending();
  const setup = !S.profile.gptReady ? `<section class="card"><h2>Primer paso</h2><p class="tip">Crea tu GPT "Mordisco" en ChatGPT (2 minutos). Así le mandas la foto y con un toque entra aquí.</p><button class="btn solid" data-act="tab" data-tab="perfil">Configurar ChatGPT</button></section>` : '';
  const waiting = pend ? `<section class="card"><h2>Esperando a ChatGPT</h2><div class="row" style="flex-wrap:nowrap">${pend.thumb ? `<img class="thumb" src="${pend.thumb}" alt="">` : ''}<p class="tip" style="flex:1">Cuando ChatGPT responda, toca <strong>Añadir a Mordisco</strong> en su mensaje, o pega aquí su respuesta.</p></div><div class="row"><button class="btn sm solid" data-act="paste">Pegar respuesta</button><button class="btn sm soft" data-act="resend">Enviar otra vez</button><button class="btn sm ghost" data-act="droppending">Descartar</button></div></section>` : '';

  const slots = SLOTS.map(([k, name]) => {
    const ms = d.meals.filter(m => m.slot === k);
    const kc = ms.reduce((a, m) => a + mealKcal(m), 0);
    return `<div class="slot"><div class="slot-h"><h3>${name}</h3><span>${ms.length ? fmt(kc) + ' kcal' : ''}</span></div>
      ${ms.map(m => `<button class="meal" data-act="edit" data-id="${m.id}">
        ${m.thumb ? `<img class="thumb" src="${m.thumb}" alt="">` : `<div class="thumb">${esc((m.name || '?')[0].toUpperCase())}</div>`}
        <div><div class="nm">${esc(m.name)}</div><div class="sub">P ${R(mealP(m))} · C ${R(m.items.reduce((a, i) => a + num(i.c), 0))} · G ${R(m.items.reduce((a, i) => a + num(i.f), 0))}</div></div>
        <div class="kc">${fmt(mealKcal(m))}</div></button>`).join('')}
      <button class="addline" data-act="add" data-slot="${k}">+ Añadir a ${name.toLowerCase()}</button></div>`;
  }).join('');

  return `${setup}${waiting}
  <div class="datenav"><button class="iconbtn" data-act="day" data-n="-1" aria-label="Día anterior">‹</button><h1>${dateLabel(d.date)}</h1><button class="iconbtn" data-act="day" data-n="1" aria-label="Día siguiente" ${d.date >= todayISO() ? 'disabled' : ''}>›</button></div>
  <section class="card">
    <div class="hero">
      <div class="ring">${ring(tot.kcal, t.kcal)}<div class="mid"><div class="big" style="${over ? 'color:var(--bad)' : ''}">${fmt(Math.abs(left))}</div><small>${over ? 'kcal de más' : 'kcal restantes'}</small></div></div>
      <div class="eq">
        <div><span>Objetivo base</span><b>${fmt(t.kcal - t.eatBack)}</b></div>
        <div><span>+ Actividad</span><b>${fmt(t.eatBack)}</b></div>
        <div><span>− Comido</span><b>${fmt(tot.kcal)}</b></div>
        <div class="tot"><span>${over ? 'Exceso' : 'Te quedan'}</span><b>${fmt(Math.abs(left))}</b></div>
      </div>
    </div>
    <div class="bars">${bar('Proteína', tot.p, t.p, 'var(--prot)')}${bar('Carbohidratos', tot.c, t.c, 'var(--carb)')}${bar('Grasa', tot.f, t.f, 'var(--fat)')}</div>
    <div class="micro">
      <span class="pill">Fibra <b>${R(tot.fib)}/${t.fib} g</b></span>
      <span class="pill" style="${tot.sug > t.sug ? 'color:var(--bad)' : ''}">Azúcar <b>${R(tot.sug)}/${t.sug} g</b></span>
      <span class="pill" style="${tot.na > t.na ? 'color:var(--bad)' : ''}">Sodio <b>${fmt(tot.na)}/${fmt(t.na)} mg</b></span>
    </div>
    <p class="tip">${hint}</p>
  </section>

  <section class="card"><h2>Comidas</h2>${slots}</section>

  <section class="card">
    <h2>Agua <b>${(d.water / 1000).toLocaleString('es-ES', { maximumFractionDigits: 2 })} / ${(t.water / 1000).toLocaleString('es-ES')} L</b></h2>
    <div class="water">${drops}</div>
    <div class="row"><button class="btn sm soft" data-act="wadd" data-ml="250">+ Vaso 250 ml</button><button class="btn sm soft" data-act="wadd" data-ml="500">+ Botella 500 ml</button><button class="btn sm ghost" data-act="wadd" data-ml="-250">Quitar</button></div>
  </section>

  <section class="card">
    <h2>Actividad <b>${fmt(d.steps)} pasos${d.exKcal ? ' · +' + fmt(d.exKcal) + ' kcal' : ''}</b></h2>
    <div class="row">${stepChips}</div>
    <div class="grid2">
      <div class="field"><label for="stepsIn">Pasos exactos</label><input id="stepsIn" type="number" inputmode="numeric" min="0" max="80000" value="${d.steps || ''}" placeholder="p. ej. 9500"></div>
      <div class="field"><label for="exIn">Otro ejercicio (kcal)</label><input id="exIn" type="number" inputmode="numeric" min="0" max="3000" value="${d.exKcal || ''}" placeholder="gimnasio, bici…"></div>
    </div>
    <p class="note">Caminar suma ${fmt(t.burned)} kcal quemadas hoy. Solo te devuelvo el 60 % (${fmt(t.eatBack)} kcal) porque los contadores tienden a sobreestimar.</p>
  </section>`;
}

/* progress */
function viewProgress() {
  const p = S.profile, ws = [...p.weights].sort((a, b) => a.date < b.date ? -1 : 1);
  const cur = ws.at(-1)?.kg ?? p.weight, start = ws[0]?.kg ?? p.weight;
  const lost = start - cur;
  const rate = weeklyRate(ws);
  const toGo = cur - p.goal;
  let eta;
  const useRate = rate < -0.05 ? -rate : p.pace;
  if (toGo > 0) { const d = new Date(); d.setDate(d.getDate() + R(toGo / useRate * 7)); eta = d.toLocaleDateString('es-ES', { month: 'short', year: 'numeric' }); }
  else eta = '¡Logrado!';
  const last7 = []; for (let i = 6; i >= 0; i--) { const k = addDays(todayISO(), -i); last7.push({ k, h: p.history[k] }); }
  const logged = last7.filter(x => x.h?.kcal > 0);
  const avgK = logged.length ? logged.reduce((a, x) => a + x.h.kcal, 0) / logged.length : 0;
  const avgP = logged.length ? logged.reduce((a, x) => a + x.h.p, 0) / logged.length : 0;
  const avgS = logged.filter(x => x.h.score != null);
  return `
  <section class="card">
    <h2>Peso</h2>
    <div class="stats">
      <div class="stat"><b>${cur.toLocaleString('es-ES')}</b><span>kg ahora</span></div>
      <div class="stat"><b style="color:${lost > 0 ? 'var(--good)' : 'var(--ink)'}">${lost > 0 ? '−' : ''}${Math.abs(lost).toLocaleString('es-ES', { maximumFractionDigits: 1 })}</b><span>kg perdidos</span></div>
      <div class="stat"><b>${toGo > 0 ? toGo.toLocaleString('es-ES', { maximumFractionDigits: 1 }) : '0'}</b><span>kg hasta ${p.goal}</span></div>
    </div>
    <div class="chart">${weightChart(ws, p.goal)}</div>
    <div class="row" style="flex-wrap:nowrap">
      <div class="field" style="flex:1"><label for="wIn">Peso de hoy (kg)</label><input id="wIn" type="number" inputmode="decimal" step="0.1" min="35" max="250" placeholder="${cur}"></div>
      <button class="btn solid" data-act="weigh" style="align-self:flex-end">Guardar</button>
    </div>
    <p class="note">Sin báscula en casa: pésate cuando puedas (farmacia, gimnasio), siempre a la misma hora. La línea gruesa es la media de 7 días: es la que importa, no el número de un día.</p>
  </section>
  <section class="card">
    <h2>Ritmo</h2>
    <div class="kv"><span>Tendencia real</span><b>${ws.length >= 2 ? (rate <= 0 ? '−' : '+') + Math.abs(rate).toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' kg/semana' : 'Necesito 2 pesajes'}</b></div>
    <div class="kv"><span>Plan</span><b>−${p.pace.toLocaleString('es-ES')} kg/semana</b></div>
    <div class="kv"><span>Llegas a ${p.goal} kg</span><b>${eta}</b></div>
  </section>
  <section class="card">
    <h2>Últimos 7 días</h2>
    <div class="chart">${kcalBars(last7)}</div>
    <div class="stats">
      <div class="stat"><b>${logged.length ? fmt(avgK) : '—'}</b><span>kcal media</span></div>
      <div class="stat"><b>${logged.length ? R(avgP) + ' g' : '—'}</b><span>proteína media</span></div>
      <div class="stat"><b>${avgS.length ? R(avgS.reduce((a, x) => a + x.h.score, 0) / avgS.length) : '—'}</b><span>puntuación</span></div>
    </div>
  </section>`;
}
function weeklyRate(ws) {
  const cut = addDays(todayISO(), -28), pts = ws.filter(w => w.date >= cut);
  if (pts.length < 2) return 0;
  const xs = pts.map(w => (new Date(w.date) - new Date(pts[0].date)) / 864e5), ys = pts.map(w => w.kg);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let nume = 0, den = 0; xs.forEach((x, i) => { nume += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  return den ? nume / den * 7 : 0;
}
function weightChart(ws, goal) {
  if (ws.length < 2) return `<div class="empty"><strong>Tu curva empieza aquí</strong>Apunta tu peso un par de veces y verás la tendencia.</div>`;
  const W = 340, H = 170, pl = 34, pr = 10, pt = 12, pb = 24;
  const t0 = +new Date(ws[0].date), t1 = Math.max(+new Date(ws.at(-1).date), t0 + 864e5);
  const kgs = ws.map(w => w.kg);
  let lo = Math.min(...kgs), hi = Math.max(...kgs);
  if (goal >= lo - 2 && goal < lo) lo = goal;
  lo = Math.floor(lo - 0.5); hi = Math.ceil(hi + 0.5);
  const step = hi - lo > 8 ? 2 : 1;
  const x = d => pl + (+new Date(d) - t0) / (t1 - t0) * (W - pl - pr);
  const y = k => pt + (hi - k) / (hi - lo) * (H - pt - pb);
  let g = '';
  for (let k = lo; k <= hi; k += step) g += `<line x1="${pl}" x2="${W - pr}" y1="${y(k)}" y2="${y(k)}" stroke="var(--line)" stroke-width="1"/><text x="${pl - 6}" y="${y(k) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${k}</text>`;
  if (goal >= lo && goal <= hi) g += `<line x1="${pl}" x2="${W - pr}" y1="${y(goal)}" y2="${y(goal)}" stroke="var(--good)" stroke-dasharray="4 4"/><text x="${W - pr}" y="${y(goal) - 4}" text-anchor="end" font-size="10" fill="var(--good)">objetivo</text>`;
  const avg = ws.map(w => { const from = addDays(w.date, -6); const win = ws.filter(v => v.date >= from && v.date <= w.date); return [w.date, win.reduce((a, v) => a + v.kg, 0) / win.length]; });
  const raw = ws.map(w => `${x(w.date)},${y(w.kg)}`).join(' ');
  const av = avg.map(([d, k]) => `${x(d)},${y(k)}`).join(' ');
  const dots = ws.map(w => `<circle cx="${x(w.date)}" cy="${y(w.kg)}" r="2.5" fill="var(--muted)"/>`).join('');
  const last = avg.at(-1);
  const lab = d => new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución del peso">${g}
    <polyline points="${raw}" fill="none" stroke="var(--muted)" stroke-width="1" opacity=".6"/>${dots}
    <polyline points="${av}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(last[0])}" cy="${y(last[1])}" r="5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
    <text x="${pl}" y="${H - 6}" font-size="10" fill="var(--muted)">${lab(ws[0].date)}</text><text x="${W - pr}" y="${H - 6}" text-anchor="end" font-size="10" fill="var(--muted)">${lab(ws.at(-1).date)}</text></svg>`;
}
function kcalBars(days) {
  const W = 340, H = 150, pb = 22, pt = 14;
  const goal = targets(S.profile, null).kcal;
  const mx = Math.max(goal * 1.3, ...days.map(d => d.h?.kcal || 0));
  const bw = (W - 20) / 7;
  const yv = v => pt + (1 - v / mx) * (H - pt - pb);
  let s = '';
  days.forEach((d, i) => {
    const xx = 10 + i * bw, k = d.h?.kcal || 0, g = d.h?.goal || goal;
    const col = !k ? 'var(--surface-2)' : k > g * 1.05 ? 'var(--bad)' : k < g * 0.7 ? 'var(--warn)' : 'var(--good)';
    s += `<rect x="${xx + bw * 0.2}" y="${k ? yv(k) : H - pb - 3}" width="${bw * 0.6}" height="${k ? H - pb - yv(k) : 3}" rx="4" fill="${col}"/>`;
    s += `<line x1="${xx + bw * 0.1}" x2="${xx + bw * 0.9}" y1="${yv(g)}" y2="${yv(g)}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    s += `<text x="${xx + bw / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${new Date(d.k + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short' }).slice(0, 2)}</text>`;
    if (k) s += `<text x="${xx + bw / 2}" y="${yv(k) - 4}" text-anchor="middle" font-size="9.5" fill="var(--ink)">${fmt(k)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calorías de los últimos 7 días frente al objetivo">${s}</svg>`;
}

/* coach: the app's own advice, plus a one-tap question to ChatGPT */
const FOODS = [
  ['Pechuga de pollo a la plancha (petto di pollo), 1 filete grande ≈150 g', 240, 46],
  ['Pescado blanco (merluzzo) 200 g', 180, 36],
  ['Lata de atún al natural (tonno al naturale) 80 g', 90, 20],
  ['Paquete de bresaola ≈70 g', 105, 22],
  ['Yogur griego 0 % (yogurt greco), 1 tarrina 170 g', 95, 17],
  ['Skyr natural 150 g', 95, 16],
  ['Fiocchi di latte, 1 tarrina 200 g', 190, 24],
  ['1 huevo + 3 claras en tortilla', 125, 17],
  ['Mozzarella light, 1 bola 125 g', 200, 25],
  ['Bote de garbanzos o lentejas escurridos ≈240 g', 280, 17],
  ['Batido de proteína whey, 1 cacito con agua', 120, 24]
];
function coachTips() {
  const d = S.day, t = targets(S.profile, d), tot = totals(d);
  const kLeft = t.kcal - tot.kcal, pLeft = t.p - tot.p, wLeft = t.water - d.water, hour = new Date().getHours();
  const tips = [];
  if (!d.meals.length) tips.push(`Aún no has apuntado nada. Hoy tienes <strong>${fmt(t.kcal)} kcal</strong> y <strong>${t.p} g de proteína</strong>. Intenta meter 30-40 g de proteína en cada comida.`);
  else if (kLeft < 0) tips.push(`Te has pasado <strong>${fmt(-kLeft)} kcal</strong>. Lo que cuenta es la media de la semana: mañana ${fmt(Math.min(300, -kLeft))} kcal menos o 6.000 pasos extra y lo compensas.`);
  else tips.push(`Te quedan <strong>${fmt(kLeft)} kcal</strong> y <strong>${R(Math.max(0, pLeft))} g de proteína</strong>.`);
  if (pLeft > 15 && kLeft > 80) {
    const opts = FOODS.filter(f => f[1] <= kLeft).sort((a, b) => b[2] / b[1] - a[2] / a[1]).slice(0, 4);
    if (opts.length) tips.push(`Para cubrir proteína sin pasarte:<ul>${opts.map(f => `<li>${f[0]}: ${f[1]} kcal, ${f[2]} g proteína</li>`).join('')}</ul>`);
  }
  if (tot.fib < t.fib * 0.5 && hour >= 14) tips.push(`Vas corto de fibra (${R(tot.fib)}/${t.fib} g). Añade verdura a la próxima comida o una pieza de fruta: llena mucho con pocas calorías.`);
  if (wLeft > 500) tips.push(`Te faltan <strong>${(wLeft / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} L de agua</strong>. Deja una botella a la vista.`);
  if (d.steps < 7000 && hour < 21) tips.push(`Un paseo de 30 minutos son unos 3.500 pasos y te sube el objetivo de hoy unas 100 kcal.`);
  const st = streak();
  if (st >= 3) tips.push(`Llevas <strong>${st} días seguidos</strong> apuntando. Eso es lo que más predice que bajes de peso.`);
  return tips.map(t => `<p class="tip">${t}</p>`).join('');
}
function contextBlock() {
  const p = S.profile, t = targets(p, S.day), tot = totals(S.day);
  const week = []; for (let i = 7; i >= 1; i--) { const k = addDays(S.date, -i); const h = p.history[k]; if (h) week.push(`${k}: ${h.kcal} kcal, ${h.p} g prot`); }
  return `Mis datos: ${p.sex === 'f' ? 'mujer' : 'hombre'}, ${p.age} años, ${p.height} cm, ${p.weight} kg, objetivo ${p.goal} kg a ${p.pace} kg/semana. Vivo en Italia, sin báscula de cocina.
Objetivo de hoy: ${t.kcal} kcal, ${t.p} g proteína, ${t.c} g carbos, ${t.f} g grasa, ${t.fib} g fibra.
Llevo hoy (${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}): ${R(tot.kcal)} kcal, ${R(tot.p)} g proteína, ${R(tot.c)} g carbos, ${R(tot.f)} g grasa, ${R(tot.fib)} g fibra, ${S.day.water} ml de agua, ${S.day.steps} pasos.
Comidas de hoy: ${S.day.meals.map(m => `${slotName(m.slot)}: ${m.name} (${R(mealKcal(m))} kcal, ${R(mealP(m))} g prot)`).join('; ') || 'ninguna'}.
Últimos días: ${week.join('; ') || 'sin datos'}.
Pesos recientes: ${p.weights.slice(-6).map(w => `${w.date} ${w.kg} kg`).join(', ')}.`;
}
function viewCoach() {
  return `
  <section class="card"><h2>Tu día</h2>${coachTips()}</section>
  <section class="card">
    <h2>Pregunta a ChatGPT</h2>
    <p class="tip">Le mando tus números de hoy y de la semana junto a tu pregunta, para que te conteste con datos reales.</p>
    <div class="field"><label for="qIn">Tu pregunta</label><textarea id="qIn" placeholder="¿Qué ceno con lo que me queda? ¿Puedo comer pizza esta noche?"></textarea></div>
    <button class="btn solid block" data-act="ask">Preguntar a ChatGPT</button>
  </section>`;
}

/* profile */
function viewProfile() {
  const p = S.profile, t = targets(p, null);
  const sel = (id, opts, v) => `<select id="${id}">${opts.map(([val, l]) => `<option value="${val}" ${String(val) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return `
  <section class="card">
    <h2>Conectar con ChatGPT</h2>
    <ol class="steps">
      <li>En ChatGPT (mejor desde el ordenador): <strong>Explorar GPT → Crear</strong> → pestaña <strong>Configurar</strong>.</li>
      <li>Nombre: <strong>Mordisco</strong>. En <strong>Instrucciones</strong> pega lo que copia este botón:</li>
    </ol>
    <button class="btn soft" data-act="copygpt">Copiar instrucciones</button>
    <ol class="steps" start="3">
      <li>Guarda el GPT solo para ti y copia su enlace (empieza por chatgpt.com/g/…).</li>
      <li>Pégalo aquí para que el botón de la cámara lo abra directo:</li>
    </ol>
    <div class="field"><label for="pGpt">Enlace de tu GPT</label><input id="pGpt" type="url" inputmode="url" value="${esc(p.gptUrl)}" placeholder="https://chatgpt.com/g/g-..."></div>
    <button class="btn solid" data-act="savegpt">Guardar</button>
    <p class="note">Cómo se usa: abres tu GPT Mordisco, le mandas la foto y tocas <strong>Añadir a Mordisco</strong> en su respuesta. También puedes hacer la foto desde aquí y compartirla con ChatGPT.</p>
  </section>
  <section class="card">
    <h2>Tus datos</h2>
    <div class="grid2">
      <div class="field"><label for="pSex">Sexo</label>${sel('pSex', [['m', 'Hombre'], ['f', 'Mujer']], p.sex)}</div>
      <div class="field"><label for="pAge">Edad</label><input id="pAge" type="number" inputmode="numeric" value="${p.age}"></div>
      <div class="field"><label for="pH">Altura (cm)</label><input id="pH" type="number" inputmode="numeric" value="${p.height}"></div>
      <div class="field"><label for="pW">Peso actual (kg)</label><input id="pW" type="number" inputmode="decimal" step="0.1" value="${p.weight}"></div>
      <div class="field"><label for="pGoal">Peso objetivo (kg)</label><input id="pGoal" type="number" inputmode="decimal" step="0.5" value="${p.goal}"></div>
      <div class="field"><label for="pPace">Ritmo</label>${sel('pPace', [[0.25, 'Suave · 0,25 kg/sem'], [0.5, 'Recomendado · 0,5 kg/sem'], [0.75, 'Rápido · 0,75 kg/sem']], p.pace)}</div>
      <div class="field" style="grid-column:1/-1"><label for="pProt">Proteína</label>${sel('pProt', [[1.6, '1,6 g por kg'], [1.8, '1,8 g por kg (recomendado)'], [2.0, '2,0 g por kg'], [2.2, '2,2 g por kg (entreno fuerte)']], p.proteinPerKg)}</div>
    </div>
    <button class="btn solid block" data-act="saveprofile">Guardar y recalcular</button>
  </section>
  <section class="card">
    <h2>Cómo calculo tu día</h2>
    <div class="kv"><span>Metabolismo basal (Mifflin-St Jeor)</span><b>${fmt(t.bmr)} kcal</b></div>
    <div class="kv"><span>Gasto en un día sentado</span><b>${fmt(t.base)} kcal</b></div>
    <div class="kv"><span>Déficit para −${p.pace.toLocaleString('es-ES')} kg/semana</span><b>−${fmt(t.deficit)} kcal</b></div>
    <div class="kv"><span>Objetivo base</span><b>${fmt(t.kcal)} kcal</b></div>
    <div class="kv"><span>Proteína · Carbos · Grasa</span><b>${t.p} · ${t.c} · ${t.f} g</b></div>
    <div class="kv"><span>Agua</span><b>${(t.water / 1000).toLocaleString('es-ES')} L + extra si caminas</b></div>
    <p class="note">Los días que caminas más, el objetivo sube solo según tus pasos. Proteína alta para que lo que pierdas sea grasa y no músculo. Si en 3 semanas la media de peso no baja, baja el ritmo de comida 150 kcal (ritmo más rápido).</p>
  </section>
  <section class="card">
    <h2>Copia de seguridad</h2>
    <p class="tip">Tus datos se guardan solo en este móvil. Exporta una copia de vez en cuando por si cambias de teléfono o borras el navegador.</p>
    <div class="row"><button class="btn soft" data-act="export">Exportar copia</button><button class="btn soft" data-act="import">Importar copia</button></div>
    <input type="file" id="impIn" accept="application/json,.json" hidden>
  </section>`;
}

/* ---------- sheet (add / review / edit) ---------- */
function openSheet(html) { $('#sheet').innerHTML = `<div class="grab"></div><div class="in">${html}</div>`; $('#sheetWrap').hidden = false; }
function closeSheet() { if (S.draft?.url) URL.revokeObjectURL(S.draft.url); S.draft = null; $('#sheetWrap').hidden = true; }

function openAdd(slot) {
  S.slotFor = slot;
  const recent = (S.profile.recent || []).slice(0, 8);
  openSheet(`<h2>Añadir a ${slotName(slot).toLowerCase()}</h2>
    <div class="opts">
      <button class="opt main" data-act="cam"><b>Hacer foto</b><span>Se la mandas a ChatGPT y la comida vuelve aquí con un toque</span></button>
      <button class="opt" data-act="gal"><b>De la galería</b><span>Una foto que ya tengas</span></button>
      <button class="opt" data-act="describe"><b>Describir</b><span>"Plato de pasta al pesto y una pera"</span></button>
      <button class="opt" data-act="paste"><b>Pegar de ChatGPT</b><span>Su respuesta con el código</span></button>
      <button class="opt" data-act="manual"><b>A mano</b><span>Si sabes las kcal (etiqueta)</span></button>
    </div>
    ${recent.length ? `<h2 style="font-size:17px">Repetir</h2><div class="recent">${recent.map((r, i) => `<button class="meal" data-act="repeat" data-i="${i}">${r.thumb ? `<img class="thumb" src="${r.thumb}" alt="">` : `<div class="thumb">${esc((r.name || '?')[0].toUpperCase())}</div>`}<div><div class="nm">${esc(r.name)}</div><div class="sub">P ${R(mealP(r))} g</div></div><div class="kc">${fmt(mealKcal(r))}</div></button>`).join('')}</div>` : ''}
    <button class="btn ghost" data-act="close">Cancelar</button>`);
}
async function onPhoto(file) {
  if (!file) return;
  const slot = S.slotFor || autoSlot();
  const dr = { slot, file, url: URL.createObjectURL(file), thumb: null, status: 'photo' };
  S.draft = dr; renderDraft();
  dr.thumb = await makeThumb(file);
  setPending({ at: Date.now(), slot, thumb: dr.thumb, date: S.date });
}
async function makeThumb(file) {
  try {
    const bmp = await createImageBitmap(file), s = 112, c = document.createElement('canvas');
    const r = Math.max(s / bmp.width, s / bmp.height); c.width = c.height = s;
    const w = bmp.width * r, h = bmp.height * r;
    c.getContext('2d').drawImage(bmp, (s - w) / 2, (s - h) / 2, w, h);
    return c.toDataURL('image/jpeg', 0.6);
  } catch { return null; }
}
const blankItem = () => ({ name: '', grams: 0, kcal: 0, p: 0, c: 0, f: 0, fib: 0, sug: 0, na: 0 });
const pasteBox = `<div class="field"><label for="dPaste">¿No te sale el enlace? Pega aquí la respuesta de ChatGPT</label><textarea id="dPaste" placeholder="add=Pasta_al_pesto;media;…"></textarea></div><button class="btn soft" data-act="readpaste">Leer respuesta</button>`;

function renderDraft() {
  const dr = S.draft; if (!dr) return;
  const img = dr.url ? `<img class="photo" src="${dr.url}" alt="Tu comida">` : '';
  const slotSel = `<select id="dSlot">${SLOTS.map(([k, n]) => `<option value="${k}" ${k === dr.slot ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  let body = '';
  if (dr.status === 'photo') {
    body = `${img}
      <div class="field"><label for="dCtx">Contexto opcional</label><input id="dCtx" type="text" placeholder="con aceite, media ración, pasta 100 g en seco…"></div>
      <button class="btn solid block" data-act="sharephoto">Enviar a ChatGPT</button>
      <p class="note">Elige ChatGPT en la lista. Las instrucciones van con la foto y además quedan copiadas por si hace falta pegarlas. Si usas tu GPT Mordisco, guarda la foto y mándasela allí.</p>
      ${pasteBox}
      <div class="row"><button class="btn ghost" data-act="manual">Añadir a mano</button><button class="btn ghost" data-act="close">Cerrar</button></div>`;
  } else if (dr.status === 'describe') {
    body = `<h2>Describe lo que comes</h2>
      <div class="field"><label for="dText">Cuanto más concreto, mejor</label><textarea id="dText" placeholder="Un plato hondo de pasta al ragù con parmesano, una ensalada con aceite y un vaso de vino tinto">${esc(dr.text || '')}</textarea></div>
      <button class="btn solid block" data-act="sharetext">Enviar a ChatGPT</button>
      ${pasteBox}
      <button class="btn ghost" data-act="close">Cancelar</button>`;
  } else if (dr.status === 'paste') {
    body = `<h2>Pegar de ChatGPT</h2>${pasteBox}<button class="btn ghost" data-act="close">Cancelar</button>`;
  } else {
    const k = dr.portion;
    const sum = dr.items.reduce((a, it) => { for (const f of ['kcal', 'p', 'c', 'f']) a[f] += num(it[f]) * k; return a; }, { kcal: 0, p: 0, c: 0, f: 0 });
    const portions = [[0.5, '½'], [0.75, '¾'], [1, '1×'], [1.25, '1¼'], [1.5, '1½'], [2, '2×']].map(([v, l]) => `<button class="chip ${v === k ? 'on' : ''}" data-act="portion" data-v="${v}">${l}</button>`).join('');
    body = `${dr.thumb ? `<img class="thumb" src="${dr.thumb}" alt="" style="width:72px;height:72px">` : ''}
      <div class="field"><label for="dName">Plato</label><input id="dName" type="text" value="${esc(dr.name)}" placeholder="Nombre del plato"></div>
      ${dr.confidence ? `<div class="row"><span class="badge ${dr.confidence}">Confianza ${dr.confidence}</span>${dr.notes ? `<span class="note" style="flex:1;min-width:0">${esc(dr.notes)}</span>` : ''}</div>` : ''}
      <div class="sum"><div><b>${fmt(sum.kcal)}</b><span>kcal</span></div><div><b style="color:var(--prot)">${R(sum.p)}</b><span>proteína g</span></div><div><b style="color:var(--carb)">${R(sum.c)}</b><span>carbos g</span></div><div><b style="color:var(--fat)">${R(sum.f)}</b><span>grasa g</span></div></div>
      <div class="field"><label>Ración que te has comido</label><div class="row">${portions}</div></div>
      <div class="items">${dr.items.map((it, i) => `<div class="item">
        <div class="item-h"><input type="text" data-f="name" data-i="${i}" value="${esc(it.name)}" placeholder="Alimento" aria-label="Alimento"><button class="iconbtn" data-act="rmitem" data-i="${i}" aria-label="Quitar">×</button></div>
        <div class="nums">${[['grams', 'g'], ['kcal', 'kcal'], ['p', 'Prot'], ['c', 'Carb'], ['f', 'Grasa']].map(([f, l]) => `<div class="field"><label for="i${i}${f}">${l}</label><input id="i${i}${f}" type="number" inputmode="decimal" data-f="${f}" data-i="${i}" value="${it[f] ? R(it[f] * 10) / 10 : ''}"></div>`).join('')}</div>
      </div>`).join('')}</div>
      <button class="addline" data-act="additem">+ Añadir alimento</button>
      <p class="note">Si cambias los gramos, recalculo el resto en proporción. Para corregir con IA, díselo a ChatGPT en la misma conversación y toca su nuevo enlace.</p>
      <div class="field"><label for="dSlot">Momento</label>${slotSel}</div>
      <button class="btn solid block" data-act="savemeal">${dr.editId ? 'Guardar cambios' : 'Añadir al diario'}</button>
      ${dr.editId ? `<button class="btn danger" data-act="delmeal">${dr.confirmDel ? 'Toca otra vez para borrar' : 'Borrar comida'}</button>` : `<button class="btn ghost" data-act="discard">Descartar</button>`}`;
  }
  openSheet(body);
}
function saveMeal() {
  const dr = S.draft, k = dr.portion;
  const items = dr.items.filter(it => it.name.trim() || num(it.kcal)).map(it => {
    const o = { ...it }; for (const f of ['grams', 'kcal', 'p', 'c', 'f', 'fib', 'sug', 'na']) o[f] = +(num(it[f]) * k).toFixed(1); return o; });
  if (!items.length) { toast('Añade al menos un alimento con calorías.'); return; }
  const meal = { id: dr.editId || uid(), slot: dr.slot, time: dr.time || new Date().toISOString(), name: (dr.name || items[0].name).trim() || 'Comida', thumb: dr.thumb || null, items, confidence: dr.confidence || null, notes: dr.notes || '', source: dr.source };
  const ms = S.day.meals, idx = ms.findIndex(m => m.id === meal.id);
  if (idx >= 0) ms[idx] = meal; else ms.push(meal);
  const rec = (S.profile.recent || []).filter(r => r.name.toLowerCase() !== meal.name.toLowerCase());
  rec.unshift({ name: meal.name, thumb: meal.thumb, items: meal.items, source: meal.source });
  S.profile.recent = rec.slice(0, 15);
  if (!dr.editId) setPending(null);
  saveDay(); closeSheet(); render();
  toast(`${idx >= 0 ? 'Actualizado' : 'Añadido'} · ${fmt(mealKcal(meal))} kcal · ${R(mealP(meal))} g proteína`);
}
function exportData() {
  const data = {}; for (const k of Store.keys()) data[k] = Store.get(k);
  const blob = new Blob([JSON.stringify({ app: 'mordisco', v: 1, at: new Date().toISOString(), data })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `mordisco-${todayISO()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function importData(file) {
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'mordisco' || !j.data) throw 0;
    for (const [k, v] of Object.entries(j.data)) Store.set(k, v);
    loadState(); render(); toast('Copia importada');
  } catch { toast('Ese archivo no es una copia de Mordisco.'); }
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act, dr = S.draft;
  switch (act) {
    case 'tab': S.tab = a.dataset.tab; render(); scrollTo(0, 0); break;
    case 'day': { const n = addDays(S.date, +a.dataset.n); if (n <= todayISO()) loadDay(n); break; }
    case 'quickphoto': S.slotFor = S.date === todayISO() ? autoSlot() : 'comida'; $('#camIn').click(); break;
    case 'add': openAdd(a.dataset.slot); break;
    case 'cam': $('#camIn').click(); break;
    case 'gal': $('#galIn').click(); break;
    case 'describe': S.draft = { slot: S.slotFor || autoSlot(), status: 'describe' }; renderDraft(); break;
    case 'paste': S.draft = { slot: S.slotFor || autoSlot(), status: 'paste' }; renderDraft(); break;
    case 'manual': S.draft = { slot: dr?.slot || S.slotFor || autoSlot(), thumb: dr?.thumb || null, items: [blankItem()], name: '', status: 'ready', source: 'manual', portion: 1 }; renderDraft(); break;
    case 'close': closeSheet(); break;
    case 'discard': closeSheet(); toast('Descartado'); break;
    case 'repeat': { const r = S.profile.recent[+a.dataset.i]; S.draft = { slot: S.slotFor || autoSlot(), name: r.name, thumb: r.thumb, items: structuredClone(r.items), status: 'ready', source: r.source, portion: 1 }; renderDraft(); break; }
    case 'sharephoto': sendToGPT(photoPrompt($('#dCtx').value.trim()), dr.file); break;
    case 'sharetext': { const t = $('#dText').value.trim(); if (!t) { toast('Escribe qué has comido.'); return; } dr.text = t; setPending(null); sendToGPT(textPrompt(t)); break; }
    case 'readpaste': receiveCode($('#dPaste').value); break;
    case 'resend': { const p = getPending(); S.slotFor = p?.slot; $('#galIn').click(); toast('Elige la foto otra vez'); break; }
    case 'droppending': setPending(null); render(); break;
    case 'portion': dr.portion = +a.dataset.v; renderDraft(); break;
    case 'rmitem': dr.items.splice(+a.dataset.i, 1); if (!dr.items.length) dr.items.push(blankItem()); renderDraft(); break;
    case 'additem': dr.items.push(blankItem()); renderDraft(); break;
    case 'savemeal': saveMeal(); break;
    case 'edit': { const m = S.day.meals.find(x => x.id === a.dataset.id); if (!m) return; S.draft = { ...structuredClone(m), editId: m.id, status: 'ready', portion: 1 }; renderDraft(); break; }
    case 'delmeal': if (!dr.confirmDel) { dr.confirmDel = true; renderDraft(); return; } S.day.meals = S.day.meals.filter(m => m.id !== dr.editId); saveDay(); closeSheet(); render(); toast('Comida borrada'); break;
    case 'water': { const ml = +a.dataset.ml; S.day.water = S.day.water === ml ? ml - 250 : ml; saveDay(); render(); break; }
    case 'wadd': S.day.water = Math.max(0, S.day.water + +a.dataset.ml); saveDay(); render(); break;
    case 'steps': S.day.steps = +a.dataset.n; saveDay(); render(); break;
    case 'weigh': {
      const kg = num($('#wIn').value); if (kg < 35 || kg > 250) { toast('Pon un peso válido en kg.'); return; }
      const p = S.profile, d = todayISO(); p.weights = p.weights.filter(w => w.date !== d); p.weights.push({ date: d, kg: +kg.toFixed(1) });
      p.weights.sort((x, y) => x.date < y.date ? -1 : 1); if (p.weights.length > 600) p.weights.shift();
      p.weight = p.weights.at(-1).kg; saveProfile(); render(); toast('Peso guardado · objetivos recalculados'); break;
    }
    case 'saveprofile': {
      const p = S.profile;
      p.sex = $('#pSex').value; p.age = clamp(R(num($('#pAge').value, p.age)), 14, 90); p.height = clamp(R(num($('#pH').value, p.height)), 120, 230);
      const w = clamp(num($('#pW').value, p.weight), 35, 250);
      if (w !== p.weight) { const d = todayISO(); p.weights = p.weights.filter(x => x.date !== d); p.weights.push({ date: d, kg: +w.toFixed(1) }); p.weights.sort((x, y) => x.date < y.date ? -1 : 1); }
      p.weight = +w.toFixed(1); p.goal = clamp(num($('#pGoal').value, p.goal), 35, 250); p.pace = num($('#pPace').value, 0.5); p.proteinPerKg = num($('#pProt').value, 1.8);
      saveProfile(); updateHistory(); render(); toast('Guardado. Nuevo objetivo: ' + fmt(targets(p, null).kcal) + ' kcal'); break;
    }
    case 'copygpt': copyText(gptInstructions()).then(ok => toast(ok ? 'Instrucciones copiadas' : 'No se pudo copiar')); break;
    case 'savegpt': {
      const u = $('#pGpt').value.trim();
      if (u && !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(u)) { toast('Pega el enlace de tu GPT (chatgpt.com/g/…).'); return; }
      S.profile.gptUrl = u; S.profile.gptReady = true; saveProfile(); render(); toast('Listo'); break;
    }
    case 'ask': { const q = $('#qIn').value.trim(); if (!q) { toast('Escribe tu pregunta.'); return; } sendToGPT(`${contextBlock()}\n\nPregunta: ${q}\n\nContesta en español de España, corto y concreto (máximo 150 palabras), como un buen entrenador personal. Si propones comida, da cantidades a ojo (sin báscula) con kcal y proteína, y productos de supermercado italiano.`); break; }
    case 'export': exportData(); break;
    case 'import': $('#impIn').click(); break;
  }
});
document.addEventListener('change', e => {
  const el = e.target, dr = S.draft;
  if (el.id === 'camIn' || el.id === 'galIn') { const f = el.files[0]; el.value = ''; onPhoto(f); return; }
  if (el.id === 'impIn') { const f = el.files[0]; el.value = ''; if (f) importData(f); return; }
  if (el.id === 'stepsIn') { S.day.steps = clamp(R(num(el.value)), 0, 80000); saveDay(); render(); return; }
  if (el.id === 'exIn') { S.day.exKcal = clamp(R(num(el.value)), 0, 3000); saveDay(); render(); return; }
  if (!dr) return;
  if (el.id === 'dSlot') { dr.slot = el.value; return; }
  if (el.id === 'dName') { dr.name = el.value; return; }
  if (el.dataset.f) {
    const it = dr.items[+el.dataset.i], f = el.dataset.f;
    if (f === 'name') { it.name = el.value; return; }
    const v = Math.max(0, num(el.value));
    if (f === 'grams' && it.grams > 0 && v > 0) { const r = v / it.grams; for (const k of ['kcal', 'p', 'c', 'f', 'fib', 'sug', 'na']) it[k] = +(num(it[k]) * r).toFixed(1); }
    it[f] = v; renderDraft();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheetWrap').hidden) closeSheet(); });

/* ---------- incoming links and shares from ChatGPT ---------- */
function checkIncoming() {
  const hash = location.hash.slice(1), qs = new URLSearchParams(location.search);
  const shared = [qs.get('title'), qs.get('text'), qs.get('url')].filter(Boolean).join('\n');
  if (!hash && !shared) return;
  history.replaceState(null, '', location.pathname);
  if (hash.includes('add=')) { receiveCode(hash, true) || toast('Ese enlace no trae una comida válida. Pide a ChatGPT que lo repita.'); return; }
  if (shared) { if (!receiveCode(shared, true)) { S.draft = { slot: autoSlot(), status: 'paste' }; renderDraft(); $('#dPaste').value = shared; toast('No he encontrado el código en lo compartido.'); } }
}
window.addEventListener('hashchange', checkIncoming);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  loadState(); if (!S.draft) render();   // pick up a meal added from a ChatGPT link in another tab
});

/* ---------- boot ---------- */
loadState();
render();
checkIncoming();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
