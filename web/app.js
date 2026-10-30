// Gastos PWA — lógica de la app (vanilla JS, sin dependencias).

// Colores categóricos validados (orden fijo, apto daltonismo en pares adyacentes).
const CONFIG_INICIAL = {
  categorias: [
    { nombre: 'Supermercado', color: '#2a78d6' },
    { nombre: 'Restaurantes', color: '#eb6834' },
    { nombre: 'Combustible', color: '#1baf7a' },
    { nombre: 'Transporte', color: '#eda100' },
    { nombre: 'Servicios', color: '#e87ba4' },
    { nombre: 'Salud', color: '#008300' },
    { nombre: 'Suscripciones', color: '#6250d6' },
    { nombre: 'Hogar', color: '#e34948' },
    { nombre: 'Ocio', color: '#9085e9' },
    { nombre: 'Otros', color: '#8a8f97' },
  ],
  reglas: [
    { patron: 'Stock', categoria: 'Supermercado' },
    { patron: 'Superseis', categoria: 'Supermercado' },
    { patron: 'Biggie', categoria: 'Supermercado' },
    { patron: 'Petrobras', categoria: 'Combustible' },
    { patron: 'Copetrol', categoria: 'Combustible' },
    { patron: 'Bolt', categoria: 'Transporte' },
    { patron: 'Uber', categoria: 'Transporte' },
  ],
  presupuestos: [],
};
const CATEGORIA_DEFECTO = 'Otros';
const COLOR_DEFECTO = '#8a8f97';
const ICONOS = {
  supermercado: '🛒', restaurantes: '🍽️', restaurante: '🍽️', comida: '🍔', delivery: '🛵', cafe: '☕',
  combustible: '⛽', nafta: '⛽', transporte: '🚕', auto: '🚗', servicios: '💡', salud: '💊', farmacia: '💊',
  suscripciones: '📺', hogar: '🏠', casa: '🏠', ocio: '🎉', entretenimiento: '🎬', ropa: '👕', educacion: '📚',
  viajes: '✈️', regalos: '🎁', mascotas: '🐾', deporte: '🏋️', gimnasio: '🏋️', tecnologia: '💻', belleza: '💅',
  impuestos: '🧾', bancos: '🏦', hijos: '🧸', otros: '📦',
};
const SIN_CATEGORIA_TOP = 5; // en la dona: 5 categorías + "Otras"

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 });
const gs = (n) => 'Gs ' + fmt.format(Math.round(n || 0));
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const state = {
  mes: mesActual(),
  vista: 'inicio',
  conexion: { url: '', token: '' },
  todos: [],         // todos los gastos según el servidor (o caché)
  config: structuredClone(CONFIG_INICIAL),
  borrador: null,    // copia editable de config en Ajustes
  cola: [],          // operaciones pendientes de enviar
  online: navigator.onLine,
  sincronizando: false,
  ultimoError: '',
  filtroCat: '',
  busqueda: '',
  recienGuardado: '',
};

// ---------- Almacenamiento local (IndexedDB con respaldo en memoria) ----------

const store = await abrirStore();

async function abrirStore() {
  try {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('gastos-pwa', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('cola', { keyPath: 'qid', autoIncrement: true });
        r.result.createObjectStore('kv');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = (nombre, modo, fn) => new Promise((res, rej) => {
      const t = db.transaction(nombre, modo);
      const req = fn(t.objectStore(nombre));
      t.oncomplete = () => res(req.result);
      t.onerror = () => rej(t.error);
    });
    return {
      get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
      set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
      cola: () => tx('cola', 'readonly', (s) => s.getAll()),
      encolar: (item) => tx('cola', 'readwrite', (s) => s.add(item)),
      desencolar: (qid) => tx('cola', 'readwrite', (s) => s.delete(qid)),
    };
  } catch (err) {
    console.warn('IndexedDB no disponible, se usa memoria', err);
    const kv = new Map();
    let cola = [];
    let n = 0;
    return {
      get: async (k) => kv.get(k),
      set: async (k, v) => { kv.set(k, v); },
      cola: async () => cola.slice(),
      encolar: async (item) => { cola.push({ ...item, qid: ++n }); },
      desencolar: async (qid) => { cola = cola.filter((i) => i.qid !== qid); },
    };
  }
}

// ---------- Utilidades ----------

function mesActual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function moverMes(mes, delta) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function diasDelMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(a, m, 0).getDate();
}
function nombreMes(mes, conAnio = true) {
  const [a, m] = mes.split('-').map(Number);
  const s = new Date(a, m - 1, 1).toLocaleDateString('es-PY', conAnio ? { month: 'long', year: 'numeric' } : { month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function ahoraLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16); // AAAA-MM-DDTHH:mm
}
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function soloDigitos(s) {
  return parseInt(String(s).replace(/\D/g, ''), 10) || 0;
}
function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}
/** 1.250.000 -> "1,3 M"; 85.000 -> "85 mil" */
function corto(n) {
  n = Math.round(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',').replace(',0', '') + ' M';
  if (n >= 1e3) return Math.round(n / 1e3) + ' mil';
  return String(n);
}
/** "STOCK MCAL LOPEZ" -> "Stock Mcal Lopez" (los bancos mandan todo en mayúsculas). */
function nombreBonito(s) {
  s = String(s || '').trim();
  if (!s || s !== s.toUpperCase() || !/[A-ZÁÉÍÓÚÑ]{3}/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s\-/.(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}
function categorizar(comercio, reglas = state.config.reglas) {
  const c = normalizar(comercio);
  if (c) {
    for (const r of reglas) {
      const p = normalizar(r.patron);
      if (p && c.includes(p)) return r.categoria;
    }
  }
  return CATEGORIA_DEFECTO;
}
function colorDe(categoria) {
  return state.config.categorias.find((c) => c.nombre === categoria)?.color || COLOR_DEFECTO;
}
function iconoDe(categoria) {
  return ICONOS[normalizar(categoria)] || '🏷️';
}
function fondoIcono(color) {
  return `background:${color}24;color:${color}`;
}
function el(tag, props = {}, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) e.append(h);
  return e;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...hijos) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  for (const h of hijos.flat()) if (h) e.append(h);
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = true;
  void t.offsetWidth; // reinicia la animación
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
function vibrar(ms = 8) { try { navigator.vibrate?.(ms); } catch { /* sin vibración */ } }

/** Anima un número desde su valor anterior hasta el nuevo. */
function animarNumero(nodo, valor, formato = (n) => fmt.format(Math.round(n))) {
  const desde = Number(nodo.dataset.v || 0);
  nodo.dataset.v = valor;
  if (desde === valor || matchMedia('(prefers-reduced-motion: reduce)').matches) { nodo.textContent = formato(valor); return; }
  const t0 = performance.now();
  const dur = 700;
  const paso = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    nodo.textContent = formato(desde + (valor - desde) * e);
    if (p < 1 && nodo.dataset.v == valor) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

// ---------- Tooltip compartido ----------

const tip = $('#tooltip');
function mostrarTip(x, y, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const w = tip.offsetWidth;
  const xx = Math.max(w / 2 + 8, Math.min(innerWidth - w / 2 - 8, x));
  tip.style.left = xx + 'px';
  tip.style.top = Math.max(tip.offsetHeight + 20, y) + 'px';
}
function ocultarTip() { tip.hidden = true; }
const filaTip = (color, etiqueta, valor, punteada) =>
  `<div class="t-fila"><i style="background:${color};${punteada ? 'opacity:.7' : ''}"></i>${esc(etiqueta)} <b>${valor}</b></div>`;

// ---------- Servidor ----------

const conectado = () => !!(state.conexion.url && state.conexion.token);

async function apiGet(params) {
  const url = new URL(state.conexion.url);
  url.searchParams.set('token', state.conexion.token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { cache: 'no-store' });
  return r.json();
}

async function apiPost(body) {
  // text/plain evita el preflight CORS, que Apps Script no responde.
  const r = await fetch(state.conexion.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, token: state.conexion.token }),
  });
  return r.json();
}

