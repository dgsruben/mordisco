/* Mordisco — contador de calorías con foto. ChatGPT analiza el plato; la app hace todo lo demás. */

/* ---------- utilities ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v, d = 0) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : d; };
const R = n => Math.round(n);
const fmt = n => R(n).toLocaleString('es-ES');
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const uid = () => Math.random().toString(36).slice(2, 10);
const isoOf = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const todayISO = () => isoOf(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoOf(d); };
const weekday = iso => (new Date(iso + 'T12:00:00').getDay() + 6) % 7;   // 0 = lunes
const weekStart = iso => addDays(iso, -weekday(iso));
const DAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const hhmm = d => new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
const hm = h => `${Math.floor(h)} h ${String(Math.floor(h % 1 * 60)).padStart(2, '0')} min`;
const SLOTS = [['desayuno','Desayuno'],['comida','Comida'],['merienda','Merienda'],['cena','Cena'],['snack','Picoteo']];
const slotName = k => (SLOTS.find(s => s[0] === k) || SLOTS[4])[1];
const autoSlot = () => { const h = new Date().getHours(); return h < 11 ? 'desayuno' : h < 16 ? 'comida' : h < 19 ? 'merienda' : h < 23 ? 'cena' : 'snack'; };
const normSlot = s => { s = String(s).toLowerCase(); return s.startsWith('desa') ? 'desayuno' : s.startsWith('com') || s.startsWith('alm') ? 'comida' : s.startsWith('mer') ? 'merienda' : s.startsWith('cen') ? 'cena' : 'snack'; };
const APP_URL = location.origin + location.pathname.replace(/index\.html$/, '');
const buzz = () => { try { navigator.vibrate?.(12); } catch {} };
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button class="tbtn" data-act="undo">Deshacer</button>' : ''}`;
  S.undo = undo || null; t.hidden = false; clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; S.undo = null; }, undo ? 5000 : 2800);
}

/* ---------- storage: everything stays on this phone ---------- */
const Store = {
  lk: k => 'mordisco:' + k,
  get(k) { try { return JSON.parse(localStorage.getItem(this.lk(k))); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(this.lk(k), JSON.stringify(v)); return true; } catch { toast('El móvil no deja guardar más. Exporta una copia de seguridad.'); return false; } },
  del(k) { try { localStorage.removeItem(this.lk(k)); } catch {} },
  keys() { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('mordisco:')) out.push(k.slice(9)); } } catch {} return out; }
};
navigator.storage?.persist?.().catch(() => {});
// progress photos are big, so they live in IndexedDB
const PhotoDB = {
  p: null,
  open() { return this.p ||= new Promise((res, rej) => { const r = indexedDB.open('mordisco', 1); r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async run(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('photos', mode); const req = fn(t.objectStore('photos')); t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error); }); },
  put(rec) { return this.run('readwrite', st => st.put(rec)); },
  all() { return this.run('readonly', st => st.getAll()); },
  del(id) { return this.run('readwrite', st => st.delete(id)); }
};

/* ---------- state ---------- */
const defaultProfile = () => ({ sex: 'm', age: 22, height: 175, weight: 82, goal: 74, pace: 0.5, proteinPerKg: 1.8,
  weekly: true, outDay: 2, outBonus: 400, calib: 0,
  fasting: { on: false, hours: 16 }, fastStart: null, fasts: [],
  weights: [{ date: todayISO(), kg: 82 }], history: {}, recent: [], plan: null, gptUrl: '', gptReady: false,
  geminiKey: '', aiPrecise: true });
const emptyDay = date => ({ date, meals: [], water: 0, steps: 0, exKcal: 0 });
const S = { tab: 'hoy', date: todayISO(), profile: null, day: null, draft: null, slotFor: null, undo: null, photos: [] };