const hayConfigPendiente = () => state.cola.some((i) => i.body.accion === 'config');
const errorDeAcceso = (msg) => /autorizad|TOKEN/i.test(msg || '');

async function cargarDelServidor() {
  if (!conectado() || !state.online) return;
  const r = await apiGet({});
  if (!r.ok) throw new Error(r.error || 'Error del servidor');
  state.todos = r.gastos;
  await store.set('gastos:todos', r.gastos);
  if (!hayConfigPendiente() && r.config?.categorias?.length) {
    state.config = r.config;
    await store.set('config', r.config);
  }
}

let repetirSync = false;

async function sincronizar() {
  if (state.sincronizando) { repetirSync = true; return; } // se vuelve a correr al terminar
  if (!conectado() || !state.online) return render();
  state.sincronizando = true;
  repetirSync = false;
  renderEstado();
  try {
    for (const item of await store.cola()) {
      const r = await apiPost(item.body);
      if (!r.ok) {
        if (errorDeAcceso(r.error)) throw new Error(r.error);
        toast('Descartado: ' + r.error);
      }
      await store.desencolar(item.qid);
    }
    state.cola = await store.cola();
    await cargarDelServidor();
    state.ultimoError = '';
  } catch (err) {
    state.ultimoError = err.message === 'Failed to fetch' || err.name === 'TypeError' ? 'Sin conexión con el servidor' : err.message;
  } finally {
    state.cola = await store.cola();
    state.sincronizando = false;
    render();
    if (repetirSync && !state.ultimoError) sincronizar();
  }
}

async function encolar(body) {
  await store.encolar({ body, creado: Date.now() });
  state.cola = await store.cola();
  render();
  sincronizar();
}

// ---------- Datos derivados ----------

/** Todos los gastos: servidor + cambios pendientes de la cola. */
function gastosTodos() {
  const mapa = new Map(state.todos.map((g) => [g.id, { ...g }]));
  for (const { body } of state.cola) {
    if (body.accion === 'guardar') mapa.set(body.gasto.id, { ...body.gasto, pendiente: true });
    else if (body.accion === 'borrar') mapa.delete(body.id);
  }
  return [...mapa.values()].sort((a, b) => b.fecha.localeCompare(a.fecha));
}
const delMes = (gastos, mes) => gastos.filter((g) => g.fecha.startsWith(mes));
const suma = (gastos) => gastos.reduce((s, g) => s + g.monto, 0);

/** Gasto acumulado por día (índice 0 = día 1). */
function acumulado(gastos, dias) {
  const porDia = new Array(dias).fill(0);
  for (const g of gastos) {
    const d = parseInt(g.fecha.slice(8, 10), 10);
    if (d >= 1 && d <= dias) porDia[d - 1] += g.monto;
  }
  let s = 0;
  return porDia.map((v) => (s += v));
}

/** Días transcurridos del mes elegido (todo el mes si ya pasó). */
function diasTranscurridos(mes) {
  const hoy = mesActual();
  if (mes < hoy) return diasDelMes(mes);
  if (mes > hoy) return 0;
  return new Date().getDate();
}

function totalesPorCategoria(gastos) {
  const tot = new Map();
  for (const g of gastos) {
    const c = g.categoria || CATEGORIA_DEFECTO;
    tot.set(c, (tot.get(c) || 0) + g.monto);
  }
  return [...tot.entries()].map(([categoria, total]) => ({ categoria, total })).sort((a, b) => b.total - a.total);
}

// ---------- Posibles duplicados ----------

const VENTANA_DUP_MIN = 10;
const minutos = (fecha) => {
  const [d, h = '00:00'] = fecha.split(' ');
  const [a, m, dd] = d.split('-').map(Number);
  const [hh, mm] = h.split(':').map(Number);
  return new Date(a, m - 1, dd, hh, mm).getTime() / 60000;
};
const mismoComercio = (a, b) => {
  const x = normalizar(a);
  const y = normalizar(b);
  return !x || !y || x === y || x.includes(y) || y.includes(x);
};
const clavePar = (a, b) => [a.id, b.id].sort().join('|');

function ignoradosDup() {
  try { return new Set(JSON.parse(localStorage.getItem('dupIgnorados') || '[]')); } catch { return new Set(); }
}
function ignorarDup(clave) {
  const s = ignoradosDup();
  s.add(clave);
  localStorageSet('dupIgnorados', JSON.stringify([...s]));
}

/** Pares con el mismo monto y comercio parecido a pocos minutos de diferencia. */
function posiblesDuplicados(gastos) {
  const ignorados = ignoradosDup();
  const orden = [...gastos].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const pares = [];
  for (let i = 0; i < orden.length; i++) {
    for (let j = i + 1; j < orden.length; j++) {
      const a = orden[i];
      const b = orden[j];
      if (minutos(b.fecha) - minutos(a.fecha) > VENTANA_DUP_MIN) break;
      if (a.monto === b.monto && mismoComercio(a.comercio, b.comercio) && !ignorados.has(clavePar(a, b))) pares.push([a, b]);
    }
  }
  return pares;
}

/** Gasto ya registrado que parece el mismo que se está por guardar (para avisar antes). */
function gastoParecido(nuevo) {
  const t = minutos(nuevo.fecha);
  return gastosTodos().find((g) => g.id !== nuevo.id && g.monto === nuevo.monto &&
    Math.abs(minutos(g.fecha) - t) <= VENTANA_DUP_MIN * 1.5 && mismoComercio(g.comercio, nuevo.comercio));
}

const presupuestoDe = (cat) => Number(state.config.presupuestos.find((p) => p.categoria === cat)?.monto) || 0;
const presupuestoTotal = () => state.config.presupuestos.reduce((s, p) => s + (Number(p.monto) || 0), 0);

// ---------- Render general ----------

const TITULOS = { inicio: 'Inicio', movimientos: 'Movimientos', presupuesto: 'Presupuesto', ajustes: 'Ajustes' };

function render() {
  $('#mesLabel').textContent = nombreMes(state.mes);
  $('#mesNext').disabled = state.mes >= mesActual();
  $('#tituloVista').textContent = TITULOS[state.vista];
  $('#selectorMes').hidden = state.vista === 'ajustes';
  for (const b of $$('.tabs button[data-vista]')) b.classList.toggle('activa', b.dataset.vista === state.vista);
  for (const v of Object.keys(TITULOS)) $('#vista-' + v).hidden = v !== state.vista;
  renderEstado();
  if (state.vista === 'inicio') renderInicio();
  if (state.vista === 'movimientos') renderMovimientos();
  if (state.vista === 'presupuesto') renderPresupuesto();
  if (state.vista === 'ajustes') renderAjustes();
}

function saludo() {
  const h = new Date().getHours();
  return h < 12 ? 'Buen día' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
}

function renderEstado() {
  const e = $('#estado');
  const pend = state.cola.length;
  let txt, cls = '';
  if (!conectado()) { txt = 'Sin conectar'; cls = 'error'; }
  else if (state.sincronizando) { txt = 'Sincronizando'; cls = 'sync'; }
  else if (!state.online) { txt = pend ? `Sin conexión · ${pend}` : 'Sin conexión'; cls = 'pendiente'; }
  else if (state.ultimoError) { txt = pend ? `${pend} pendientes` : 'Error'; cls = 'error'; }
  else if (pend) { txt = `${pend} pendientes`; cls = 'pendiente'; }
  else txt = 'Al día';
  e.querySelector('span').textContent = txt;
  e.className = 'estado ' + cls;
  e.title = state.ultimoError;
  $('#saludo').textContent = saludo();
}

function cambiarVista(vista) {
  if (vista === state.vista) return;
  if (state.vista === 'ajustes' && $('#barraGuardar').hidden) state.borrador = null; // sin cambios sin guardar
  state.vista = vista;
  window.scrollTo({ top: 0 });
  render();
  animarEntrada('entra');
}

function animarEntrada(clase) {
  const v = $('#vista-' + state.vista);
  v.classList.remove('entra', 'entra-izq', 'entra-der');
  void v.offsetWidth;
  v.classList.add(clase);
}

// ---------- Inicio ----------

/** Firma de lo que se dibuja: si no cambió, no se re-renderiza (evita repetir animaciones en cada sync). */
const firmas = {};
function sinCambios(vista, ...partes) {
  const f = JSON.stringify(partes);
  if (firmas[vista] === f) return true;
  firmas[vista] = f;
  return false;
}
const firmaDatos = (gastos) => gastos.map((g) => g.id + g.monto + g.categoria + g.fecha + (g.pendiente ? 'p' : '') + g.comercio).join('|');

function renderInicio() {
  const todos = gastosTodos();
  const mes = state.mes;
  const dups = posiblesDuplicados(delMes(todos, mes));
  $('#alertaDup').hidden = !dups.length;
  $('#alertaDupTit').textContent = dups.length === 1 ? '1 posible gasto duplicado' : `${dups.length} posibles gastos duplicados`;
  if (sinCambios('inicio', mes, firmaDatos(todos), state.config, $('#graficoRitmo').clientWidth, new Date().getDate())) return;
  const previo = moverMes(mes, -1);
  const actuales = delMes(todos, mes);
  const anteriores = delMes(todos, previo);
  const dias = diasDelMes(mes);
  const transcurridos = diasTranscurridos(mes);
  const total = suma(actuales);
  const esActual = mes === mesActual();

  // Hero
  $('#heroEtiqueta').textContent = esActual ? 'Gastado este mes' : `Gastado en ${nombreMes(mes, false).toLowerCase()}`;
  animarNumero($('#heroMonto'), total);
  const acumPrev = acumulado(anteriores, diasDelMes(previo));
  const comparable = esActual ? acumPrev[Math.min(transcurridos, acumPrev.length) - 1] || 0 : suma(anteriores);
  const delta = $('#heroDelta');
  if (comparable > 0 && total > 0) {
    const pct = Math.round(((total - comparable) / comparable) * 100);
    const flecha = pct > 0 ? '↑' : pct < 0 ? '↓' : '→';
    delta.textContent = `${flecha} ${Math.abs(pct)}% vs ${MESES_CORTOS[Number(previo.slice(5)) - 1]}`;
    delta.title = esActual ? `Comparado con ${nombreMes(previo, false).toLowerCase()} hasta el día ${transcurridos}` : '';
    delta.hidden = false;
  } else delta.hidden = true;

  const pres = presupuestoTotal();
  const barra = $('#heroBarra');
  $('#heroMarca').hidden = !esActual || !pres;
  if (pres) {
    barra.parentElement.hidden = false;
    requestAnimationFrame(() => { barra.style.width = Math.min(100, (total / pres) * 100) + '%'; });
    barra.classList.toggle('excedido', total > pres);
    $('#heroMarca').style.left = `calc(${(transcurridos / dias) * 100}% - 1px)`;
    $('#heroPresTxt').textContent = total > pres ? `Excedido por ${gs(total - pres)}` : `Quedan ${gs(pres - total)} de ${corto(pres)}`;
  } else {
    barra.parentElement.hidden = true;
    $('#heroPresTxt').textContent = 'Sin presupuesto definido';
  }
  $('#heroProy').textContent = esActual && transcurridos >= 3 && total
    ? `Proyección ${corto((total / transcurridos) * dias)}`
    : esActual ? '' : 'Mes cerrado';

  // KPIs
  $('#kpiDiario').textContent = transcurridos ? corto(total / transcurridos) : '—';
  $('#kpiCant').textContent = actuales.length;
  $('#kpiTicket').textContent = actuales.length ? corto(total / actuales.length) : '—';

  // Ritmo del mes
  $('#leyActual').textContent = nombreMes(mes, false);
  $('#leyPrevio').textContent = nombreMes(previo, false);
  graficoRitmo($('#graficoRitmo'), {
    actual: acumulado(actuales, dias).slice(0, transcurridos || 0),
    previo: acumPrev.slice(0, dias),
    dias,
    mes,
    previoNombre: nombreMes(previo, false),
  });

  // Dona por categoría
  renderDona(totalesPorCategoria(actuales), total);

  // Últimos 6 meses
  const meses = Array.from({ length: 6 }, (_, i) => moverMes(mes, i - 5));
  const totalesMes = meses.map((m) => ({ mes: m, total: suma(delMes(todos, m)) }));
  const conDatos = totalesMes.slice(0, 5).filter((m) => m.total > 0);
  const prom = conDatos.length ? suma(conDatos.map((m) => ({ monto: m.total }))) / conDatos.length : 0;
  $('#promedio6').textContent = prom ? `Promedio ${corto(prom)}` : '';
  graficoMeses($('#graficoMeses'), totalesMes, prom);

  // Top comercios
  renderTopComercios(actuales);

  // Últimos movimientos
  const ul = $('#ultimos');
  ul.replaceChildren(...actuales.slice(0, 5).map(filaMovimiento));
  if (!actuales.length) ul.append(el('li', { class: 'vacio-grafico' }, 'Todavía no hay gastos este mes.'));
}