/* ---------- the numbers ---------- */
function targets(p, day, kcalOverride) {
  const w = p.weight, male = p.sex !== 'f';
  const bmr = 10 * w + 6.25 * p.height - 5 * p.age + (male ? 5 : -161);
  const base = bmr * 1.2 + (p.calib || 0);                  // sedentary baseline, corrected by your real expenditure
  const steps = day?.steps || 0;
  const stepKcal = Math.max(0, steps - 3000) * 0.00057 * w;  // ~0.047 kcal per step at 82 kg
  const burned = stepKcal + (day?.exKcal || 0);
  const deficit = p.pace * 7700 / 7;                         // 7,700 kcal ≈ 1 kg of fat
  const floor = male ? 1500 : 1200;
  const kcal = Math.max(floor, R((kcalOverride ?? base - deficit + burned * 0.6) / 10) * 10); // eat back 60% only
  const pr = R(p.proteinPerKg * w / 5) * 5;
  const f = R(Math.max(0.7 * w, kcal * 0.25 / 9));
  const c = Math.max(50, R((kcal - pr * 4 - f * 9) / 4));
  const fib = Math.max(25, R(kcal / 1000 * 14));
  const water = R((35 * w + steps / 1000 * 60) / 100) * 100;
  return { kcal, p: pr, c, f, fib, sug: 50, na: 2300, water, bmr: R(bmr), base: R(base), burned: R(burned), eatBack: R(burned * 0.6), deficit: R(deficit) };
}
// the day's share of the week before rebalancing: eating-out day gets a bonus, the other six pay for it
function plannedFor(date, day) {
  const p = S.profile, k = targets(p, day).kcal;
  if (!p.weekly || p.outDay < 0) return k;
  return k + (weekday(date) === p.outDay ? p.outBonus : -R(p.outBonus / 6));
}
// today's target with the weekly budget: what you saved or overate earlier this week is spread over the days left
function dayTargets(date = S.day.date, day = S.day) {
  const p = S.profile, planned = plannedFor(date, day);
  let adj = 0, week = null;
  if (p.weekly) {
    const ws = weekStart(date); let before = 0, eaten = 0, rest = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i), h = p.history[d];
      const pk = plannedFor(d, d === day.date ? day : { steps: h?.steps || 0, exKcal: h?.ex || 0 });
      if (d < date) { before += pk; eaten += h?.kcal > 0 ? h.kcal : pk; } else rest += pk;
    }
    const saved = before - eaten;
    adj = clamp(R(saved * planned / rest / 10) * 10, -300, 300);
    week = { budget: before + rest, eaten, saved };
  }
  const t = targets(p, day, planned + adj);
  t.adj = adj; t.week = week; t.outShare = planned - targets(p, day).kcal;
  t.outToday = p.weekly && p.outDay >= 0 && weekday(date) === p.outDay;
  return t;
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
function weeklyRate(ws, days = 28) {
  const cut = addDays(todayISO(), -days), pts = ws.filter(w => w.date >= cut);
  if (pts.length < 2) return 0;
  const xs = pts.map(w => (new Date(w.date) - new Date(pts[0].date)) / 864e5), ys = pts.map(w => w.kg);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let nume = 0, den = 0; xs.forEach((x, i) => { nume += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  return den ? nume / den * 7 : 0;
}
// real expenditure from what you ate and how your weight moved (last 4 weeks)
function realExpenditure() {
  const p = S.profile, from = addDays(todayISO(), -28), today = todayISO();
  const days = Object.entries(p.history).filter(([d, h]) => d >= from && d < today && h.kcal > 0);
  const ws = [...p.weights].sort((a, b) => a.date < b.date ? -1 : 1).filter(w => w.date >= from);
  const span = ws.length >= 2 ? (new Date(ws.at(-1).date) - new Date(ws[0].date)) / 864e5 : 0;
  if (days.length < 10 || span < 10) return { ready: false, needDays: Math.max(0, 10 - days.length), span: R(span) };
  const intake = days.reduce((a, [, h]) => a + h.kcal, 0) / days.length;
  const avgSteps = days.reduce((a, [, h]) => a + (h.steps || 0), 0) / days.length;
  const rate = weeklyRate(ws);
  const tdee = R(intake - rate / 7 * 7700);
  const t = targets(p, { steps: avgSteps, exKcal: 0 });
  const modeled = R(t.base - (p.calib || 0) + t.burned);
  return { ready: true, tdee, intake: R(intake), days: days.length, modeled, rate };
}

/* ---------- persistence helpers ---------- */
const saveProfile = () => Store.set('profile', S.profile);
function saveDay() { Store.set('day-' + S.day.date, S.day); updateHistory(); }
function updateHistory() {
  const d = S.day, t = dayTargets(), tot = totals(d), h = S.profile.history;
  if (!d.meals.length && !d.water && !d.steps) delete h[d.date];
  else h[d.date] = { kcal: R(tot.kcal), p: R(tot.p), c: R(tot.c), f: R(tot.f), fib: R(tot.fib), water: d.water, steps: d.steps, ex: d.exKcal, goal: t.kcal, pgoal: t.p, score: dayScore(t, tot, d) };
  const keys = Object.keys(h).sort();
  while (keys.length > 400) delete h[keys.shift()];
  saveProfile();
}
function loadState() {
  const saved = Store.get('profile') || {};
  S.profile = Object.assign(defaultProfile(), saved);
  S.profile.fasting = Object.assign({ on: false, hours: 16 }, saved.fasting || {});
  S.day = Object.assign(emptyDay(S.date), Store.get('day-' + S.date) || {});
}
function loadDay(date) { S.date = date; S.day = Object.assign(emptyDay(date), Store.get('day-' + date) || {}); render(); }
function addMeal(meal, msg) {
  const before = JSON.stringify(S.day.meals), fastBefore = S.profile.fastStart, fastsBefore = S.profile.fasts;
  S.day.meals.push(meal); bumpRecent(meal);
  const endedFast = maybeEndFast(meal);
  saveDay(); render(); buzz();
  toast(msg || `Añadido · ${fmt(mealKcal(meal))} kcal · ${R(mealP(meal))} g proteína${endedFast ? ' · ayuno terminado' : ''}`,
    () => { S.day.meals = JSON.parse(before); S.profile.fastStart = fastBefore; S.profile.fasts = fastsBefore; saveDay(); render(); });
}
function bumpRecent(meal) {
  const rec = S.profile.recent || [];
  const old = rec.find(r => r.name.toLowerCase() === meal.name.toLowerCase());
  const entry = { name: meal.name, thumb: meal.thumb, items: meal.items, source: meal.source, slot: meal.slot, n: (old?.n || 0) + 1, last: Date.now() };
  S.profile.recent = [entry, ...rec.filter(r => r !== old)].slice(0, 30);
}

/* ---------- ChatGPT bridge ---------- */
const FORMAT = `FORMATO DEL CÓDIGO DE COMIDA (obligatorio, sin espacios):
add=NOMBRE;CONFIANZA;ALIMENTO1|ALIMENTO2|...;NOTA
- NOMBRE y NOTA: palabras unidas con guion bajo, sin tildes ni ñ, sin comas, punto y coma ni barras. Ej: Pasta_al_pesto
- CONFIANZA: alta, media o baja
- Cada ALIMENTO: nombre,gramos,kcal,proteina,carbohidratos,grasa,fibra,azucar,sodio_mg
  Números con punto decimal (12.5), sin unidades. El nombre con guion bajo.
Ejemplo:
add=Pasta_al_pesto;media;Pasta_cocida,250,330,12,66,1.5,4,1.5,5|Pesto,30,150,2,1.5,15,0.5,0.5,300|Parmesano,10,40,3.5,0,2.8,0,0,160;Supongo_plato_hondo_lleno`;
const PLAN_FORMAT = `FORMATO DEL CÓDIGO DE PLAN (obligatorio, sin espacios):
plan=COMIDAS;COMPRA
- COMIDAS separadas por |. Cada una: dia,momento,Nombre,kcal,proteina,carbohidratos,grasa
  dia: 1=lunes ... 7=domingo. momento: desayuno, comida, merienda, cena o picoteo.
- COMPRA: productos separados por |, cada uno con su cantidad. Ej: Pechuga_de_pollo_1kg
- Palabras con guion bajo, sin tildes ni ñ, sin comas dentro de los nombres.
Ejemplo:
plan=1,desayuno,Yogur_griego_con_avena_y_fresas,380,32,45,7|1,comida,Arroz_con_pollo_y_verduras,620,48,70,14;Pechuga_de_pollo_1kg|Yogur_griego_0_x6|Arroz_1kg`;
const METHOD = `Eres un dietista-nutricionista experto en estimar comida a partir de fotos o descripciones, más preciso que Cal AI o MyFitnessPal. Vivo en Italia, cocino casi siempre yo, no tengo báscula de cocina y quiero perder grasa: necesito estimaciones fieles, ni optimistas ni infladas.

Método:
- Separa cada alimento y estima sus gramos tal como está servido.
- Escala: plato llano ≈ 26-27 cm, plato hondo ≈ 22 cm, tenedor ≈ 19 cm, vaso ≈ 250 ml, lata de atún 80 g escurrido, huevo M ≈ 50 g, rebanada de pan ≈ 30-35 g. Mira también la altura de la comida.
- Raciones italianas: pasta 80-120 g en seco ≈ 200-300 g cocida; pizza entera de pizzería ≈ 750-1000 kcal; cornetto ≈ 250-300 kcal.
- Cadenas y comida para llevar (McDonald's, Burger King, KFC, Old Wild West, poke, kebab, pizza al taglio): usa los valores oficiales de la cadena en Italia si los conoces, con salsas y bebida.
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
const photoPrompt = extra => `${METHOD}\n\nAnaliza la comida de la foto que te adjunto.${extra ? '\nContexto: ' + extra : ''}\n\n${replyRules()}`;
const textPrompt = desc => `${METHOD}\n\nAnaliza esta comida: "${desc}"\n\n${replyRules()}`;
function planPrompt(asJSON) {
  const p = S.profile, t = targets(p, { steps: 7000 });
  const fast = p.fasting.on ? `\n- Hago ayuno ${p.fasting.hours}:${24 - p.fasting.hours}: todas las comidas dentro de una ventana de ${24 - p.fasting.hours} h (comida, merienda y cena; sin desayuno).` : '\n- 4 comidas al día: desayuno, comida, merienda y cena.';
  const out = p.weekly && p.outDay >= 0 ? `\n- Los ${DAYS[p.outDay]} como fuera a mediodía: pon esa comida como "Comida fuera" con unas ${R((t.kcal * 0.4 + p.outBonus) / 50) * 50} kcal y aligera el resto de ese día.` : '';
  return `Hazme un plan de comidas para 7 días (lunes a domingo) para perder grasa sin pasar hambre.

Mis objetivos por día (aproximados, ±100 kcal): ${t.kcal} kcal, mínimo ${t.p} g de proteína, unos ${t.c} g de carbohidratos y ${t.f} g de grasa.
- Hombre de ${p.age} años, ${p.weight} kg, ${p.height} cm. Camino; de momento no hago pesas.
- Vivo en Italia y cocino yo: productos de Esselunga, Conad, Lidl o Coop.
- Recetas sencillas de 20 minutos o menos, ingredientes que se repitan durante la semana para no tirar comida, y alguna cocinada en tanda para varios días.
- No tengo báscula: da las cantidades en medidas caseras (puñado, cucharada, lata, pieza, plato) con los gramos aproximados.${fast}${out}
- Comida rica y variada. Mucha verdura y proteína en cada comida para estar saciado.
` + (asJSON ? `
Responde solo con JSON con esta forma:
{"meals":[{"d":1,"slot":"desayuno|comida|merienda|cena","name":"nombre corto del plato","kcal":0,"p":0,"c":0,"f":0,"recipe":"ingredientes con cantidades caseras y cómo se hace, en 1-2 frases"}],"shop":["producto y cantidad para toda la semana"]}
d: 1 = lunes ... 7 = domingo. p, c y f en gramos.` : `
Responde en este orden:
1. El plan día por día, con cantidades y kcal y proteína de cada comida.
2. La lista de la compra de toda la semana, agrupada por secciones del supermercado.
3. Este enlace en Markdown: [Cargar plan en Mordisco](${APP_URL}#CODIGO) donde CODIGO es el código de abajo.
4. El mismo código en un bloque de código, en una sola línea.

${PLAN_FORMAT}`);
}
function gptInstructions() {
  return `${METHOD}\n\nCuando te mande una foto de comida o te describa lo que he comido, analízala.\n\n${replyRules()}\n\nSi te pido un plan semanal, termina con un enlace [Cargar plan en Mordisco](${APP_URL}#CODIGO) y el código en un bloque, con este formato:\n${PLAN_FORMAT}\n\nSi te pregunto otra cosa sobre nutrición, contesta corto, en español de España, como un buen entrenador personal.`;
}

function decodeField(s) { let v = s; try { v = decodeURIComponent(s); } catch {} return v.replace(/[_+]/g, ' ').replace(/\s+/g, ' ').trim(); }
function grab(text, key) {
  const m = String(text).match(new RegExp(key + '=([^\\s)\\]`"\'<>]+)'));
  if (!m) return null;
  let raw = m[1];
  if (/%3B|%7C|%2C/i.test(raw)) { try { raw = decodeURIComponent(raw); } catch {} }
  return raw;
}
function parseCode(text) {
  const raw = text && grab(text, 'add'); if (!raw) return null;
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
function parsePlan(text) {
  const raw = text && grab(text, 'plan'); if (!raw) return null;
  const [ms, shop = ''] = raw.split(';');
  const meals = ms.split('|').map(x => x.split(',')).filter(f => f.length >= 7).map(f => ({
    d: clamp(R(num(f[0], 1)), 1, 7), slot: normSlot(decodeField(f[1])), name: decodeField(f[2]) || 'Comida',
    kcal: R(num(f[3])), p: R(num(f[4])), c: R(num(f[5])), f: R(num(f[6])), done: false }));
  if (!meals.length) return null;
  return { meals, shop: shop.split('|').map(decodeField).filter(Boolean).map(t => ({ t, done: false })) };
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

/* ---------- Gemini: the AI inside the app (free tier, your own key, stored only on this phone) ---------- */
// used only if Google's model list can't be read; the app normally asks which models this key can use
const GEM_MODELS = { fast: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3-flash-preview'], precise: ['gemini-3.1-pro-preview', 'gemini-pro-latest', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest'] };
async function gemModels(signal) {
  const p = S.profile;
  if (p.aiModels && Date.now() - p.aiModels.at < 3 * 864e5) return p.aiModels;
  let res;
  try { res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': p.geminiKey }, signal }); }
  catch (e) { if (e.name === 'AbortError') throw { code: 'cancelled' }; return GEM_MODELS; }
  if (res.status === 401 || res.status === 403) throw { code: 'badkey' };
  if (!res.ok) { const b = await res.json().catch(() => ({})); if (/api key/i.test(b.error?.message || '')) throw { code: 'badkey' }; return GEM_MODELS; }
  const j = await res.json().catch(() => ({}));
  const ids = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name).replace(/^models\//, ''))
    .filter(id => /^gemini-/.test(id) && !/(lite|image|tts|live|embed|audio|robotics|computer|nano|learnlm|customtools)/.test(id));
  const ver = id => parseFloat((id.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const score = id => ver(id) * 10 - (/preview|exp/.test(id) ? 1 : 0);
  const flash = ids.filter(id => /flash/.test(id)).sort((a, b) => score(b) - score(a));
  const pro = ids.filter(id => /pro/.test(id)).sort((a, b) => score(b) - score(a));
  if (!flash.length && !pro.length) return GEM_MODELS;
  p.aiModels = { fast: flash.slice(0, 3), precise: [...pro.slice(0, 2), ...flash.slice(0, 2)], at: Date.now() };
  if (!p.aiModels.fast.length) p.aiModels.fast = pro.slice(0, 2);
  saveProfile();
  return p.aiModels;
}
const hasAI = () => !!S.profile.geminiKey;
function parseJSONLoose(t) {
  try { return JSON.parse(t); } catch {}
  const m = String(t).match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw { code: 'badjson' };
}
async function gemini(parts, { json = true, signal, precise = S.profile.aiPrecise } = {}) {
  const key = S.profile.geminiKey; if (!key) throw { code: 'nokey' };
  let lastErr = { code: 'http' };
  const list = await gemModels(signal);
  S.tried = [];
  for (const model of precise ? list.precise : list.fast) {
    S.tried.push(model);
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, ...(json ? { responseMimeType: 'application/json' } : {}) } })
      });
    } catch (e) { throw { code: e.name === 'AbortError' ? 'cancelled' : 'network' }; }
    if (res.ok) {
      const j = await res.json();
      const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
      if (!text) { lastErr = { code: 'empty' }; continue; }
      S.lastModel = model;
      return json ? parseJSONLoose(text) : text;
    }
    const body = await res.json().catch(() => ({}));
    const msg = body.error?.message || '';
    if (res.status === 403 || (res.status === 400 && /api key/i.test(msg))) throw { code: 'badkey' };
    lastErr = { code: res.status === 429 ? 'quota' : res.status === 404 ? 'nomodel' : 'http', msg };
    // 404 (model not available), 429 (quota for this model) or 5xx: try the next model
  }
  if (lastErr.code === 'nomodel') { S.profile.aiModels = null; saveProfile(); }   // re-read Google's list next time
  throw lastErr;
}
function aiError(e) {
  return ({
    nokey: 'Falta tu clave de Gemini. Ponla en Perfil.',
    badkey: 'Google no acepta la clave de Gemini. Revísala en Perfil.',
    quota: 'Se ha acabado la cuota gratis de Gemini por ahora. Usa ChatGPT o prueba en un rato.',
    network: 'Sin conexión con Gemini. Revisa internet.',
    badjson: 'La respuesta salió mal formada. Reintenta.',
    empty: 'Gemini no ha devuelto nada. Reintenta o descríbelo con texto.',
    nomodel: 'Google no ha aceptado ningún modelo con tu clave. Toca Probar otra vez en un minuto; si sigue, revisa que la clave sea de aistudio.google.com.'
  })[e?.code] || 'Algo ha fallado con Gemini. Reintenta o usa ChatGPT.';
}
const LOAD_MSGS = ['Reconociendo alimentos…', 'Midiendo raciones por el tamaño del plato…', 'Buscando el aceite escondido…', 'Cuadrando calorías y macros…'];
const blobToB64 =blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
const AI_SCHEMA = `{"dish":"nombre corto del plato","confidence":"alta|media|baja","items":[{"name":"alimento y cómo está cocinado","grams":0,"kcal":0,"p":0,"c":0,"f":0,"fib":0,"sug":0,"na":0}],"notes":"qué has supuesto, en una frase","questions":["hasta 2 preguntas de sí/no cuya respuesta cambiaría las kcal más de un 15 %"],"tip":"un consejo breve para perder grasa sobre este plato"}`;
function aiPrompt(dr, fix) {
  const precise = S.profile.aiPrecise;
  let s = `${METHOD}

${dr.file ? 'Analiza la comida de la foto.' : `Analiza esta comida: "${dr.text}"`}${dr.context ? `\nContexto del usuario: "${dr.context}"` : ''}
${precise ? `
Modo preciso. Antes de responder, razona por dentro paso a paso:
1. Localiza referencias de escala en la imagen (plato, cubiertos, vaso, mano, envases) y estima su tamaño real.
2. Para cada alimento estima volumen → gramos con su densidad, mirando altura y superficie.
3. Busca grasa oculta y salsas.
4. Calcula nutrientes con tablas fiables y comprueba que las kcal cuadran con los macros.
5. Si hay algo dudoso que cambie las kcal más de un 15 % (aceite, salsa, tamaño de ración, tipo de producto), formula hasta 2 preguntas cortas de sí/no. Si no hay dudas importantes, deja questions vacío.` : ''}
Campos: grams (g), kcal, p = proteína g, c = carbohidratos g, f = grasa g, fib = fibra g, sug = azúcares g, na = sodio mg. Números sin unidades.
Si no hay comida, devuelve items vacío y explícalo en notes.`;
  if (fix) s += `\n\nTu estimación anterior:\n${JSON.stringify({ dish: dr.name, items: dr.items })}\nEl usuario aclara: "${fix}"\nRehaz la estimación teniendo en cuenta esto. No repitas preguntas ya contestadas.`;
  return s + `\n\nResponde solo con JSON con esta forma:\n${AI_SCHEMA}`;
}
async function analyzeAI(fix) {
  const dr = S.draft; if (!dr) return;
  dr.status = 'loading'; dr.error = null; renderDraft();
  dr.ctl?.abort(); const ctl = new AbortController(); dr.ctl = ctl;
  try {
    const parts = [{ text: aiPrompt(dr, fix) }];
    if (dr.file) { dr.b64 ||= await blobToB64(await shrinkImage(dr.file, 1280)); parts.push({ inline_data: { mime_type: 'image/jpeg', data: dr.b64 } }); }
    const res = await gemini(parts, { signal: ctl.signal });
    if (S.draft !== dr) return;
    const items = (Array.isArray(res?.items) ? res.items : []).map(it => ({ name: String(it.name || 'Alimento'), grams: R(num(it.grams)), kcal: R(num(it.kcal)), p: +num(it.p).toFixed(1), c: +num(it.c).toFixed(1), f: +num(it.f).toFixed(1), fib: +num(it.fib).toFixed(1), sug: +num(it.sug).toFixed(1), na: R(num(it.na)) }));
    if (!items.length) { dr.status = 'error'; dr.error = res?.notes ? String(res.notes) : 'No veo comida. Prueba otra foto o descríbelo.'; renderDraft(); return; }
    Object.assign(dr, { items, portion: 1, name: String(res.dish || items[0].name), status: 'ready', source: dr.file ? 'foto' : 'texto',
      confidence: ['alta', 'media', 'baja'].includes(res.confidence) ? res.confidence : 'media', notes: res.notes ? String(res.notes) : '', tip: res.tip ? String(res.tip) : '',
      questions: (Array.isArray(res.questions) ? res.questions : []).map(String).filter(Boolean).slice(0, 2), asked: [...(dr.asked || []), ...(fix ? [fix] : [])], ai: true });
    if (dr.file) setPending(null);
  } catch (e) {
    if (S.draft !== dr) return;
    dr.status = dr.items?.length ? 'ready' : 'error'; dr.error = e.code === 'cancelled' ? 'Cancelado.' : aiError(e);
    if (dr.status === 'ready' && e.code !== 'cancelled') toast(dr.error);
  }
  renderDraft();
}
async function askAI(q) {
  const out = $('#coachOut'), card = $('#coachCard');
  S.coachText = 'Pensando…'; if (card) card.hidden = false; if (out) out.innerHTML = mdLite(S.coachText);
  try {
    S.coachText = await gemini([{ text: `Eres el coach de nutrición de Mordisco. Hablas en español de España, cercano y directo, como un buen entrenador personal.\n\n${contextBlock()}\n\nPregunta: ${q}\n\nMáximo 150 palabras, con viñetas "- " si hay lista. Si propones comida, da cantidades a ojo (sin báscula) con kcal y proteína aproximadas y productos de supermercado italiano.` }], { json: false, precise: false });
  } catch (e) { S.coachText = aiError(e); }
  if (S.tab === 'coach') { const o = $('#coachOut'); if (o) o.innerHTML = mdLite(S.coachText); }
}
async function planAI() {
  S.draft = { status: 'plan-view' };
  openSheet(`<h2>Preparando tu plan</h2><div class="loading"><div class="spin"></div><b>Gemini está montando 7 días de menú y la lista de la compra…</b><span class="note">Suele tardar 30-60 segundos.</span></div><button class="btn ghost" data-act="close">Cancelar</button>`);
  try {
    const res = await gemini([{ text: planPrompt(true) }], { precise: S.profile.aiPrecise });
    const meals = (res.meals || []).map(m => ({ d: clamp(R(num(m.d, 1)), 1, 7), slot: normSlot(m.slot), name: String(m.name || 'Comida'), kcal: R(num(m.kcal)), p: R(num(m.p)), c: R(num(m.c)), f: R(num(m.f)), recipe: m.recipe ? String(m.recipe) : '', done: false }));
    if (!meals.length) throw { code: 'empty' };
    if (S.draft?.status !== 'plan-view') return;
    importPlan({ meals, shop: (res.shop || []).map(String).filter(Boolean).map(t => ({ t, done: false })) });
  } catch (e) {
    if (S.draft?.status !== 'plan-view') return;
    openSheet(`<h2>No se pudo hacer el plan</h2><div class="err">${esc(aiError(e))}</div><button class="btn solid" data-act="planGPT">Pedírselo a ChatGPT</button><button class="btn ghost" data-act="close">Cerrar</button>`);
  }
}
function mdLite(t) {
  if (!t) return '';
  const lines = esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').split('\n');
  let out = '', inList = false;
  for (const l of lines) {
    const m = l.match(/^\s*[-*•]\s+(.*)/);
    if (m) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${m[1]}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    if (l.trim()) out += `<p>${l.replace(/^#+\s*/, '')}</p>`;
  }
  return out + (inList ? '</ul>' : '');
}

/* pending photo: survives the trip to ChatGPT and back */
const setPending = p => p ? Store.set('pending', p) : Store.del('pending');
const getPending = () => { const p = Store.get('pending'); return p && Date.now() - p.at < 12 * 3600e3 ? p : null; };
function receiveAny(text, fromLink) {
  const plan = parsePlan(text);
  if (plan) { importPlan(plan); return true; }
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
function importPlan(plan) {
  const t = todayISO(), ws = weekday(t) >= 5 ? addDays(weekStart(t), 7) : weekStart(t);   // a plan made on the weekend is for next week
  S.profile.plan = { week: ws, at: Date.now(), ...plan };
  saveProfile(); closeSheet(); S.tab = 'coach'; render(); scrollTo(0, 0);
  toast(`Plan cargado: ${plan.meals.length} comidas desde el lunes ${new Date(ws + 'T12:00:00').getDate()}`);
}
function planMealsFor(date) {
  const pl = S.profile.plan; if (!pl) return [];
  const idx = (new Date(date + 'T12:00:00') - new Date(pl.week + 'T12:00:00')) / 864e5;
  if (idx < 0 || idx > 6) return [];
  return pl.meals.map((m, i) => ({ ...m, i })).filter(m => m.d === R(idx) + 1);
}

/* ---------- fasting ---------- */
function startFast(from) { S.profile.fastStart = from || Date.now(); saveProfile(); render(); buzz(); }
function endFast() {
  const p = S.profile; if (!p.fastStart) return 0;
  const h = (Date.now() - p.fastStart) / 36e5;
  if (h > 0.5) p.fasts = [...(p.fasts || []), { start: p.fastStart, end: Date.now() }].slice(-60);
  p.fastStart = null; saveProfile(); return h;
}
function maybeEndFast(meal) {
  if (!S.profile.fasting.on || !S.profile.fastStart || S.day.date !== todayISO()) return false;
  if (new Date(meal.time) < S.profile.fastStart) return false;
  endFast(); return true;
}
function fastCard() {
  const p = S.profile; if (!p.fasting.on || S.date !== todayISO()) return '';
  const H = p.fasting.hours, label = `Ayuno ${H}:${24 - H}`;
  if (p.fastStart) {
    const el = (Date.now() - p.fastStart) / 36e5, done = el >= H;
    return `<section class="card"><h2>${label} <b id="fastTime">${hm(el)}</b></h2>
      <div class="track"><i id="fastBar" style="width:${clamp(el / H * 100, 0, 100)}%;background:var(--good)"></i></div>
      <p class="tip">${done ? '<strong>Objetivo cumplido.</strong> Puedes comer cuando quieras: al apuntar la comida se cierra solo.' : `Termina a las <strong>${hhmm(p.fastStart + H * 36e5)}</strong>. Agua, café solo e infusiones no lo rompen.`}</p>
      <div class="row"><button class="btn sm soft" data-act="fastend">Romper ayuno</button></div></section>`;
  }
  const last = S.day.meals.map(m => +new Date(m.time)).filter(Boolean).sort().at(-1);
  const ok = (p.fasts || []).slice(-7).filter(f => (f.end - f.start) / 36e5 >= H - 0.25).length;
  return `<section class="card"><h2>${label} <b>ventana abierta</b></h2>
    <p class="tip">Cuando termines la última comida, empieza el ayuno.${ok ? ` Has cumplido <strong>${ok} de tus últimos ${Math.min(7, p.fasts.length)}</strong> ayunos.` : ''}</p>
    <div class="row"><button class="btn sm solid" data-act="faststart">Empezar ahora</button>${last ? `<button class="btn sm soft" data-act="faststart" data-from="${last}">Desde la última comida (${hhmm(last)})</button>` : ''}</div></section>`;
}
setInterval(() => {
  const p = S.profile, el = $('#fastTime'); if (!el || !p?.fastStart) return;
  const h = (Date.now() - p.fastStart) / 36e5; el.textContent = hm(h);
  const bar = $('#fastBar'); if (bar) bar.style.width = clamp(h / p.fasting.hours * 100, 0, 100) + '%';
}, 30000);

/* ---------- rendering ---------- */
function render() {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const h = S.profile.history[todayISO()];
  const st = streak();
  $('#pills').innerHTML = (st ? `<span class="pill hot" title="Días seguidos registrando">Racha ${st} ${st === 1 ? 'día' : 'días'}</span>` : '') +
    (h?.score != null ? `<span class="pill" title="Puntuación de hoy">${h.score}/100</span>` : '');
  const v = { hoy: viewToday, progreso: viewProgress, coach: viewCoach, perfil: viewProfile }[S.tab];
  $('#main').innerHTML = v();
  if (S.tab === 'progreso') fillPhotos();
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
const thumbOf = m => m.thumb ? `<img class="thumb" src="${m.thumb}" alt="">` : `<div class="thumb">${esc((m.name || '?')[0].toUpperCase())}</div>`;

function viewToday() {
  const d = S.day, t = dayTargets(), tot = totals(d), p = S.profile;
  const left = t.kcal - tot.kcal, over = left < 0;
  const pLeft = Math.max(0, t.p - tot.p);
  const glasses = Math.ceil(t.water / 250), filled = Math.floor(d.water / 250);
  let drops = '';
  for (let i = 0; i < Math.max(glasses, filled); i++) drops += `<button class="drop ${i < filled ? 'on' : ''}" data-act="water" data-ml="${(i + 1) * 250}" aria-label="${(i + 1) * 250} ml"></button>`;
  const stepChips = [[3000, 'Tranquilo'], [7000, 'Normal'], [12000, 'Caminé mucho'], [18000, 'Muchísimo']]
    .map(([n, l]) => `<button class="chip ${d.steps === n ? 'on' : ''}" data-act="steps" data-n="${n}">${l} · ${n / 1000}k</button>`).join('');
  let hint;
  if (t.outToday && !d.meals.length) hint = `Hoy comes fuera: tienes <strong>${fmt(t.kcal)} kcal</strong>, ${fmt(p.outBonus)} más de lo normal. Desayuno ligero y con proteína, y disfruta.`;
  else if (!d.meals.length) hint = `Toca la cámara para apuntar lo que comes. Hoy tienes <strong>${fmt(t.kcal)} kcal</strong> y <strong>${t.p} g de proteína</strong>.`;
  else if (over) hint = `Te has pasado <strong>${fmt(-left)} kcal</strong>. ${p.weekly ? 'Lo reparto entre los próximos días de la semana, sin dramas.' : 'Un día no rompe la semana.'}`;
  else if (pLeft > 25) hint = `Te faltan <strong>${R(pLeft)} g de proteína</strong> en <strong>${fmt(left)} kcal</strong>. Mira el Coach para ideas concretas.`;
  else hint = `Vas muy bien. Quedan <strong>${fmt(left)} kcal</strong> y la proteína está casi cubierta.`;
  const why = [t.eatBack ? `${signed(t.eatBack)} por caminar` : '', t.outShare ? `${signed(t.outShare)} ${t.outToday ? 'por comer fuera' : 'para tu día fuera'}` : '', t.adj ? `${signed(t.adj)} ${t.adj > 0 ? 'ahorradas esta semana' : 'por lo que te pasaste'}` : '']
    .filter(Boolean).map(s => `<span class="pill">${s}</span>`).join('');
  const wk = t.week ? (() => { const used = t.week.eaten + tot.kcal; return `<div class="weekline"><div class="row" style="justify-content:space-between"><span>Semana</span><b>${fmt(used)} / ${fmt(t.week.budget)} kcal</b></div><div class="track"><i style="width:${clamp(used / t.week.budget * 100, 0, 100)}%;background:var(--ink)"></i></div></div>`; })() : '';

  const pend = getPending();
  const setup = !hasAI() ? `<section class="card"><h2>Primer paso</h2><p class="tip">Activa la IA gratis de Gemini (2 minutos): haces la foto y las calorías salen aquí mismo.</p><button class="btn solid" data-act="tab" data-tab="perfil">Activar IA</button></section>` : '';
  const waiting = pend ? `<section class="card"><h2>Esperando a ChatGPT</h2><div class="row" style="flex-wrap:nowrap">${pend.thumb ? `<img class="thumb" src="${pend.thumb}" alt="">` : ''}<p class="tip" style="flex:1">Cuando ChatGPT responda, toca <strong>Añadir a Mordisco</strong> en su mensaje, o pega aquí su respuesta.</p></div><div class="row"><button class="btn sm solid" data-act="paste">Pegar respuesta</button><button class="btn sm soft" data-act="resend">Enviar otra vez</button><button class="btn sm ghost" data-act="droppending">Descartar</button></div></section>` : '';
  const planned = planMealsFor(d.date);
  const planCard = planned.length ? `<section class="card"><h2>Plan de hoy <b>${fmt(planned.reduce((a, m) => a + m.kcal, 0))} kcal</b></h2>
    ${planned.map(m => `<div class="planrow ${m.done ? 'done' : ''}"><div><div class="nm">${esc(m.name)}</div><div class="sub">${slotName(m.slot)} · ${fmt(m.kcal)} kcal · P ${m.p}</div></div>
      ${m.done ? '<span class="pill">Hecho</span>' : `<button class="btn sm solid" data-act="planate" data-i="${m.i}">Comido</button>`}</div>`).join('')}
    <p class="note">¿Comiste otra cosa? Apúntala normal y ignora esta.</p></section>` : '';

  const slots = SLOTS.map(([k, name]) => {
    const ms = d.meals.filter(m => m.slot === k);
    const kc = ms.reduce((a, m) => a + mealKcal(m), 0);
    const quick = (p.recent || []).map((r, i) => ({ r, i })).filter(x => x.r.slot === k && !ms.some(m => m.name === x.r.name))
      .sort((a, b) => (b.r.n || 1) - (a.r.n || 1) || (b.r.last || 0) - (a.r.last || 0)).slice(0, 3);
    return `<div class="slot"><div class="slot-h"><h3>${name}</h3><span>${ms.length ? fmt(kc) + ' kcal' : ''}</span></div>
      ${ms.map(m => `<button class="meal" data-act="edit" data-id="${m.id}">${thumbOf(m)}
        <div><div class="nm">${esc(m.name)}</div><div class="sub">P ${R(mealP(m))} · C ${R(m.items.reduce((a, i) => a + num(i.c), 0))} · G ${R(m.items.reduce((a, i) => a + num(i.f), 0))}</div></div>
        <div class="kc">${fmt(mealKcal(m))}</div></button>`).join('')}
      ${quick.length ? `<div class="quick">${quick.map(x => `<button class="chip qk" data-act="quick" data-i="${x.i}" data-slot="${k}">+ ${esc(x.r.name)} · ${fmt(mealKcal(x.r))}</button>`).join('')}</div>` : ''}
      <button class="addline" data-act="add" data-slot="${k}">+ Añadir a ${name.toLowerCase()}</button></div>`;
  }).join('');

  return `${setup}${waiting}
  <div class="datenav"><button class="iconbtn" data-act="day" data-n="-1" aria-label="Día anterior">‹</button><h1>${dateLabel(d.date)}</h1><button class="iconbtn" data-act="day" data-n="1" aria-label="Día siguiente" ${d.date >= todayISO() ? 'disabled' : ''}>›</button></div>
  <section class="card">
    <div class="hero">
      <div class="ring">${ring(tot.kcal, t.kcal)}<div class="mid"><div class="big" style="${over ? 'color:var(--bad)' : ''}">${fmt(Math.abs(left))}</div><small>${over ? 'kcal de más' : 'kcal restantes'}</small></div></div>
      <div class="eq">
        <div><span>Objetivo de hoy</span><b>${fmt(t.kcal)}</b></div>
        <div><span>− Comido</span><b>${fmt(tot.kcal)}</b></div>
        <div class="tot"><span>${over ? 'Exceso' : 'Te quedan'}</span><b>${fmt(Math.abs(left))}</b></div>
      </div>
    </div>
    ${why ? `<div class="micro">${why}</div>` : ''}
    ${wk}
    <div class="bars">${bar('Proteína', tot.p, t.p, 'var(--prot)')}${bar('Carbohidratos', tot.c, t.c, 'var(--carb)')}${bar('Grasa', tot.f, t.f, 'var(--fat)')}</div>
    <div class="micro">
      <span class="pill">Fibra <b>${R(tot.fib)}/${t.fib} g</b></span>
      <span class="pill" style="${tot.sug > t.sug ? 'color:var(--bad)' : ''}">Azúcar <b>${R(tot.sug)}/${t.sug} g</b></span>
      <span class="pill" style="${tot.na > t.na ? 'color:var(--bad)' : ''}">Sodio <b>${fmt(tot.na)}/${fmt(t.na)} mg</b></span>
    </div>
    <p class="tip">${hint}</p>
  </section>
  ${fastCard()}${planCard}
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
      <div class="field"><label for="exIn">Otro ejercicio (kcal)</label><input id="exIn" type="number" inputmode="numeric" min="0" max="3000" value="${d.exKcal || ''}" placeholder="bici, natación…"></div>
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
  const rx = realExpenditure();
  const tdeeCard = rx.ready ? `
    <div class="kv"><span>Gasto real (últimas 4 semanas)</span><b>${fmt(rx.tdee)} kcal/día</b></div>
    <div class="kv"><span>Lo que estimaba la fórmula</span><b>${fmt(rx.modeled)} kcal/día</b></div>
    <div class="kv"><span>Comiste de media</span><b>${fmt(rx.intake)} kcal · ${rx.days} días</b></div>
    <p class="note">Calculado con lo que apuntas y cómo cambia tu peso. Solo es fiable si apuntas casi todo lo que comes.</p>
    ${Math.abs(rx.tdee - rx.modeled - (p.calib || 0)) >= 80 ? `<button class="btn soft" data-act="calib" data-v="${rx.tdee - rx.modeled}">Ajustar mis objetivos a mi gasto real (${signed(rx.tdee - rx.modeled)} kcal)</button>` : '<p class="tip">Tus objetivos ya cuadran con tu gasto real.</p>'}`
    : `<p class="tip">Cuando lleves <strong>10 días apuntando</strong> y <strong>2 pesajes separados al menos 10 días</strong>, calculo cuánto gastas de verdad y ajusto tus objetivos. Ninguna app de las grandes lo hace bien.</p>
    <p class="note">${rx.needDays ? `Faltan ${rx.needDays} días apuntados. ` : ''}${rx.span < 10 ? 'Falta un pesaje más separado en el tiempo.' : ''}</p>`;
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
  <section class="card"><h2>Tu gasto real</h2>${tdeeCard}</section>
  <section class="card">
    <h2>Últimos 7 días</h2>
    <div class="chart">${kcalBars(last7)}</div>
    <div class="stats">
      <div class="stat"><b>${logged.length ? fmt(avgK) : '—'}</b><span>kcal media</span></div>
      <div class="stat"><b>${logged.length ? R(avgP) + ' g' : '—'}</b><span>proteína media</span></div>
      <div class="stat"><b>${avgS.length ? R(avgS.reduce((a, x) => a + x.h.score, 0) / avgS.length) : '—'}</b><span>puntuación</span></div>
    </div>
  </section>
  <section class="card">
    <h2>Fotos de progreso</h2>
    <div id="photos"><p class="note">Cargando…</p></div>
    <button class="btn soft" data-act="bodyphoto">Añadir foto</button>
    <p class="note">Se guardan solo en este móvil. Hazlas con la misma luz, ropa y postura, una vez cada 2-4 semanas: verás cambios que la báscula no enseña.</p>
  </section>`;
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
async function fillPhotos() {
  const box = $('#photos'); if (!box) return;
  let list = [];
  try { list = await PhotoDB.all(); } catch { box.innerHTML = '<p class="note">Este navegador no deja guardar fotos.</p>'; return; }
  S.photos.forEach(ph => URL.revokeObjectURL(ph.url));
  S.photos = list.sort((a, b) => a.date < b.date ? -1 : 1).map(r => ({ ...r, url: URL.createObjectURL(r.blob) }));
  if (!$('#photos')) return;
  $('#photos').innerHTML = S.photos.length
    ? `<div class="photos">${S.photos.map(ph => `<button class="ph" data-act="photo" data-id="${ph.id}"><img src="${ph.url}" alt="Foto del ${ph.date}"><span>${new Date(ph.date + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</span></button>`).join('')}</div>`
    : '<div class="empty"><strong>Tu primera foto</strong>De frente y de lado, con buena luz.</div>';
}
async function shrinkImage(file, max = 1280) {
  const bmp = await createImageBitmap(file), r = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = R(bmp.width * r); c.height = R(bmp.height * r);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
}
function openPhoto(id) {
  const ph = S.photos.find(x => x.id === id); if (!ph) return;
  const first = S.photos[0], lab = d => new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  const days = R((new Date(ph.date) - new Date(first.date)) / 864e5);
  S.draft = { status: 'photo-view', id, confirmDel: false };
  openSheet(`<h2>${lab(ph.date)}</h2>
    ${first.id !== ph.id ? `<div class="cmp"><figure><img src="${first.url}" alt=""><figcaption>${lab(first.date)}</figcaption></figure><figure><img src="${ph.url}" alt=""><figcaption>${days} días después</figcaption></figure></div>` : `<img class="photo" style="aspect-ratio:auto" src="${ph.url}" alt="">`}
    <button class="btn danger" data-act="delphoto">${'Borrar foto'}</button>
    <button class="btn ghost" data-act="close">Cerrar</button>`);
}

/* coach: the app's own advice, plus one-tap questions and weekly plans through ChatGPT */
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
  const d = S.day, t = dayTargets(), tot = totals(d), p = S.profile;
  const kLeft = t.kcal - tot.kcal, pLeft = t.p - tot.p, wLeft = t.water - d.water, hour = new Date().getHours();
  const tips = [];
  if (!d.meals.length) tips.push(`Aún no has apuntado nada. Hoy tienes <strong>${fmt(t.kcal)} kcal</strong> y <strong>${t.p} g de proteína</strong>. Intenta meter 30-40 g de proteína en cada comida.`);
  else if (kLeft < 0) tips.push(`Te has pasado <strong>${fmt(-kLeft)} kcal</strong>. ${p.weekly ? 'Lo reparto solo entre los días que quedan de la semana.' : 'Mañana come un poco menos o camina 6.000 pasos extra.'}`);
  else tips.push(`Te quedan <strong>${fmt(kLeft)} kcal</strong> y <strong>${R(Math.max(0, pLeft))} g de proteína</strong>.`);
  if (t.week && t.week.saved > 150) tips.push(`Llevas <strong>${fmt(t.week.saved)} kcal ahorradas</strong> esta semana: tienes margen para el finde.`);
  if (t.outToday) tips.push(`Hoy es tu día de comer fuera. En pizzería, una margherita entera son unas 850 kcal: con ensalada y sin postre encaja.`);
  if (pLeft > 15 && kLeft > 80) {
    const opts = FOODS.filter(f => f[1] <= kLeft).sort((a, b) => b[2] / b[1] - a[2] / a[1]).slice(0, 4);
    if (opts.length) tips.push(`Para cubrir proteína sin pasarte:<ul>${opts.map(f => `<li>${f[0]}: ${f[1]} kcal, ${f[2]} g proteína</li>`).join('')}</ul>`);
  }
  if (tot.fib < t.fib * 0.5 && hour >= 14) tips.push(`Vas corto de fibra (${R(tot.fib)}/${t.fib} g). Añade verdura a la próxima comida o una pieza de fruta: llena mucho con pocas calorías.`);
  if (wLeft > 500) tips.push(`Te faltan <strong>${(wLeft / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} L de agua</strong>. Deja una botella a la vista.`);
  if (d.steps < 7000 && hour < 21) tips.push(`Un paseo de 30 minutos son unos 3.500 pasos y te sube el objetivo de hoy unas 100 kcal.`);
  const st = streak();
  if (st >= 3) tips.push(`Llevas <strong>${st} días seguidos</strong> apuntando. Eso es lo que más predice que bajes de peso.`);
  return tips.map(t => `<div class="tip">${t}</div>`).join('');
}
function weekReport() {
  const p = S.profile, ws = weekStart(todayISO()), prev = addDays(ws, -7);
  const days = []; for (let i = 0; i < 7; i++) { const d = addDays(prev, i); if (p.history[d]?.kcal > 0) days.push(p.history[d]); }
  if (days.length < 3) return '';
  const avgK = days.reduce((a, h) => a + h.kcal, 0) / days.length, avgG = days.reduce((a, h) => a + h.goal, 0) / days.length;
  const pHit = days.filter(h => h.p >= h.pgoal * 0.9).length;
  return `<section class="card"><h2>Tu semana pasada</h2>
    <div class="kv"><span>Días apuntados</span><b>${days.length} de 7</b></div>
    <div class="kv"><span>Media de calorías</span><b>${fmt(avgK)} / ${fmt(avgG)} kcal</b></div>
    <div class="kv"><span>Días con la proteína hecha</span><b>${pHit} de ${days.length}</b></div>
    <p class="tip">${avgK <= avgG * 1.03 ? 'Semana en objetivo. Así es como se pierde grasa: sin hacer nada heroico, repitiendo.' : `Te pasaste de media ${fmt(avgK - avgG)} kcal al día. Mira qué día se disparó y planifícalo mejor esta semana.`}${pHit < days.length / 2 ? ' La proteína es lo que más puedes mejorar: añade un yogur griego o una lata de atún al día.' : ''}</p></section>`;
}
function contextBlock() {
  const p = S.profile, t = dayTargets(), tot = totals(S.day);
  const week = []; for (let i = 7; i >= 1; i--) { const k = addDays(S.date, -i); const h = p.history[k]; if (h) week.push(`${k}: ${h.kcal} kcal, ${h.p} g prot`); }
  return `Mis datos: ${p.sex === 'f' ? 'mujer' : 'hombre'}, ${p.age} años, ${p.height} cm, ${p.weight} kg, objetivo ${p.goal} kg a ${p.pace} kg/semana. Vivo en Italia, cocino yo, sin báscula de cocina. Camino; de momento no hago pesas.
Objetivo de hoy: ${t.kcal} kcal, ${t.p} g proteína, ${t.c} g carbos, ${t.f} g grasa, ${t.fib} g fibra.
Llevo hoy (${hhmm(Date.now())}): ${R(tot.kcal)} kcal, ${R(tot.p)} g proteína, ${R(tot.c)} g carbos, ${R(tot.f)} g grasa, ${R(tot.fib)} g fibra, ${S.day.water} ml de agua, ${S.day.steps} pasos.
Comidas de hoy: ${S.day.meals.map(m => `${slotName(m.slot)}: ${m.name} (${R(mealKcal(m))} kcal, ${R(mealP(m))} g prot)`).join('; ') || 'ninguna'}.
Últimos días: ${week.join('; ') || 'sin datos'}.
Pesos recientes: ${p.weights.slice(-6).map(w => `${w.date} ${w.kg} kg`).join(', ')}.`;
}
function viewCoach() {
  const pl = S.profile.plan;
  const planCard = pl ? (() => {
    const mon = new Date(pl.week + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
    const doneN = pl.meals.filter(m => m.done).length, shopLeft = pl.shop.filter(s => !s.done).length;
    return `<section class="card"><h2>Plan semanal <b>desde el ${mon}</b></h2>
      <div class="kv"><span>Comidas hechas</span><b>${doneN} de ${pl.meals.length}</b></div>
      <div class="row"><button class="btn sm soft" data-act="viewplan">Ver plan completo</button><button class="btn sm ghost" data-act="newplan">Pedir otro</button></div>
      ${pl.shop.length ? `<h2 style="margin-top:6px">Lista de la compra <b>${shopLeft ? shopLeft + ' por comprar' : 'todo comprado'}</b></h2>
      <div class="checks">${pl.shop.map((s, i) => `<label class="check ${s.done ? 'done' : ''}"><input type="checkbox" data-shop="${i}" ${s.done ? 'checked' : ''}><span>${esc(s.t)}</span></label>`).join('')}</div>` : ''}
    </section>`;
  })() : `<section class="card"><h2>Plan semanal y compra</h2>
      <p class="tip">${hasAI() ? 'Gemini' : 'ChatGPT'} te hace un menú de 7 días con tus calorías y proteína, recetas de 20 minutos, tu día de comer fuera${S.profile.fasting.on ? ', tu ventana de ayuno' : ''} y la lista de la compra para el súper. Cada comida se apunta con un toque.</p>
      <button class="btn solid block" data-act="newplan">Hacer mi plan</button>
      ${hasAI() ? '<button class="btn sm ghost" data-act="planGPT">Pedírselo a ChatGPT</button>' : ''}
      <button class="btn sm ghost" data-act="paste">Pegar plan de ChatGPT</button></section>`;
  const ai = hasAI();
  return `
  <section class="card"><h2>Tu día</h2>${coachTips()}</section>
  ${planCard}
  ${weekReport()}
  <section class="card">
    <h2>Pregúntame</h2>
    <p class="tip">Le paso tus números de hoy y de la semana a ${ai ? 'Gemini' : 'ChatGPT'} junto a tu pregunta, para que te conteste con datos reales.</p>
    <div class="field"><label for="qIn">Tu pregunta</label><textarea id="qIn" placeholder="¿Qué ceno con lo que me queda? ¿Qué pido en el McDonald's?"></textarea></div>
    <button class="btn solid block" data-act="ask">Preguntar</button>
    ${ai ? '<button class="btn sm ghost" data-act="askGPT">Preguntar a ChatGPT</button>' : ''}
  </section>
  <section class="card" id="coachCard" ${S.coachText ? '' : 'hidden'}><h2>Respuesta</h2><div class="coach" id="coachOut">${mdLite(S.coachText)}</div></section>`;
}
function viewPlanSheet() {
  const pl = S.profile.plan; if (!pl) return;
  S.draft = { status: 'plan-view' };
  let html = '<h2>Tu plan</h2>';
  for (let d = 1; d <= 7; d++) {
    const ms = pl.meals.map((m, i) => ({ ...m, i })).filter(m => m.d === d); if (!ms.length) continue;
    const date = addDays(pl.week, d - 1);
    html += `<div class="slot"><div class="slot-h"><h3 style="text-transform:capitalize">${DAYS[d - 1]} ${new Date(date + 'T12:00:00').getDate()}</h3><span>${fmt(ms.reduce((a, m) => a + m.kcal, 0))} kcal</span></div>
      ${ms.map(m => `<div class="planrow ${m.done ? 'done' : ''}"><div><div class="nm">${esc(m.name)}</div><div class="sub">${slotName(m.slot)} · ${fmt(m.kcal)} kcal · P ${m.p} · C ${m.c} · G ${m.f}</div>${m.recipe ? `<div class="recipe">${esc(m.recipe)}</div>` : ''}</div></div>`).join('')}</div>`;
  }
  openSheet(html + '<button class="btn ghost" data-act="close">Cerrar</button>');
}

/* profile */
function viewProfile() {
  const p = S.profile, t = targets(p, null);
  const sel = (id, opts, v) => `<select id="${id}">${opts.map(([val, l]) => `<option value="${val}" ${String(val) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return `
  <section class="card">
    <h2>IA de las fotos <b>${hasAI() ? 'Gemini activo' : 'sin activar'}</b></h2>
    <p class="tip">Con Gemini haces la foto y el resultado sale aquí mismo, gratis. Para activarlo:</p>
    <ol class="steps">
      <li>Entra en <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> con tu cuenta de Google.</li>
      <li>Toca <strong>Create API key</strong> (Crear clave) y cópiala.</li>
      <li>Pégala aquí y guarda. Se queda solo en este móvil.</li>
    </ol>
    <div class="field"><label for="pGem">Clave de Gemini</label><input id="pGem" type="password" autocomplete="off" value="${esc(p.geminiKey)}" placeholder="Pega aquí tu clave"></div>
    <div class="field"><label for="pMode">Modo</label><select id="pMode"><option value="1" ${p.aiPrecise ? 'selected' : ''}>Preciso: el mejor modelo disponible, piensa más y te pregunta dudas</option><option value="0" ${p.aiPrecise ? '' : 'selected'}>Rápido: respuesta en pocos segundos</option></select></div>
    <div class="row"><button class="btn solid" data-act="savegem">Guardar</button>${hasAI() ? '<button class="btn soft" data-act="testgem">Probar</button>' : ''}</div>
    <p class="note" id="gemStatus">${S.lastModel ? 'Último modelo usado: ' + esc(S.lastModel) + '.' : ''} En la versión gratis Google puede usar lo que envías para mejorar sus modelos. ChatGPT sigue disponible como respaldo.</p>
  </section>
  <section class="card">
    <h2>ChatGPT (respaldo)</h2>
    <ol class="steps">
      <li>En ChatGPT (mejor desde el ordenador): <strong>Explorar GPT → Crear</strong> → pestaña <strong>Configurar</strong>.</li>
      <li>Nombre: <strong>Mordisco</strong>. En <strong>Instrucciones</strong> pega lo que copia este botón:</li>
    </ol>
    <button class="btn soft" data-act="copygpt">Copiar instrucciones</button>
    <ol class="steps" start="3">
      <li>Guarda el GPT solo para ti y copia su enlace (empieza por chatgpt.com/g/…).</li>
      <li>Pégalo aquí para que los botones de ChatGPT lo abran directo:</li>
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
      <div class="field" style="grid-column:1/-1"><label for="pProt">Proteína</label>${sel('pProt', [[1.6, '1,6 g por kg'], [1.8, '1,8 g por kg (recomendado)'], [2.0, '2,0 g por kg'], [2.2, '2,2 g por kg (si entrenas fuerza)']], p.proteinPerKg)}</div>
    </div>
    <h2 style="margin-top:6px">Flexibilidad</h2>
    <div class="grid2">
      <div class="field"><label for="pWeekly">Calorías</label>${sel('pWeekly', [['1', 'Presupuesto semanal'], ['0', 'Objetivo diario fijo']], p.weekly ? '1' : '0')}</div>
      <div class="field"><label for="pOut">Día que comes fuera</label>${sel('pOut', [[-1, 'Ninguno'], ...DAYS.map((d, i) => [i, d[0].toUpperCase() + d.slice(1)])], p.outDay)}</div>
      <div class="field"><label for="pBonus">Extra ese día</label>${sel('pBonus', [[250, '+250 kcal'], [400, '+400 kcal'], [600, '+600 kcal'], [800, '+800 kcal']], p.outBonus)}</div>
      <div class="field"><label for="pFast">Ayuno intermitente</label>${sel('pFast', [[0, 'No'], [14, '14:10'], [16, '16:8'], [18, '18:6'], [20, '20:4']], p.fasting.on ? p.fasting.hours : 0)}</div>
    </div>
    <p class="note">Con el presupuesto semanal, si un día comes de más lo reparto entre los días que quedan (máximo 300 kcal al día), y si comes de menos te lo guardo para el finde. El extra del día fuera sale de los otros seis días.</p>
    <button class="btn solid block" data-act="saveprofile">Guardar y recalcular</button>
  </section>
  <section class="card">
    <h2>Cómo calculo tu día</h2>
    <div class="kv"><span>Metabolismo basal (Mifflin-St Jeor)</span><b>${fmt(t.bmr)} kcal</b></div>
    <div class="kv"><span>Gasto en un día sentado</span><b>${fmt(t.base)} kcal</b></div>
    ${p.calib ? `<div class="kv"><span>Corrección por tu gasto real</span><b>${signed(p.calib)} kcal <button class="btn sm ghost" data-act="calib" data-v="0">Quitar</button></b></div>` : ''}
    <div class="kv"><span>Déficit para −${p.pace.toLocaleString('es-ES')} kg/semana</span><b>−${fmt(t.deficit)} kcal</b></div>
    <div class="kv"><span>Objetivo base</span><b>${fmt(t.kcal)} kcal</b></div>
    <div class="kv"><span>Proteína · Carbos · Grasa</span><b>${t.p} · ${t.c} · ${t.f} g</b></div>
    <div class="kv"><span>Agua</span><b>${(t.water / 1000).toLocaleString('es-ES')} L + extra si caminas</b></div>
    <p class="note">Los días que caminas más, el objetivo sube solo según tus pasos. Proteína alta para que lo que pierdas sea grasa y no músculo. Con 4 semanas de datos, en Progreso te digo tu gasto real y lo ajusto.</p>
  </section>
  <section class="card">
    <h2>Copia de seguridad</h2>
    <p class="tip">Tus datos se guardan solo en este móvil. Exporta una copia de vez en cuando por si cambias de teléfono o borras el navegador. Las fotos de progreso no van en la copia.</p>
    <div class="row"><button class="btn soft" data-act="export">Exportar copia</button><button class="btn soft" data-act="import">Importar copia</button></div>
    <input type="file" id="impIn" accept="application/json,.json" hidden>
  </section>`;
}

/* ---------- sheet (add / review / edit) ---------- */
function openSheet(html) { $('#sheet').innerHTML = `<div class="grab"></div><div class="in">${html}</div>`; $('#sheetWrap').hidden = false; }
function closeSheet() { if (S.draft?.url) URL.revokeObjectURL(S.draft.url); S.draft = null; $('#sheetWrap').hidden = true; }

function openAdd(slot) {
  S.slotFor = slot;
  const recent = [...(S.profile.recent || [])].map((r, i) => ({ r, i })).sort((a, b) => (b.r.last || 0) - (a.r.last || 0)).slice(0, 8);
  openSheet(`<h2>Añadir a ${slotName(slot).toLowerCase()}</h2>
    <div class="opts">
      <button class="opt main" data-act="cam"><b>Hacer foto</b><span>Se la mandas a ChatGPT y la comida vuelve aquí con un toque</span></button>
      <button class="opt" data-act="gal"><b>De la galería</b><span>Una foto que ya tengas</span></button>
      <button class="opt" data-act="describe"><b>Describir</b><span>"Un McMenu Big Mac con Coca Zero"</span></button>
      <button class="opt" data-act="paste"><b>Pegar de ChatGPT</b><span>Su respuesta con el código</span></button>
      <button class="opt" data-act="manual"><b>A mano</b><span>Si sabes las kcal (etiqueta)</span></button>
    </div>
    ${recent.length ? `<h2 style="font-size:17px">Repetir</h2><div class="recent">${recent.map(({ r, i }) => `<button class="meal" data-act="repeat" data-i="${i}">${thumbOf(r)}<div><div class="nm">${esc(r.name)}</div><div class="sub">P ${R(mealP(r))} g${r.n > 1 ? ` · ${r.n} veces` : ''}</div></div><div class="kc">${fmt(mealKcal(r))}</div></button>`).join('')}</div>` : ''}
    <button class="btn ghost" data-act="close">Cancelar</button>`);
}
async function onPhoto(file) {
  if (!file) return;
  const slot = S.slotFor || autoSlot();
  const dr = { slot, file, url: URL.createObjectURL(file), thumb: null, status: hasAI() ? 'loading' : 'photo' };
  S.draft = dr; renderDraft();
  dr.thumb = await makeThumb(file);
  setPending({ at: Date.now(), slot, thumb: dr.thumb, date: S.date });
  if (hasAI() && S.draft === dr) analyzeAI();
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
  if (dr.status === 'loading') {
    body = `${img}<div class="loading"><div class="spin"></div><b id="loadMsg">${LOAD_MSGS[0]}</b><span class="note">${S.profile.aiPrecise ? 'Modo preciso: suele tardar 10-30 segundos.' : 'Unos segundos…'}</span><button class="btn sm ghost" data-act="stopai">Cancelar</button></div>`;
    let i = 0; clearInterval(renderDraft.iv);
    renderDraft.iv = setInterval(() => { const el = $('#loadMsg'); if (!el || S.draft?.status !== 'loading') return clearInterval(renderDraft.iv); el.textContent = LOAD_MSGS[++i % LOAD_MSGS.length]; }, 3500);
  } else if (dr.status === 'error') {
    body = `${img}<div class="err">${esc(dr.error)}</div>
      <div class="row">${hasAI() && (dr.file || dr.text) ? '<button class="btn solid" data-act="retry">Reintentar</button>' : ''}${dr.file ? '<button class="btn soft" data-act="tochatgpt">Usar ChatGPT</button>' : ''}<button class="btn soft" data-act="manual">A mano</button></div>
      <button class="btn ghost" data-act="close">Cerrar</button>`;
  } else if (dr.status === 'photo') {
    body = `${img}
      <div class="field"><label for="dCtx">Contexto opcional</label><input id="dCtx" type="text" placeholder="con aceite, media ración, pasta 100 g en seco…"></div>
      ${hasAI() ? '<button class="btn solid block" data-act="runphoto">Analizar aquí con Gemini</button><button class="btn soft block" data-act="sharephoto">Enviar a ChatGPT</button>' : '<button class="btn solid block" data-act="sharephoto">Enviar a ChatGPT</button><p class="note">Activa Gemini en Perfil para que la foto se analice aquí mismo, gratis.</p>'}
      ${pasteBox}
      <div class="row"><button class="btn ghost" data-act="manual">Añadir a mano</button><button class="btn ghost" data-act="close">Cerrar</button></div>`;
  } else if (dr.status === 'describe') {
    body = `<h2>Describe lo que comes</h2>
      <div class="field"><label for="dText">Cuanto más concreto, mejor</label><textarea id="dText" placeholder="Un plato hondo de pasta al ragù con parmesano y una ensalada con aceite. O: McMenu Big Mac mediano con Coca Zero">${esc(dr.text || '')}</textarea></div>
      ${hasAI() ? '<button class="btn solid block" data-act="runtext">Calcular</button><button class="btn sm ghost" data-act="sharetext">Enviar a ChatGPT</button>' : `<button class="btn solid block" data-act="sharetext">Enviar a ChatGPT</button>${pasteBox}`}
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
      ${dr.questions?.length ? `<div class="qa"><b>Para afinar:</b>${dr.questions.map((q, i) => `<div class="qrow"><span>${esc(q)}</span><span class="row"><button class="chip" data-act="aians" data-i="${i}" data-a="Sí">Sí</button><button class="chip" data-act="aians" data-i="${i}" data-a="No">No</button></span></div>`).join('')}</div>` : ''}
      ${dr.tip ? `<p class="tip"><strong>Consejo:</strong> ${esc(dr.tip)}</p>` : ''}
      ${dr.ai && hasAI() ? `<div class="field"><label for="dFix">¿Algo no cuadra? Díselo</label><textarea id="dFix" placeholder="Sin aceite. La pasta era la mitad. Era pollo, no cerdo."></textarea></div><button class="btn soft" data-act="aifix">Corregir</button>` : ''}
      <p class="note">Si cambias los gramos, recalculo el resto en proporción.${dr.ai ? '' : ' Para corregir con IA, díselo a ChatGPT en la misma conversación y toca su nuevo enlace.'}</p>
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
  const editing = !!dr.editId;
  if (!editing) setPending(null);
  closeSheet();
  if (editing) {
    const ms = S.day.meals, idx = ms.findIndex(m => m.id === meal.id);
    if (idx >= 0) ms[idx] = meal; else ms.push(meal);
    saveDay(); render(); toast(`Actualizado · ${fmt(mealKcal(meal))} kcal`);
  } else addMeal(meal);
}
function exportData() {
  const data = {}; for (const k of Store.keys()) data[k] = Store.get(k);
  if (data.profile) data.profile = { ...data.profile, geminiKey: '' };   // never put the key in a file
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
  const act = a.dataset.act, dr = S.draft, p = S.profile;
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
    case 'undo': { const fn = S.undo; S.undo = null; $('#toast').hidden = true; fn?.(); break; }
    case 'quick': { const r = p.recent[+a.dataset.i]; if (!r) return; addMeal({ id: uid(), slot: a.dataset.slot, time: new Date().toISOString(), name: r.name, thumb: r.thumb, items: structuredClone(r.items), source: r.source }); break; }
    case 'repeat': { const r = p.recent[+a.dataset.i]; S.draft = { slot: S.slotFor || autoSlot(), name: r.name, thumb: r.thumb, items: structuredClone(r.items), status: 'ready', source: r.source, portion: 1 }; renderDraft(); break; }
    case 'sharephoto': sendToGPT(photoPrompt($('#dCtx')?.value.trim() || ''), dr.file); break;
    case 'sharetext': { const t = $('#dText').value.trim(); if (!t) { toast('Escribe qué has comido.'); return; } dr.text = t; setPending(null); sendToGPT(textPrompt(t)); break; }
    case 'runphoto': dr.context = $('#dCtx')?.value.trim() || ''; analyzeAI(); break;
    case 'runtext': { const t = $('#dText').value.trim(); if (!t) { toast('Escribe qué has comido.'); return; } dr.text = t; setPending(null); analyzeAI(); break; }
    case 'retry': analyzeAI(); break;
    case 'stopai': dr?.ctl?.abort(); break;
    case 'tochatgpt': dr.status = 'photo'; renderDraft(); break;
    case 'aians': { const q = dr.questions[+a.dataset.i]; analyzeAI(`${q} → ${a.dataset.a}`); break; }
    case 'aifix': { const f = $('#dFix').value.trim(); if (!f) { toast('Escribe qué hay que corregir.'); return; } analyzeAI(f); break; }
    case 'savegem': {
      p.geminiKey = $('#pGem').value.trim(); p.aiPrecise = $('#pMode').value === '1'; p.aiModels = null;
      saveProfile(); render(); toast(p.geminiKey ? 'Gemini guardado. Toca Probar.' : 'Gemini desactivado'); break;
    }
    case 'testgem': {
      const st = $('#gemStatus'); if (st) st.textContent = 'Probando…';
      gemini([{ text: 'Responde solo con JSON {"ok":true,"kcal":N} donde N son las kcal de una manzana mediana.' }], { precise: false })
        .then(r => { const s = $('#gemStatus'); if (s) s.textContent = `Funciona (${S.lastModel}). Una manzana ≈ ${R(num(r.kcal))} kcal.`; toast('Gemini funciona'); })
        .catch(e => { const s = $('#gemStatus'); if (s) s.textContent = aiError(e) + (S.tried?.length ? ` (probados: ${S.tried.join(', ')}${e.msg ? ' · ' + e.msg.slice(0, 120) : ''})` : ''); });
      break;
    }
    case 'readpaste': receiveAny($('#dPaste').value); break;
    case 'resend': { const pe = getPending(); S.slotFor = pe?.slot; $('#galIn').click(); toast('Elige la foto otra vez'); break; }
    case 'droppending': setPending(null); render(); break;
    case 'portion': dr.portion = +a.dataset.v; renderDraft(); break;
    case 'rmitem': dr.items.splice(+a.dataset.i, 1); if (!dr.items.length) dr.items.push(blankItem()); renderDraft(); break;
    case 'additem': dr.items.push(blankItem()); renderDraft(); break;
    case 'savemeal': saveMeal(); break;
    case 'edit': { const m = S.day.meals.find(x => x.id === a.dataset.id); if (!m) return; S.draft = { ...structuredClone(m), editId: m.id, status: 'ready', portion: 1 }; renderDraft(); break; }
    case 'delmeal': if (!dr.confirmDel) { dr.confirmDel = true; renderDraft(); return; } { const before = JSON.stringify(S.day.meals); S.day.meals = S.day.meals.filter(m => m.id !== dr.editId); saveDay(); closeSheet(); render(); toast('Comida borrada', () => { S.day.meals = JSON.parse(before); saveDay(); render(); }); } break;
    case 'water': { const ml = +a.dataset.ml; S.day.water = S.day.water === ml ? ml - 250 : ml; saveDay(); render(); buzz(); break; }
    case 'wadd': S.day.water = Math.max(0, S.day.water + +a.dataset.ml); saveDay(); render(); buzz(); break;
    case 'steps': S.day.steps = +a.dataset.n; saveDay(); render(); break;
    case 'planate': {
      const m = p.plan?.meals[+a.dataset.i]; if (!m) return;
      m.done = true;
      addMeal({ id: uid(), slot: m.slot, time: new Date().toISOString(), name: m.name, thumb: null, source: 'plan', items: [{ name: m.name, grams: 0, kcal: m.kcal, p: m.p, c: m.c, f: m.f, fib: 0, sug: 0, na: 0 }] });
      break;
    }
    case 'viewplan': viewPlanSheet(); break;
    case 'newplan': if (hasAI()) planAI(); else sendToGPT(planPrompt()); break;
    case 'planGPT': closeSheet(); sendToGPT(planPrompt()); break;
    case 'faststart': startFast(a.dataset.from ? +a.dataset.from : null); toast('Ayuno empezado'); break;
    case 'fastend': { const h = endFast(); render(); toast(`Ayuno de ${hm(h)}`); break; }
    case 'bodyphoto': $('#bodyIn').click(); break;
    case 'photo': openPhoto(a.dataset.id); break;
    case 'delphoto': if (!dr.confirmDel) { dr.confirmDel = true; a.textContent = 'Toca otra vez para borrar'; return; } PhotoDB.del(dr.id).then(() => { closeSheet(); fillPhotos(); toast('Foto borrada'); }); break;
    case 'calib': { const v = +a.dataset.v; p.calib = clamp(R(v / 10) * 10, -600, 600); saveProfile(); updateHistory(); render(); toast(v ? `Objetivos ajustados a tu gasto real (${signed(p.calib)} kcal)` : 'Corrección quitada'); break; }
    case 'weigh': {
      const kg = num($('#wIn').value); if (kg < 35 || kg > 250) { toast('Pon un peso válido en kg.'); return; }
      const d = todayISO(); p.weights = p.weights.filter(w => w.date !== d); p.weights.push({ date: d, kg: +kg.toFixed(1) });
      p.weights.sort((x, y) => x.date < y.date ? -1 : 1); if (p.weights.length > 600) p.weights.shift();
      p.weight = p.weights.at(-1).kg; saveProfile(); render(); toast('Peso guardado · objetivos recalculados'); break;
    }
    case 'saveprofile': {
      p.sex = $('#pSex').value; p.age = clamp(R(num($('#pAge').value, p.age)), 14, 90); p.height = clamp(R(num($('#pH').value, p.height)), 120, 230);
      const w = clamp(num($('#pW').value, p.weight), 35, 250);
      if (w !== p.weight) { const d = todayISO(); p.weights = p.weights.filter(x => x.date !== d); p.weights.push({ date: d, kg: +w.toFixed(1) }); p.weights.sort((x, y) => x.date < y.date ? -1 : 1); }
      p.weight = +w.toFixed(1); p.goal = clamp(num($('#pGoal').value, p.goal), 35, 250); p.pace = num($('#pPace').value, 0.5); p.proteinPerKg = num($('#pProt').value, 1.8);
      p.weekly = $('#pWeekly').value === '1'; p.outDay = R(num($('#pOut').value, -1)); p.outBonus = R(num($('#pBonus').value, 400));
      const fh = R(num($('#pFast').value)); p.fasting = { on: fh > 0, hours: fh || p.fasting.hours }; if (!fh) p.fastStart = null;
      saveProfile(); updateHistory(); render(); toast('Guardado. Objetivo de hoy: ' + fmt(dayTargets().kcal) + ' kcal'); break;
    }
    case 'copygpt': copyText(gptInstructions()).then(ok => toast(ok ? 'Instrucciones copiadas' : 'No se pudo copiar')); break;
    case 'savegpt': {
      const u = $('#pGpt').value.trim();
      if (u && !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(u)) { toast('Pega el enlace de tu GPT (chatgpt.com/g/…).'); return; }
      p.gptUrl = u; p.gptReady = true; saveProfile(); render(); toast('Listo'); break;
    }
    case 'ask': if (hasAI()) { const q = $('#qIn').value.trim(); if (!q) { toast('Escribe tu pregunta.'); return; } askAI(q); break; } // falls through to ChatGPT
    case 'askGPT': { const q = $('#qIn').value.trim(); if (!q) { toast('Escribe tu pregunta.'); return; } sendToGPT(`${contextBlock()}\n\nPregunta: ${q}\n\nContesta en español de España, corto y concreto (máximo 150 palabras), como un buen entrenador personal. Si propones comida, da cantidades a ojo (sin báscula) con kcal y proteína, y productos de supermercado italiano.`); break; }
    case 'export': exportData(); break;
    case 'import': $('#impIn').click(); break;
  }
});
document.addEventListener('change', async e => {
  const el = e.target, dr = S.draft;
  if (el.id === 'camIn' || el.id === 'galIn') { const f = el.files[0]; el.value = ''; onPhoto(f); return; }
  if (el.id === 'impIn') { const f = el.files[0]; el.value = ''; if (f) importData(f); return; }
  if (el.id === 'bodyIn') {
    const f = el.files[0]; el.value = ''; if (!f) return;
    try { const blob = await shrinkImage(f); await PhotoDB.put({ id: uid(), date: todayISO(), blob }); fillPhotos(); toast('Foto guardada'); }
    catch { toast('No he podido guardar la foto.'); }
    return;
  }
  if (el.dataset.shop != null) { const s = S.profile.plan?.shop[+el.dataset.shop]; if (s) { s.done = el.checked; saveProfile(); el.closest('.check').classList.toggle('done', el.checked); } return; }
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
  if (/(add|plan)=/.test(hash)) { receiveAny(hash, true) || toast('Ese enlace no trae datos válidos. Pide a ChatGPT que lo repita.'); return; }
  if (shared && !receiveAny(shared, true)) { S.draft = { slot: autoSlot(), status: 'paste' }; renderDraft(); $('#dPaste').value = shared; toast('No he encontrado el código en lo compartido.'); }
}
window.addEventListener('hashchange', checkIncoming);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (S.date !== todayISO() && S.day.date === addDays(todayISO(), -1) && !S.draft) S.date = todayISO();   // new day while the app slept
  loadState(); if (!S.draft) render();   // also picks up a meal added from a ChatGPT link in another tab
});

/* ---------- boot ---------- */
loadState();
render();
checkIncoming();
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !S.draft) location.reload(); });   // new version installed
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
}