function graficoRitmo(cont, { actual, previo, dias, mes, previoNombre }) {
  cont.replaceChildren();
  if (!actual.at(-1) && !previo.at(-1)) {
    cont.append(el('div', { class: 'vacio-grafico' }, 'Cuando registres gastos vas a ver tu ritmo diario acá.'));
    return;
  }
  const W = Math.max(260, cont.clientWidth || 320);
  const H = 176;
  const pad = { l: 44, r: 10, t: 12, b: 24 };
  const maxV = Math.max(actual.at(-1) || 0, ...previo, 1);
  const yMax = escalaLinda(maxV);
  const x = (i) => pad.l + (i / Math.max(1, dias - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const camino = (serie) => serie.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');

  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Gasto acumulado por día' });
  s.append(svg('defs', {}, svg('linearGradient', { id: 'gradArea', x1: 0, x2: 0, y1: 0, y2: 1 },
    svg('stop', { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': '.28' }),
    svg('stop', { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': '0' }))));

  const grid = svg('g', { class: 'grid' });
  const eje = svg('g', { class: 'eje' });
  for (const f of [0, 0.5, 1]) {
    const yy = y(yMax * f);
    grid.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy }));
    const t = svg('text', { x: pad.l - 8, y: yy + 3.5, 'text-anchor': 'end' });
    t.textContent = f ? corto(yMax * f) : '0';
    eje.append(t);
  }
  for (const d of [1, 8, 15, 22, dias]) {
    const t = svg('text', { x: x(d - 1), y: H - 6, 'text-anchor': d === 1 ? 'start' : d === dias ? 'end' : 'middle' });
    t.textContent = d;
    eje.append(t);
  }
  s.append(grid, eje);

  if (previo.length) s.append(svg('path', { class: 'linea previo', d: camino(previo) }));
  let lineaAct = null;
  if (actual.length) {
    const area = camino(actual) + `L${x(actual.length - 1).toFixed(1)},${y(0)}L${x(0)},${y(0)}Z`;
    s.append(svg('path', { class: 'area anima-area', d: area }));
    lineaAct = svg('path', { class: 'linea actual', d: camino(actual) });
    s.append(lineaAct);
    s.append(svg('circle', { class: 'punto-fin', cx: x(actual.length - 1), cy: y(actual.at(-1)), r: 4.5 }));
  }

  const cursor = svg('line', { class: 'cursor', y1: pad.t, y2: H - pad.b });
  const pA = svg('circle', { class: 'punto actual', r: 5 });
  const pP = svg('circle', { class: 'punto previo', r: 4.5 });
  const capa = svg('rect', { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, fill: 'transparent' });
  s.append(cursor, pP, pA, capa);
  cont.append(s);

  if (lineaAct) {
    const largo = lineaAct.getTotalLength();
    lineaAct.style.setProperty('--largo', largo);
    lineaAct.classList.add('anima-linea');
  }

  const [a, m] = mes.split('-').map(Number);
  const mover = (ev) => {
    const r = s.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(dias - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (dias - 1))));
    const xx = x(i);
    cursor.setAttribute('x1', xx); cursor.setAttribute('x2', xx);
    const va = actual[i];
    const vp = previo[i];
    pA.style.display = va === undefined ? 'none' : '';
    pP.style.display = vp === undefined ? 'none' : '';
    if (va !== undefined) { pA.setAttribute('cx', xx); pA.setAttribute('cy', y(va)); }
    if (vp !== undefined) { pP.setAttribute('cx', xx); pP.setAttribute('cy', y(vp)); }
    cont.classList.add('activo');
    const fecha = new Date(a, m - 1, i + 1).toLocaleDateString('es-PY', { weekday: 'short', day: 'numeric', month: 'short' });
    const yTip = r.top + (Math.min(va ?? Infinity, vp ?? Infinity) === Infinity ? pad.t : y(Math.max(va ?? 0, vp ?? 0)) * (r.height / H));
    mostrarTip(r.left + xx * (r.width / W), yTip,
      `<div class="t-tit">${esc(fecha)} · acumulado</div>` +
      (va !== undefined ? filaTip('var(--accent)', nombreMes(mes, false), gs(va)) : '') +
      (vp !== undefined ? filaTip('var(--serie-previa)', previoNombre, gs(vp), true) : ''));
  };
  const salir = () => { cont.classList.remove('activo'); ocultarTip(); };
  capa.addEventListener('pointermove', mover);
  capa.addEventListener('pointerdown', mover);
  capa.addEventListener('pointerleave', salir);
  capa.addEventListener('pointercancel', salir);
}

function escalaLinda(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

function barraRedondeada(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function graficoMeses(cont, datos, promedio) {
  cont.replaceChildren();
  if (!datos.some((d) => d.total)) {
    cont.append(el('div', { class: 'vacio-grafico' }, 'Sin datos de los últimos meses.'));
    return;
  }
  const W = Math.max(260, cont.clientWidth || 320);
  const H = 158;
  const pad = { l: 4, r: 4, t: 22, b: 24 };
  const yMax = escalaLinda(Math.max(...datos.map((d) => d.total), promedio, 1));
  const slot = (W - pad.l - pad.r) / datos.length;
  const bw = Math.min(34, slot * 0.52);
  const y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Gasto por mes' });
  const eje = svg('g', { class: 'eje' });
  s.append(svg('g', { class: 'grid' }, svg('line', { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0) })));
  const barras = datos.map((d, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const h = Math.max(d.total ? 3 : 0, y(0) - y(d.total));
    const esActual = i === datos.length - 1;
    const b = svg('path', {
      class: 'barra anima-barra' + (esActual ? ' actual' : ''),
      d: barraRedondeada(cx - bw / 2, y(0) - h, bw, h, 6),
      style: `animation-delay:${i * 50}ms`,
    });
    s.append(b);
    const t = svg('text', { x: cx, y: H - 6, 'text-anchor': 'middle' });
    t.textContent = MESES_CORTOS[Number(d.mes.slice(5)) - 1];
    eje.append(t);
    if (esActual && d.total) {
      const v = svg('text', { class: 'valor', x: cx, y: y(0) - h - 7, 'text-anchor': 'middle' });
      v.textContent = corto(d.total);
      s.append(v);
    }
    return { b, cx, d };
  });
  if (promedio) s.append(svg('line', { class: 'linea-prom', x1: pad.l, x2: W - pad.r, y1: y(promedio), y2: y(promedio) }));
  s.append(eje);
  const capa = svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
  s.append(capa);
  cont.append(s);

  const mover = (ev) => {
    const r = s.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(datos.length - 1, Math.floor((px - pad.l) / slot)));
    barras.forEach((x, j) => x.b.classList.toggle('hover', j === i));
    const { cx, d } = barras[i];
    const dif = promedio ? Math.round(((d.total - promedio) / promedio) * 100) : null;
    mostrarTip(r.left + cx * (r.width / W), r.top + y(d.total) * (r.height / H),
      `<div class="t-tit">${esc(nombreMes(d.mes))}</div><b>${gs(d.total)}</b>` +
      (dif !== null && d.total ? `<div class="t-tit">${dif >= 0 ? '+' : ''}${dif}% vs promedio</div>` : ''));
  };
  const salir = () => { barras.forEach((x) => x.b.classList.remove('hover')); ocultarTip(); };
  capa.addEventListener('pointermove', mover);
  capa.addEventListener('pointerdown', mover);
  capa.addEventListener('pointerleave', salir);
  capa.addEventListener('pointercancel', salir);
}

function renderDona(filas, total) {
  const cont = $('#dona');
  const ley = $('#donaLeyenda');
  cont.replaceChildren();
  ley.replaceChildren();
  if (!total) {
    cont.parentElement.style.gridTemplateColumns = '1fr';
    cont.hidden = true;
    ley.append(el('li', { class: 'vacio-grafico', style: 'display:block;cursor:default' }, 'Sin gastos este mes.'));
    return;
  }
  cont.hidden = false;
  cont.parentElement.style.gridTemplateColumns = '';
  let segs = filas.slice(0, SIN_CATEGORIA_TOP).map((f) => ({ ...f, color: colorDe(f.categoria), icono: iconoDe(f.categoria) }));
  const resto = filas.slice(SIN_CATEGORIA_TOP);
  if (resto.length) segs.push({ categoria: `Otras (${resto.length})`, total: suma(resto.map((r) => ({ monto: r.total }))), color: 'var(--serie-previa)', icono: '•••', otras: true });

  const R = 56;
  const C = 2 * Math.PI * R;
  const gap = segs.length > 1 ? 3 : 0;
  const s = svg('svg', { viewBox: '0 0 136 136' });
  const centro = el('div', { class: 'dona-centro' }, el('small', {}, 'Total'), el('b', {}, corto(total)));
  let offset = 0;
  const items = segs.map((sg, i) => {
    const largo = (sg.total / total) * C;
    const c = svg('circle', {
      class: 'seg', cx: 68, cy: 68, r: R, stroke: sg.color,
      'stroke-dasharray': `0 ${C}`, 'stroke-dashoffset': -offset,
    });
    const final = `${Math.max(0.5, largo - gap)} ${C}`;
    c.style.strokeDasharray = `0 ${C}`;
    setTimeout(() => { c.style.transition = 'stroke-dasharray .9s cubic-bezier(.2,.8,.2,1), stroke-width .2s, opacity .2s'; c.style.strokeDasharray = final; }, 30 + i * 70);
    offset += largo;
    s.append(c);
    const pct = Math.round((sg.total / total) * 100);
    const li = el('li', {},
      el('span', { class: 'ico', style: sg.otras ? 'background:var(--card-2);color:var(--muted)' : fondoIcono(sg.color) }, sg.icono),
      el('div', { class: 'nom' }, el('div', {}, sg.categoria), el('small', {}, `${pct}%`)),
      el('b', {}, corto(sg.total)),
    );
    ley.append(li);
    return { c, li, sg, pct };
  });
  cont.append(s, centro);

  const foco = (it) => {
    cont.classList.toggle('foco', !!it);
    for (const x of items) { x.c.classList.toggle('hover', x === it); x.li.classList.toggle('hover', x === it); }
    centro.replaceChildren(
      el('small', {}, it ? `${it.pct}%` : 'Total'),
      el('b', {}, it ? corto(it.sg.total) : corto(total)),
    );
  };
  for (const it of items) {
    it.c.addEventListener('pointerenter', () => foco(it));
    it.c.addEventListener('pointerleave', () => foco(null));
    it.li.addEventListener('pointerenter', () => foco(it));
    it.li.addEventListener('pointerleave', () => foco(null));
    const ir = () => { if (!it.sg.otras) { state.filtroCat = it.sg.categoria; state.busqueda = ''; $('#buscar').value = ''; cambiarVista('movimientos'); } };
    it.li.addEventListener('click', ir);
    it.c.addEventListener('click', ir);
  }
}

function renderTopComercios(gastos) {
  const grupos = new Map();
  for (const g of gastos) {
    const k = normalizar(g.comercio) || '—';
    const x = grupos.get(k) || { nombre: nombreBonito(g.comercio) || 'Sin comercio', total: 0, n: 0, cats: {} };
    x.total += g.monto; x.n++;
    x.cats[g.categoria] = (x.cats[g.categoria] || 0) + 1;
    grupos.set(k, x);
  }
  const top = [...grupos.values()].sort((a, b) => b.total - a.total).slice(0, 5);
  const ol = $('#topComercios');
  if (!top.length) { ol.replaceChildren(el('li', { class: 'vacio-grafico', style: 'display:block' }, 'Sin datos todavía.')); return; }
  const max = top[0].total;
  ol.replaceChildren(...top.map((t) => {
    const cat = Object.entries(t.cats).sort((a, b) => b[1] - a[1])[0][0];
    const color = colorDe(cat);
    const barra = el('i', { style: `background:${color}` });
    requestAnimationFrame(() => requestAnimationFrame(() => { barra.style.width = (t.total / max) * 100 + '%'; }));
    return el('li', {},
      el('span', { class: 'rank', style: fondoIcono(color) }, iconoDe(cat)),
      el('div', { class: 'info' }, el('div', {}, t.nombre), el('div', { class: 'mini' }, barra)),
      el('div', { class: 'der' }, el('b', {}, gs(t.total)), el('small', {}, `${t.n} ${t.n === 1 ? 'compra' : 'compras'}`)),
    );
  }));
}

function filaMovimiento(g, { dudosos, accion } = {}) {
  const color = colorDe(g.categoria);
  const meta = [g.categoria, g.tarjeta, g.fecha.slice(11, 16)];
  if (g.origen && g.origen !== 'manual') meta.push(g.origen === 'applepay' ? 'Apple Pay' : g.origen);
  return el('li', { class: 'mov' + (g.id === state.recienGuardado ? ' nuevo' : ''), onclick: accion ? null : () => abrirGasto(g) },
    el('span', { class: 'ico', style: fondoIcono(color) }, iconoDe(g.categoria)),
    el('div', { class: 'info' },
      el('div', { class: 'com' }, nombreBonito(g.comercio) || 'Sin comercio', dudosos?.has(g.id) ? el('span', { class: 'tag-dup' }, '¿duplicado?') : null),
      el('div', { class: 'meta' }, meta.filter(Boolean).join(' · ')),
    ),
    accion || el('div', { class: 'monto' }, gs(g.monto), g.pendiente ? el('small', {}, 'pendiente') : null),
  );
}

function abrirDuplicados() {
  const pares = posiblesDuplicados(delMes(gastosTodos(), state.mes));
  if (!pares.length) { cerrarHoja($('#hojaDup')); toast('No quedan duplicados por revisar ✓'); render(); return; }
  $('#listaDup').replaceChildren(...pares.map(([a, b]) => el('div', { class: 'dup-par' },
    el('ul', { class: 'mov-lista' }, [a, b].map((g) => filaMovimiento(g, {
      accion: el('div', { class: 'monto' }, gs(g.monto), el('button', {
        class: 'borrar', type: 'button',
        onclick: async () => { vibrar(10); await encolar({ accion: 'borrar', id: g.id }); toast('Gasto borrado'); abrirDuplicados(); },
      }, 'Borrar')),
    }))),
    el('button', { class: 'btn ancho no-dup', type: 'button', onclick: () => { ignorarDup(clavePar(a, b)); firmas.inicio = ''; abrirDuplicados(); } }, 'No es duplicado'),
  )));
  if ($('#hojaDup').hidden) abrirHoja($('#hojaDup'));
}
$('#alertaDup').addEventListener('click', abrirDuplicados);

// ---------- Movimientos ----------

function renderMovimientos() {
  const delMesActual = delMes(gastosTodos(), state.mes);
  const cats = totalesPorCategoria(delMesActual).map((c) => c.categoria);
  if (state.filtroCat && !cats.includes(state.filtroCat)) cats.unshift(state.filtroCat);

  const chip = (valor, etiqueta) => el('button', {
    class: 'chip' + (state.filtroCat === valor ? ' activo' : ''),
    onclick: () => { state.filtroCat = state.filtroCat === valor && valor ? '' : valor; vibrar(5); renderMovimientos(); },
  }, etiqueta);
  $('#filtros').replaceChildren(chip('', 'Todas'), ...cats.map((c) => chip(c, `${iconoDe(c)} ${c}`)));

  const dudosos = new Set(posiblesDuplicados(delMesActual).flat().map((g) => g.id));
  const q = normalizar(state.busqueda);
  const lista = delMesActual.filter((g) =>
    (!state.filtroCat || g.categoria === state.filtroCat) &&
    (!q || normalizar(`${g.comercio} ${g.tarjeta} ${g.categoria} ${g.origen}`).includes(q)));

  $('#movCant').textContent = `${lista.length} movimiento${lista.length === 1 ? '' : 's'}`;
  $('#movTotal').textContent = gs(suma(lista));

  const cont = $('#listaMov');
  cont.replaceChildren();
  const dias = new Map();
  for (const g of lista) {
    const d = g.fecha.slice(0, 10);
    if (!dias.has(d)) dias.set(d, []);
    dias.get(d).push(g);
  }
  const hoy = ahoraLocal().slice(0, 10);
  const ayer = (() => { const d = new Date(); d.setDate(d.getDate() - 1); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); })();
  for (const [dia, gastos] of dias) {
    const [a, m, d] = dia.split('-').map(Number);
    const etiqueta = dia === hoy ? 'Hoy' : dia === ayer ? 'Ayer' : new Date(a, m - 1, d).toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'short' });
    cont.append(el('div', { class: 'grupo-dia' },
      el('div', { class: 'cab-dia' }, el('span', {}, etiqueta), el('span', {}, gs(suma(gastos)))),
      el('ul', { class: 'mov-lista' }, gastos.map((g) => filaMovimiento(g, { dudosos }))),
    ));
  }
  $('#vacioMov').hidden = lista.length > 0;
}

// ---------- Presupuesto ----------

function renderPresupuesto() {
  const actuales = delMes(gastosTodos(), state.mes);
  if (sinCambios('presupuesto', state.mes, firmaDatos(actuales), state.config)) return;
  const total = suma(actuales);
  const pres = presupuestoTotal();
  const dias = diasDelMes(state.mes);
  const trans = diasTranscurridos(state.mes);
  const esActual = state.mes === mesActual();

  // Anillo
  const R = 54;
  const C = 2 * Math.PI * R;
  const frac = pres ? Math.min(1, total / pres) : 0;
  const valor = svg('circle', { class: 'valor' + (pres && total > pres ? ' excedido' : ''), cx: 64, cy: 64, r: R, 'stroke-dasharray': C, 'stroke-dashoffset': C });
  $('#anillo').replaceChildren(
    svg('svg', { viewBox: '0 0 128 128' }, svg('circle', { class: 'fondo', cx: 64, cy: 64, r: R }), valor),
    el('div', { class: 'anillo-centro' }, el('b', {}, pres ? `${Math.round((total / pres) * 100)}%` : '—'), el('small', {}, 'usado')),
  );
  requestAnimationFrame(() => requestAnimationFrame(() => valor.setAttribute('stroke-dashoffset', C * (1 - frac))));

  $('#presEtiqueta').textContent = pres && total > pres ? 'Excedido' : 'Disponible';
  $('#presDisp').textContent = pres ? gs(Math.abs(pres - total)) : 'Sin límite';
  $('#presDisp').style.color = pres && total > pres ? 'var(--critical)' : '';
  $('#presDe').textContent = pres ? `Gastaste ${gs(total)} de ${gs(pres)}` : 'Definí límites por categoría abajo.';
  const ritmo = $('#presRitmo');
  if (pres && esActual && trans >= 3) {
    const proy = (total / trans) * dias;
    ritmo.hidden = false;
    ritmo.className = 'ritmo ' + (proy > pres ? 'mal' : 'bien');
    ritmo.textContent = proy > pres ? `⚠︎ A este ritmo cerrás en ${corto(proy)}` : `✓ Vas bien: cerrarías en ${corto(proy)}`;
  } else ritmo.hidden = true;

  const totales = new Map(totalesPorCategoria(actuales).map((f) => [f.categoria, f.total]));
  const filas = state.config.categorias.map((c) => ({ ...c, gastado: totales.get(c.nombre) || 0, limite: presupuestoDe(c.nombre) }))
    .sort((a, b) => (b.limite ? 1 : 0) - (a.limite ? 1 : 0) || b.gastado - a.gastado);

  $('#listaPres').replaceChildren(...filas.map((f) => {
    const color = f.color || COLOR_DEFECTO;
    const exc = f.limite && f.gastado > f.limite;
    const barra = el('i', { style: `background:${exc ? 'var(--critical)' : color}` });
    if (f.limite) requestAnimationFrame(() => requestAnimationFrame(() => { barra.style.width = Math.min(100, (f.gastado / f.limite) * 100) + '%'; }));
    return el('li', { class: 'pres-item' + (f.limite ? '' : ' sin'), onclick: () => abrirPresupuesto(f.nombre) },
      el('div', { class: 'fila' },
        el('span', { class: 'ico', style: fondoIcono(color) }, iconoDe(f.nombre)),
        el('div', {}, el('div', { class: 'nom' }, f.nombre), el('div', { class: 'det' }, f.limite ? `Límite ${gs(f.limite)}` : '+ Definir límite')),
        el('div', { class: 'der' },
          el('b', {}, gs(f.gastado)),
          f.limite ? el('small', { class: exc ? 'mal' : '' }, exc ? `excedido ${corto(f.gastado - f.limite)}` : `quedan ${corto(f.limite - f.gastado)}`) : null,
        ),
      ),
      f.limite ? el('div', { class: 'barra' }, barra, esActual ? el('span', { class: 'hoy', style: `left:${(trans / dias) * 100}%` }) : null) : null,
    );
  }));
}

let presEditando = '';
function abrirPresupuesto(cat) {
  presEditando = cat;
  $('#presTitulo').textContent = `${iconoDe(cat)} ${cat}`;
  const v = presupuestoDe(cat);
  $('#fPres').value = v ? fmt.format(v) : '';
  abrirHoja($('#hojaPres'));
  setTimeout(() => $('#fPres').focus(), 320);
}
$('#fPres').addEventListener('input', (e) => { const n = soloDigitos(e.target.value); e.target.value = n ? fmt.format(n) : ''; });
$('#formPres').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const n = soloDigitos($('#fPres').value);
  const cfg = structuredClone(state.config);
  cfg.presupuestos = cfg.presupuestos.filter((p) => p.categoria !== presEditando);
  if (n) cfg.presupuestos.push({ categoria: presEditando, monto: n });
  state.config = cfg;
  state.borrador = null;
  await store.set('config', cfg);
  cerrarHoja($('#hojaPres'));
  vibrar(10);
  await encolar({ accion: 'config', config: cfg });
  toast(n ? `Límite de ${presEditando}: ${gs(n)}` : `Sin límite para ${presEditando}`);
});

// ---------- Ajustes ----------

function renderAjustes() {
  if (!state.borrador) state.borrador = structuredClone(state.config);
  const b = state.borrador;
  if (document.activeElement?.id !== 'cfgUrl') $('#cfgUrl').value = state.conexion.url;
  if (document.activeElement?.id !== 'cfgToken') $('#cfgToken').value = state.conexion.token;

  const cambio = () => { $('#barraGuardar').hidden = false; };
  const nombres = b.categorias.map((c) => c.nombre).filter(Boolean);

  $('#listaCategorias').replaceChildren(...b.categorias.map((c, i) => el('li', {},
    el('span', { class: 'ico-cat', style: fondoIcono(c.color || COLOR_DEFECTO) }, iconoDe(c.nombre)),
    el('input', {
      value: c.nombre, placeholder: 'Nombre', 'aria-label': 'Nombre de categoría',
      onchange: (e) => {
        const viejo = c.nombre;
        const nuevo = e.target.value.trim();
        if (!nuevo || nuevo === viejo) { e.target.value = viejo; return; }
        if (nombres.includes(nuevo)) { toast('Ya existe esa categoría'); e.target.value = viejo; return; }
        c.nombre = nuevo;
        for (const r of b.reglas) if (r.categoria === viejo) r.categoria = nuevo;
        for (const p of b.presupuestos) if (p.categoria === viejo) p.categoria = nuevo;
        cambio(); renderAjustes();
      },
    }),
    el('input', { type: 'color', value: c.color || COLOR_DEFECTO, 'aria-label': 'Color', oninput: (e) => { c.color = e.target.value; cambio(); renderAjustes(); } }),
    el('button', { class: 'quitar', 'aria-label': 'Quitar', onclick: () => {
      if (b.categorias.length <= 1) return toast('Tiene que quedar al menos una categoría');
      b.categorias.splice(i, 1);
      b.presupuestos = b.presupuestos.filter((p) => p.categoria !== c.nombre);
      cambio(); renderAjustes();
    } }, '×'),
  )));

  $('#listaReglas').replaceChildren(...b.reglas.map((r, i) => el('li', {},
    el('input', { value: r.patron, placeholder: 'Texto del comercio', 'aria-label': 'Texto del comercio', oninput: (e) => { r.patron = e.target.value; cambio(); } }),
    el('span', { class: 'flecha' }, '→'),
    el('select', { 'aria-label': 'Categoría', onchange: (e) => { r.categoria = e.target.value; cambio(); } },
      nombres.map((n) => el('option', { value: n, selected: n === r.categoria }, n)),
      nombres.includes(r.categoria) ? null : el('option', { value: r.categoria, selected: true }, r.categoria + ' (no existe)'),
    ),
    el('button', { class: 'quitar', 'aria-label': 'Quitar', onclick: () => { b.reglas.splice(i, 1); cambio(); renderAjustes(); } }, '×'),
  )));
}

// ---------- Hojas (bottom sheets) ----------

function abrirHoja(h) {
  h.hidden = false;
  document.body.style.overflow = 'hidden';
  void h.offsetWidth; // fuerza el layout para que la transición de entrada arranque
  h.classList.add('abierta');
}
function cerrarHoja(h) {
  h.classList.remove('abierta');
  const panel = h.querySelector('.hoja-panel');
  panel.style.transform = '';
  document.activeElement?.blur?.();
  setTimeout(() => { h.hidden = true; if (!$$('.hoja:not([hidden])').length) document.body.style.overflow = ''; }, 380);
}
for (const h of $$('.hoja')) {
  h.addEventListener('click', (e) => { if (e.target.closest('[data-cerrar]')) cerrarHoja(h); });
  // Deslizar hacia abajo para cerrar.
  const panel = h.querySelector('.hoja-panel');
  let y0 = null;
  let dy = 0;
  panel.addEventListener('touchstart', (e) => {
    if (panel.scrollTop > 0 || e.target.closest('input, .teclado, .cat-chips')) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0; panel.style.transition = 'none';
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    if (y0 === null) return;
    panel.style.transition = '';
    if (dy > 110) cerrarHoja(h); else panel.style.transform = '';
    y0 = null;
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const h of $$('.hoja.abierta')) cerrarHoja(h);
});

// ---------- Formulario de gasto ----------

const form = { id: null, monto: '', categoria: '', manual: false, editando: null };

function abrirGasto(g = null) {
  form.editando = g;
  form.monto = g ? String(g.monto) : '';
  form.categoria = g?.categoria || '';
  form.manual = !!g;
  $('#hojaTitulo').textContent = g ? 'Editar gasto' : 'Nuevo gasto';
  $('#btnGuardar').textContent = g ? 'Guardar cambios' : 'Guardar gasto';
  $('#fComercio').value = g?.comercio || '';
  $('#fTarjeta').value = g ? g.tarjeta : (localStorageGet('ultimaTarjeta') || '');
  $('#fFecha').value = g ? g.fecha.replace(' ', 'T') : (state.mes === mesActual() ? ahoraLocal() : state.mes + '-01T12:00');
  $('#btnBorrar').hidden = !g;
  const tarjetas = [...new Set(gastosTodos().map((x) => x.tarjeta).filter(Boolean))];
  $('#tarjetas').replaceChildren(...tarjetas.map((t) => el('option', { value: t })));
  pintarMonto();
  pintarCategorias();
  abrirHoja($('#hoja'));
}

function pintarMonto(pulso) {
  const n = soloDigitos(form.monto);
  const caja = $('#montoGrande');
  $('#montoTxt').textContent = fmt.format(n);
  caja.classList.toggle('vacio', !n);
  if (pulso) { caja.classList.remove('pulso'); void caja.offsetWidth; caja.classList.add('pulso'); }
}

function pintarCategorias() {
  const sugerida = categorizar($('#fComercio').value);
  const elegida = form.manual ? form.categoria : sugerida;
  const cats = state.config.categorias.map((c) => c.nombre);
  if (elegida && !cats.includes(elegida)) cats.push(elegida);
  $('#catChips').replaceChildren(...cats.map((nombre) => el('button', {
    type: 'button',
    class: 'cat-chip' + (nombre === elegida ? ' activo' : ''),
    onclick: () => { form.manual = true; form.categoria = nombre; vibrar(5); pintarCategorias(); },
  },
  el('span', { class: 'e' }, iconoDe(nombre)),
  !form.manual && nombre === sugerida && $('#fComercio').value.trim() ? el('span', { class: 'auto' }, 'auto') : null,
  el('span', {}, nombre))));
  const activo = $('#catChips .activo');
  activo?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
}

function tecla(k) {
  if (k === 'del') form.monto = form.monto.slice(0, -1);
  else if ((form.monto + k).replace(/^0+/, '').length <= 12) form.monto = (form.monto + k).replace(/^0+/, '');
  vibrar(4);
  pintarMonto(k !== 'del');
}
$('#teclado').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) tecla(b.dataset.k); });
document.addEventListener('keydown', (e) => {
  if ($('#hoja').hidden || e.target.matches('input, select, textarea')) return;
  if (/^\d$/.test(e.key)) { tecla(e.key); e.preventDefault(); }
  else if (e.key === 'Backspace') { tecla('del'); e.preventDefault(); }
  else if (e.key === 'Enter') { $('#formGasto').requestSubmit(); e.preventDefault(); }
});
$('#fComercio').addEventListener('input', () => pintarCategorias());
$('#fComercio').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }

$('#formGasto').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const monto = soloDigitos(form.monto);
  if (!monto) {
    const caja = $('#montoGrande');
    caja.classList.remove('sacudir'); void caja.offsetWidth; caja.classList.add('sacudir');
    vibrar([10, 40, 10]);
    return;
  }
  const comercio = $('#fComercio').value.trim();
  const g = form.editando;
  const gasto = {
    id: g?.id || uuid(),
    fecha: ($('#fFecha').value || ahoraLocal()).replace('T', ' ').slice(0, 16),
    monto,
    comercio,
    tarjeta: $('#fTarjeta').value.trim(),
    categoria: form.manual ? form.categoria : categorizar(comercio),
    origen: g?.origen || 'manual',
  };
  const parecido = !g && gastoParecido(gasto);
  if (parecido && !confirm(`Ya hay un gasto de ${gs(parecido.monto)} en ${nombreBonito(parecido.comercio) || 'sin comercio'} a las ${parecido.fecha.slice(11, 16)}` +
    `${parecido.origen === 'applepay' ? ' (entró por Apple Pay)' : ''}.\n\n¿Guardar este de todos modos?`)) return;
  if (gasto.tarjeta) localStorageSet('ultimaTarjeta', gasto.tarjeta);
  state.recienGuardado = gasto.id;
  setTimeout(() => { state.recienGuardado = ''; }, 1500);
  cerrarHoja($('#hoja'));
  vibrar(12);
  await encolar({ accion: 'guardar', gasto });
  toast(`${g ? 'Actualizado' : 'Guardado'}: ${gs(monto)} · ${gasto.categoria}`);
  if (!gasto.fecha.startsWith(state.mes)) { state.mes = gasto.fecha.slice(0, 7); render(); }
});

$('#btnBorrar').addEventListener('click', async () => {
  const g = form.editando;
  if (!g || !confirm(`¿Borrar ${gs(g.monto)} en ${g.comercio || 'sin comercio'}?`)) return;
  cerrarHoja($('#hoja'));
  await encolar({ accion: 'borrar', id: g.id });
  toast('Gasto borrado');
});

// ---------- CSV ----------

function aCsv(gastos) {
  const cols = ['fecha', 'monto', 'comercio', 'tarjeta', 'categoria', 'origen'];
  const escCsv = (v) => {
    const s = String(v ?? '');
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // ";" y BOM para que Excel en español lo abra bien.
  return '﻿' + [cols.join(';'), ...gastos.map((g) => cols.map((c) => escCsv(g[c])).join(';'))].join('\r\n');
}

async function descargarCsv(nombre, gastos) {
  const archivo = new File([aCsv(gastos)], nombre, { type: 'text/csv' });
  if (navigator.standalone && navigator.canShare?.({ files: [archivo] })) {
    try { await navigator.share({ files: [archivo] }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = el('a', { href: URL.createObjectURL(archivo), download: nombre });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- Eventos ----------

async function cambiarMes(delta) {
  const nuevo = moverMes(state.mes, delta);
  if (nuevo > mesActual()) return;
  state.mes = nuevo;
  vibrar(5);
  ocultarTip();
  render();
  animarEntrada(delta < 0 ? 'entra-izq' : 'entra-der');
}

$('#mesPrev').onclick = () => cambiarMes(-1);
$('#mesNext').onclick = () => cambiarMes(1);
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-nuevo]')) { vibrar(8); abrirGasto(); }
  const ir = e.target.closest('[data-ir]');
  if (ir) { if (ir.dataset.ir === 'movimientos') state.filtroCat = ''; cambiarVista(ir.dataset.ir); }
});
$('#estado').onclick = () => {
  if (!conectado()) return cambiarVista('ajustes');
  if (state.ultimoError) toast(state.ultimoError);
  sincronizar();
};
for (const b of $$('.tabs button[data-vista]')) b.onclick = () => { vibrar(5); cambiarVista(b.dataset.vista); };

$('#buscar').addEventListener('input', (e) => { state.busqueda = e.target.value; renderMovimientos(); });

// Deslizar horizontalmente para cambiar de mes.
{
  let x0 = null, y0 = 0, t0 = 0;
  const main = $('#main');
  main.addEventListener('touchstart', (e) => {
    if (state.vista === 'ajustes' || e.target.closest('.chips, .grafico-caja, input, .dona')) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  main.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45 && Date.now() - t0 < 600) cambiarMes(dx > 0 ? -1 : 1);
  });
}

$('#btnConectar').onclick = async () => {
  const url = $('#cfgUrl').value.trim();
  const token = $('#cfgToken').value.trim();
  if (url && !/^(https:\/\/script\.google(usercontent)?\.com\/|http:\/\/localhost[:/])/.test(url)) return toast('La URL debe ser de script.google.com');
  state.conexion = { url, token };
  await store.set('conexion', state.conexion);
  if (!conectado()) return render();
  toast('Conectando… la primera vez puede tardar unos segundos');
  state.sincronizando = true;
  renderEstado();
  try {
    await cargarDelServidor();
    state.ultimoError = '';
    state.borrador = null;
    toast('Conexión correcta ✓');
  } catch (err) {
    state.ultimoError = err.message;
    toast('No conecta: ' + err.message);
  } finally {
    state.sincronizando = false;
    sincronizar();
  }
};

$('#btnAddCategoria').onclick = () => {
  const b = state.borrador;
  let n = 1;
  while (b.categorias.some((c) => c.nombre === `Nueva ${n}`)) n++;
  b.categorias.push({ nombre: `Nueva ${n}`, color: '#2a78d6' });
  $('#barraGuardar').hidden = false;
  renderAjustes();
  $('#listaCategorias li:last-child input')?.select();
};
$('#btnAddRegla').onclick = () => {
  state.borrador.reglas.push({ patron: '', categoria: state.borrador.categorias[0].nombre });
  $('#barraGuardar').hidden = false;
  renderAjustes();
  $('#listaReglas li:last-child input')?.focus();
};
$('#btnGuardarConfig').onclick = async () => {
  const b = state.borrador;
  b.reglas = b.reglas.filter((r) => r.patron.trim()).map((r) => ({ patron: r.patron.trim(), categoria: r.categoria }));
  state.config = structuredClone(b);
  await store.set('config', state.config);
  $('#barraGuardar').hidden = true;
  await encolar({ accion: 'config', config: state.config });
  toast(conectado() ? 'Configuración guardada' : 'Guardado en este dispositivo');
};

$('#btnCsvMes').onclick = () => descargarCsv(`gastos-${state.mes}.csv`, delMes(gastosTodos(), state.mes));
$('#btnCsvTodo').onclick = () => descargarCsv('gastos-todos.csv', gastosTodos());

window.addEventListener('online', () => { state.online = true; sincronizar(); });
window.addEventListener('offline', () => { state.online = false; render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) sincronizar(); });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.vista === 'inicio') renderInicio(); }, 200); });
window.addEventListener('scroll', ocultarTip, { passive: true });

// ---------- Inicio ----------

state.conexion = (await store.get('conexion')) || state.conexion;
state.config = (await store.get('config')) || state.config;
state.todos = (await store.get('gastos:todos')) || [];
state.cola = await store.cola();
render();
animarEntrada('entra');
sincronizar();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW no registrado', err));
}
