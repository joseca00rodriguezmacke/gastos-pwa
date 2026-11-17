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
  impuestos: '🧾', bancos: '🏦', hijos: '🧸', transferencias: '💸', inversiones: '📈',
  'por revisar': '❓', sueldo: '💼', ventas: '🧾', compras: '🛍️', creditos: '🏦', devoluciones: '↩️', otros: '📦',
};
const POR_REVISAR = 'Por revisar';
const CATS_INGRESO = ['Sueldo', 'Ventas'];
/** Lo que está "Por revisar" no suma hasta que lo confirmes; lo pagado por otro (tercero) nunca suma. */
const contable = (g) => g.categoria !== POR_REVISAR && !g.tercero;
const SIN_CATEGORIA_TOP = 5; // en la dona: 5 categorías + "Otras"

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 });
const OCULTO = '•••••';
const gs = (n) => 'Gs ' + (state.discreto ? OCULTO : fmt.format(Math.round(n || 0)));
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
  filtroEtiqueta: '', // Movimientos: viaje/evento elegido (mira todos los meses) o "__tercero"
  busqueda: '',
  recienGuardado: '',
  ingresos: [],      // ingresos según el servidor (o caché)
  modoMov: 'gastos', // Movimientos: "gastos" o "ingresos"
  ia: { disponible: false, resumen: null, consultarSiempre: [], metaAhorro: 0 }, // funciones de IA del servidor
  discreto: false,   // modo discreto: oculta los montos
  estadoSis: null,   // último estado del sistema traído del servidor
  suscNuevas: [],    // posibles suscripciones nuevas detectadas por el servidor (IA)
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
  if (state.discreto) return '•••';
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
/** Igual que en el backend: la regla tiene que coincidir como palabra completa ("stock" ≠ "stockholm"). */
function coincidePatron(texto, patron) {
  const p = normalizar(patron).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !!p && new RegExp(`(^|[^a-z0-9])${p}($|[^a-z0-9])`).test(normalizar(texto));
}
function categorizar(comercio, reglas = state.config.reglas) {
  if (comercio) {
    for (const r of reglas) if (coincidePatron(comercio, r.patron)) return r.categoria;
  }
  return CATEGORIA_DEFECTO;
}

const NOMBRES_FUENTE = { applepay: 'Apple Pay', sms: 'SMS', mail: 'Mail' };
/** "applepay+sms · USD 9,99 (TC 7.300)" -> "Apple Pay + SMS · USD 9,99"; "manual" -> "" */
function fuenteLegible(origen) {
  if (!origen || origen === 'manual') return '';
  const [fuentes, ...notas] = origen.split(' · ');
  const nombres = fuentes.split('+').map((f) => NOMBRES_FUENTE[f] || f).join(' + ');
  return [nombres, ...notas.map((n) => n.replace(/\s*\(TC [^)]*\)/, ''))].join(' · ');
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

// Google a veces corta una llamada al instante (devuelve una página de error) o la deja colgada.
// Cada llamada tiene tiempo límite y se reintenta sola; todo lo que se guarda lleva id, así que repetir no duplica.
const ACCIONES_IA = ['preguntar', 'consejo', 'simular', 'explicar', 'sugerencias', 'iaMantenimiento', 'resumenAhora'];
const ESPERAS_REINTENTO = [1500, 4000];

async function llamar(url, opciones, limiteMs) {
  let ultimo;
  for (let intento = 0; intento <= ESPERAS_REINTENTO.length; intento++) {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), limiteMs);
    try {
      const r = await fetch(url, { ...opciones, signal: ctrl.signal });
      const texto = await r.text();
      try { return JSON.parse(texto); } catch { throw new Error('Google respondió con un error momentáneo'); }
    } catch (err) {
      ultimo = err.name === 'AbortError' ? new Error('El servidor tardó demasiado') : err;
      if (intento < ESPERAS_REINTENTO.length) await new Promise((ok) => setTimeout(ok, ESPERAS_REINTENTO[intento]));
    } finally {
      clearTimeout(reloj);
    }
  }
  throw ultimo;
}

async function apiGet(params) {
  const url = new URL(state.conexion.url);
  url.searchParams.set('token', state.conexion.token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return llamar(url, { cache: 'no-store' }, 30000);
}

async function apiPost(body) {
  // text/plain evita el preflight CORS, que Apps Script no responde.
  return llamar(state.conexion.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, token: state.conexion.token }),
  }, ACCIONES_IA.includes(body.accion) ? 300000 : 45000);
}

const hayConfigPendiente = () => state.cola.some((i) => i.body.accion === 'config');
const errorDeAcceso = (msg) => /autorizad|TOKEN/i.test(msg || '');

async function cargarDelServidor() {
  if (!conectado() || !state.online) return;
  const r = await apiGet({});
  if (!r.ok) throw new Error(r.error || 'Error del servidor');
  state.todos = r.gastos;
  await store.set('gastos:todos', r.gastos);
  state.ingresos = r.ingresos || [];
  await store.set('ingresos:todos', state.ingresos);
  if (r.ia) { state.ia = r.ia; await store.set('ia', r.ia); }
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
    cargarSuscNuevas();
  } catch (err) {
    state.ultimoError = err.message === 'Failed to fetch' || err.name === 'TypeError' ? 'Sin conexión con el servidor' : err.message;
  } finally {
    state.cola = await store.cola();
    state.sincronizando = false;
    render();
    if (repetirSync && !state.ultimoError) sincronizar();
    else if (state.ultimoError && !errorDeAcceso(state.ultimoError)) {
      clearTimeout(reintentoSync);
      reintentoSync = setTimeout(() => { if (state.online && !document.hidden) sincronizar(); }, 30000);
    }
  }
}
let reintentoSync = null;

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
/** Ingresos: servidor + cambios pendientes de la cola. */
function ingresosTodos() {
  const mapa = new Map(state.ingresos.map((i) => [i.id, { ...i }]));
  for (const { body } of state.cola) {
    if (body.accion === 'ingreso') mapa.set(body.ingreso.id, { ...body.ingreso, pendiente: true });
    else if (body.accion === 'borrarIngreso') mapa.delete(body.id);
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

// Lo cargado a mano suele llevar otro nombre ("Tirze" vs "Transferencia a Marcela") y cargarse horas después.
const VENTANA_DUP_MANUAL_MIN = 180;
const esManual = (g) => (g.origen || 'manual').split(' · ')[0].split('+').includes('manual');
const montoIgual = (a, b) => Math.abs(a - b) <= 1;

function pareceDuplicado(a, b) {
  if (!montoIgual(a.monto, b.monto)) return false;
  const dif = Math.abs(minutos(a.fecha) - minutos(b.fecha));
  if (dif <= VENTANA_DUP_MIN && mismoComercio(a.comercio, b.comercio)) return true;
  return esManual(a) !== esManual(b) && dif <= VENTANA_DUP_MANUAL_MIN;
}

/** Pares que parecen el mismo pago registrado dos veces. */
function posiblesDuplicados(gastos) {
  const ignorados = ignoradosDup();
  const orden = [...gastos].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const pares = [];
  for (let i = 0; i < orden.length; i++) {
    for (let j = i + 1; j < orden.length; j++) {
      const a = orden[i];
      const b = orden[j];
      if (minutos(b.fecha) - minutos(a.fecha) > VENTANA_DUP_MANUAL_MIN) break;
      if (pareceDuplicado(a, b) && !ignorados.has(clavePar(a, b))) pares.push([a, b]);
    }
  }
  return pares;
}

/** Gasto ya registrado que parece el mismo que se está por guardar a mano (para avisar antes). */
function gastoParecido(nuevo) {
  return gastosTodos().find((g) => g.id !== nuevo.id && pareceDuplicado({ ...nuevo, origen: 'manual' }, g));
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
  if (vista === 'ajustes') cargarEstado();
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
  const conRevisar = gastosTodos();
  const todos = conRevisar.filter(contable);
  const ingresos = ingresosTodos();
  const mes = state.mes;
  const dups = posiblesDuplicados(delMes(conRevisar, mes));
  $('#alertaDup').hidden = !dups.length;
  $('#alertaDupTit').textContent = dups.length === 1 ? '1 posible gasto duplicado' : `${dups.length} posibles gastos duplicados`;
  const revisar = conRevisar.filter((g) => g.categoria === POR_REVISAR).length;
  $('#alertaRevisar').hidden = !revisar;
  $('#alertaRevisarTit').textContent = revisar === 1 ? '1 transferencia por revisar' : `${revisar} transferencias por revisar`;
  renderAlertaSistema();
  renderTarjetasIA();
  if (sinCambios('inicio', mes, firmaDatos(conRevisar), firmaDatos(ingresos), state.config, state.ia, state.discreto, $('#graficoRitmo').clientWidth, new Date().getDate())) return;
  renderFlujo(delMes(ingresos, mes), suma(delMes(todos, mes)));
  renderCoach(delMes(ingresos, mes), suma(delMes(todos, mes)));
  const previo = moverMes(mes, -1);
  const actuales = delMes(todos, mes);
  const anteriores = delMes(todos, previo);
  const dias = diasDelMes(mes);
  const transcurridos = diasTranscurridos(mes);
  const total = suma(actuales);
  const esActual = mes === mesActual();

  // Hero
  $('#heroEtiqueta').textContent = esActual ? 'Gastado este mes' : `Gastado en ${nombreMes(mes, false).toLowerCase()}`;
  if (state.discreto) { $('#heroMonto').textContent = OCULTO; $('#heroMonto').dataset.v = total; }
  else animarNumero($('#heroMonto'), total);
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
  const prono = esActual && transcurridos >= 3 && total ? pronostico(todos, mes) : null;
  $('#heroProy').textContent = prono ? `Pronóstico ${corto(prono.total)}` : esActual ? '' : 'Mes cerrado';
  renderPronostico(prono, suma(delMes(ingresos, mes)));
  renderAlertaSueldo(ingresos);
  renderAlertaSusc();

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

  // Vs mes anterior, por categoría (mes en curso: contra el mismo tramo de días del mes anterior)
  renderComparacion(totalesPorCategoria(actuales),
    totalesPorCategoria(esActual ? anteriores.filter((g) => Number(g.fecha.slice(8, 10)) <= transcurridos) : anteriores),
    esActual ? `al día ${transcurridos}` : '', previo);

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

/** Flujo del mes: ingresos vs gastos y lo que quedó. */
function renderFlujo(ingresos, gastado) {
  const ing = suma(ingresos);
  const resultado = ing - gastado;
  const escala = Math.max(ing, gastado, 1);
  $('#flujoIng').textContent = gs(ing);
  $('#flujoGas').textContent = gs(gastado);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $('#flujoBarIng').style.width = (ing / escala) * 100 + '%';
    $('#flujoBarGas').style.width = (gastado / escala) * 100 + '%';
  }));
  $('#flujoResTxt').textContent = !ing ? 'Resultado' : resultado >= 0 ? `Ahorro (${Math.round((resultado / ing) * 100)}% de lo que entró)` : 'Gastaste más de lo que entró';
  const res = $('#flujoRes');
  res.textContent = (resultado < 0 ? '−' : '') + gs(Math.abs(resultado));
  res.style.color = resultado >= 0 ? 'var(--ingreso)' : 'var(--critical)';
  $('#flujoDesglose').replaceChildren(...CATS_INGRESO.map((c) => {
    const t = suma(ingresos.filter((i) => i.categoria === c));
    return el('span', { class: 'mini-chip' }, `${iconoDe(c)} ${c}`, el('b', {}, corto(t)));
  }));
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
  meta.push(fuenteLegible(g.origen));
  return el('li', { class: 'mov' + (g.id === state.recienGuardado ? ' nuevo' : ''), onclick: accion ? null : () => abrirGasto(g) },
    el('span', { class: 'ico', style: fondoIcono(color) }, iconoDe(g.categoria)),
    el('div', { class: 'info' },
      el('div', { class: 'com' }, nombreBonito(g.comercio) || 'Sin comercio',
        dudosos?.has(g.id) ? el('span', { class: 'tag-dup' }, '¿duplicado?') : null,
        g.categoria === POR_REVISAR ? el('span', { class: 'tag-dup' }, 'por revisar') : null,
        g.etiqueta ? el('span', { class: 'tag-etq' }, '🏷️ ' + g.etiqueta) : null,
        g.tercero ? el('span', { class: 'tag-tercero' }, 'de ' + g.tercero) : null),
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
  for (const b of $$('.segmento button')) b.classList.toggle('activo', b.dataset.modo === state.modoMov);
  $('#gastosVista').hidden = state.modoMov !== 'gastos';
  $('#ingresosVista').hidden = state.modoMov !== 'ingresos';
  if (state.modoMov === 'ingresos') return renderIngresos();
  const fe = state.filtroEtiqueta;
  const delMesActual = fe === '__tercero' ? delMes(gastosTodos(), state.mes).filter((g) => g.tercero)
    : fe ? gastosTodos().filter((g) => g.etiqueta === fe) // un viaje puede abarcar varios meses
    : delMes(gastosTodos(), state.mes);
  renderFiltrosEtiqueta();
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
  $('#movTotal').textContent = fe === '__tercero' ? `Te deben ${gs(suma(lista))}` : gs(suma(lista.filter(contable)));

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
      el('div', { class: 'cab-dia' }, el('span', {}, etiqueta), el('span', {}, gs(suma(fe === '__tercero' ? gastos : gastos.filter(contable))))),
      el('ul', { class: 'mov-lista' }, gastos.map((g) => filaMovimiento(g, { dudosos }))),
    ));
  }
  $('#vacioMov').hidden = lista.length > 0;
}

/** Chips de viajes/eventos y de "pagado por otros" arriba de los filtros de categoría. */
function renderFiltrosEtiqueta() {
  const todos = gastosTodos();
  const etiquetas = new Map();
  for (const g of todos) if (g.etiqueta) etiquetas.set(g.etiqueta, (etiquetas.get(g.etiqueta) || 0) + (contable(g) ? g.monto : 0));
  const terceroMes = delMes(todos, state.mes).some((g) => g.tercero);
  const fe = state.filtroEtiqueta;
  const chip = (valor, texto) => el('button', {
    class: 'chip chip-etq' + (fe === valor ? ' activo' : ''),
    onclick: () => { state.filtroEtiqueta = fe === valor ? '' : valor; state.filtroCat = ''; vibrar(5); renderMovimientos(); },
  }, texto);
  const chips = [...etiquetas].sort((a, b) => b[1] - a[1]).map(([t, total]) => chip(t, `🏷️ ${t} · ${corto(total)}`));
  if (terceroMes || fe === '__tercero') chips.push(chip('__tercero', '🤝 Pagado por otros'));
  $('#filtrosEtq').replaceChildren(...chips);
  $('#filtrosEtq').hidden = !chips.length;
}

/** Comparación por categoría contra el mes anterior: qué subió y qué bajó. */
function renderComparacion(ahora, antes, nota, previo) {
  const mapa = new Map();
  for (const c of ahora) mapa.set(c.categoria, { cat: c.categoria, a: c.total, b: 0 });
  for (const c of antes) { const x = mapa.get(c.categoria) || { cat: c.categoria, a: 0, b: 0 }; x.b = c.total; mapa.set(c.categoria, x); }
  const filas = [...mapa.values()].map((x) => ({ ...x, d: x.a - x.b })).filter((x) => x.d !== 0)
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 6);
  $('#compNota').textContent = `vs ${nombreMes(previo, false).toLowerCase()}${nota ? ' ' + nota : ''}`;
  const max = Math.max(1, ...filas.map((x) => Math.abs(x.d)));
  $('#listaComp').replaceChildren(...filas.map((x) => {
    const sube = x.d > 0;
    const pct = x.b ? Math.round((x.d / x.b) * 100) : null;
    return el('li', { class: 'comp-fila' },
      el('span', { class: 'ico', style: fondoIcono(colorDe(x.cat)) }, iconoDe(x.cat)),
      el('div', { class: 'comp-info' },
        el('div', { class: 'comp-cab' }, el('span', {}, x.cat),
          el('b', { class: sube ? 'sube' : 'baja' }, `${sube ? '↑' : '↓'} ${gs(Math.abs(x.d))}`)),
        el('div', { class: 'comp-barra' }, el('i', { class: sube ? 'sube' : 'baja', style: `width:${(Math.abs(x.d) / max) * 100}%` })),
        el('div', { class: 'meta' }, `${gs(x.a)} ahora · ${gs(x.b)} antes${pct === null ? ' · nuevo' : ` · ${pct > 0 ? '+' : ''}${pct}%`}`)),
    );
  }));
  $('#vacioComp').hidden = filas.length > 0;
}

// ---------- Coach, IA y suscripciones ----------

/** Coach (sin IA): con lo que entró y lo que se gastó, cuánto se puede gastar por día para cumplir la meta. */
function renderCoach(ingresos, gastado) {
  const meta = Number(state.ia.metaAhorro) || 0;
  $('#metaTxt').textContent = meta ? corto(meta) : 'definir';
  const esActual = state.mes === mesActual();
  const ing = suma(ingresos);
  const txt = $('#coachTxt');
  if (!esActual) {
    const res = ing - gastado;
    txt.innerHTML = '';
    txt.append(`En ${nombreMes(state.mes, false).toLowerCase()} entraron `, el('b', {}, gs(ing)), ', gastaste ', el('b', {}, gs(gastado)),
      res >= 0 ? ' y ahorraste ' : ' y faltaron ', el('b', {}, gs(Math.abs(res))), meta ? (res >= meta ? ' ✅ cumpliste la meta.' : ' ⚠️ no llegaste a la meta.') : '.');
    return;
  }
  const quedan = diasDelMes(state.mes) - new Date().getDate() + 1;
  const disponible = ing - gastado - meta;
  txt.innerHTML = '';
  if (!ing) { txt.append('Todavía no hay ingresos registrados este mes.'); return; }
  txt.append('Entraron ', el('b', {}, gs(ing)), ' y gastaste ', el('b', {}, gs(gastado)), '. ');
  if (!meta) txt.append('Definí una meta de ahorro (arriba a la derecha) y te digo cuánto podés gastar por día.');
  else if (disponible > 0) txt.append(`Para ahorrar ${gs(meta)} este mes, podés gastar `, el('b', {}, gs(disponible / quedan) + ' por día'), ` los próximos ${quedan} días.`);
  else txt.append('Con lo que entró hasta hoy, ya gastaste ', el('b', {}, gs(-disponible)), ' más de lo que permite la meta. Si todavía falta cobrar (sueldo, clientes), esto mejora cuando entre.');
}

$('#btnMeta').addEventListener('click', async () => {
  const actual = Number(state.ia.metaAhorro) || 0;
  const r = prompt('Meta de ahorro mensual (Gs). Dejá vacío para quitarla:', actual ? fmt.format(actual) : '');
  if (r === null) return;
  const meta = soloDigitos(r);
  try {
    const x = await apiPost({ accion: 'ajuste', clave: 'meta_ahorro', valor: meta });
    if (!x.ok) throw new Error(x.error);
    state.ia = x.ajustes;
    await store.set('ia', state.ia);
    firmas.inicio = '';
    render();
    toast(meta ? `Meta de ahorro: ${gs(meta)}` : 'Meta quitada');
  } catch (err) { toast('No se pudo guardar: ' + err.message); }
});

async function pedirIA(cuerpo, destino) {
  if (!state.online || !conectado()) return toast('Necesitás conexión');
  destino.hidden = false;
  destino.classList.add('cargando');
  destino.textContent = '✨ Pensando…';
  try {
    const r = await apiPost(cuerpo);
    if (!r.ok) throw new Error(r.error);
    destino.textContent = r.respuesta;
  } catch (err) {
    destino.textContent = 'No se pudo: ' + err.message;
  } finally {
    destino.classList.remove('cargando');
  }
}

const EJEMPLOS_SIMULAR = ['¿Y si dejo de pedir delivery?', '¿Y si gasto la mitad en restaurantes?', '¿Y si cancelo Netflix y Spotify?', '¿Y si cargo combustible una vez menos por semana?'];
const EJEMPLOS_PREGUNTA = ['¿Cuánto gasté en restaurantes este mes?', '¿Qué cliente me pagó más?', '¿En qué gasté más que el mes pasado?', '¿Cuánto pago de suscripciones?'];

function renderTarjetasIA() {
  const ia = state.ia || {};
  $('#btnConsejo').hidden = !ia.disponible;
  $('#cardPreguntar').hidden = !ia.disponible;
  $('#cardSimular').hidden = !ia.disponible;
  $('#btnExplicar').hidden = !ia.disponible;
  if (!$('#ejemplosSimular').children.length) {
    $('#ejemplosSimular').replaceChildren(...EJEMPLOS_SIMULAR.map((p) => el('button', { type: 'button', class: 'chip', onclick: () => { $('#fEscenario').value = p; $('#formSimular').requestSubmit(); } }, p)));
  }
  const r = ia.resumen;
  $('#cardResumen').hidden = !(ia.disponible && r && r.texto);
  if (r && r.texto) {
    $('#resumenTxt').textContent = state.discreto ? r.texto.replace(/(Gs\.?\s*)?\d[\d.,]{3,}/g, 'Gs •••') : r.texto;
    $('#resumenFecha').textContent = r.fecha ? new Date(r.fecha.replace(' ', 'T')).toLocaleDateString('es-PY', { day: 'numeric', month: 'short' }) : '';
  }
  if (!$('#ejemplosPregunta').children.length) {
    $('#ejemplosPregunta').replaceChildren(...EJEMPLOS_PREGUNTA.map((p) => el('button', { type: 'button', class: 'chip', onclick: () => { $('#fPregunta').value = p; $('#formPregunta').requestSubmit(); } }, p)));
  }
}
$('#btnConsejo').addEventListener('click', () => pedirIA({ accion: 'consejo', mes: state.mes }, $('#consejoTxt')));
$('#btnExplicar').addEventListener('click', () => pedirIA({ accion: 'explicar', mes: state.mes }, $('#explicaTxt')));
$('#formSimular').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const escenario = $('#fEscenario').value.trim();
  if (escenario) pedirIA({ accion: 'simular', escenario }, $('#simulaTxt'));
});
$('#formPregunta').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const pregunta = $('#fPregunta').value.trim();
  if (pregunta) pedirIA({ accion: 'preguntar', pregunta }, $('#respuestaTxt'));
});

/** Suscripciones: último cobro de cada una, cuánto suman por mes y si alguna subió de precio. */
function renderSuscripciones() {
  const desde = moverMes(mesActual(), -2) + '-01';
  const susc = gastosTodos().filter((g) => g.categoria === 'Suscripciones' && g.fecha >= desde);
  const grupos = new Map();
  for (const g of susc.sort((a, b) => a.fecha.localeCompare(b.fecha))) {
    const nombre = nombreBonito(g.comercio).split(/[\s*]/).filter((w) => w.length > 1)[0] || g.comercio;
    const k = normalizar(nombre);
    const x = grupos.get(k) || { nombre, cobros: [] };
    x.cobros.push(g);
    grupos.set(k, x);
  }
  const filas = [...grupos.values()].map((x) => {
    const ultimo = x.cobros.at(-1);
    const previo = x.cobros.at(-2);
    const sube = previo && ultimo.monto > previo.monto * 1.05 ? Math.round(((ultimo.monto - previo.monto) / previo.monto) * 100) : 0;
    return { ...x, ultimo, sube };
  }).sort((a, b) => b.ultimo.monto - a.ultimo.monto);
  $('#suscTotal').textContent = filas.length ? `≈ ${gs(suma(filas.map((f) => f.ultimo)))} por mes` : '';
  renderSuscNuevas();
  const ul = $('#listaSusc');
  if (!filas.length) { ul.replaceChildren(el('li', { class: 'vacio-grafico', style: 'display:block' }, 'Sin suscripciones en los últimos meses.')); return; }
  ul.replaceChildren(...filas.map((f) => el('li', {},
    el('span', { class: 'rank', style: fondoIcono(colorDe('Suscripciones')) }, iconoDe('Suscripciones')),
    el('div', { class: 'info' }, el('div', {}, f.nombre),
      el('small', { class: f.sube ? 'susc-sube' : '' }, f.sube ? `↑ subió ${f.sube}%` : `último: ${etiquetaDia(f.ultimo.fecha.slice(0, 10))}`)),
    el('div', { class: 'der' }, el('b', {}, gs(f.ultimo.monto)), el('small', {}, `${f.cobros.length} cobro${f.cobros.length === 1 ? '' : 's'}`)),
  )));
}

// ---------- Pronóstico, suscripciones nuevas y quincena ----------

const GASTO_PUNTUAL = 1000000; // un gasto así de grande no marca el ritmo diario (préstamos, compras grandes)
const claveMarca = (comercio) => normalizar(nombreBonito(comercio).split(/[\s*]/).filter((w) => w.length > 1)[0] || comercio);

/** Pronóstico a fin de mes: lo gastado + ritmo diario de lo variable + suscripciones del mes pasado que todavía no se cobraron. */
function pronostico(todos, mes) {
  const actuales = delMes(todos, mes);
  const dias = diasDelMes(mes);
  const hechos = diasTranscurridos(mes);
  const total = suma(actuales);
  const variable = actuales.filter((g) => g.categoria !== 'Suscripciones' && g.monto < GASTO_PUNTUAL);
  const ritmo = hechos ? suma(variable) / hechos : 0;
  const cobradas = new Set(actuales.filter((g) => g.categoria === 'Suscripciones').map((g) => claveMarca(g.comercio)));
  const pendientes = new Map();
  for (const g of delMes(todos, moverMes(mes, -1))) {
    const k = claveMarca(g.comercio);
    if (g.categoria === 'Suscripciones' && !cobradas.has(k) && !pendientes.has(k)) pendientes.set(k, g);
  }
  const fijos = [...pendientes.values()];
  const restantes = Math.max(0, dias - hechos);
  return { total: total + ritmo * restantes + suma(fijos), ritmo, restantes, fijos };
}

function renderPronostico(p, ingresosMes) {
  const caja = $('#pronosticoTxt');
  caja.hidden = !p;
  if (!p) return;
  caja.innerHTML = '';
  caja.append('📈 Pronóstico a fin de mes: ', el('b', {}, gs(p.total)), `. Ritmo de ${gs(p.ritmo)} por día los próximos ${p.restantes} días`);
  if (p.fijos.length) {
    const nombres = p.fijos.map((g) => nombreBonito(g.comercio).split(/[\s*]/)[0]).slice(0, 4).join(', ');
    caja.append(' + suscripciones por cobrar (', el('b', {}, gs(suma(p.fijos))), `: ${nombres}${p.fijos.length > 4 ? '…' : ''})`);
  }
  caja.append('.');
  if (ingresosMes) {
    const queda = ingresosMes - p.total;
    caja.append(' Con lo que entró hasta hoy, cerrarías ', el('b', { class: queda >= 0 ? 'positivo' : 'negativo' }, (queda >= 0 ? '+' : '−') + gs(Math.abs(queda))), '.');
  }
}

/** Una vez por día pide al servidor los cobros mensuales que parecen suscripciones y no lo están. */
async function cargarSuscNuevas(forzar) {
  if (!conectado() || !state.online) return;
  const hoy = ahoraLocal().slice(0, 10);
  const guardado = await store.get('suscNuevas');
  if (!forzar && guardado?.fecha === hoy) { state.suscNuevas = guardado.lista; return; }
  try {
    const r = await apiPost({ accion: 'suscripcionesNuevas' });
    if (!r.ok) return;
    state.suscNuevas = r.candidatos || [];
    await store.set('suscNuevas', { fecha: hoy, lista: state.suscNuevas });
    firmas.inicio = '';
    render();
  } catch { /* sin conexión: se reintenta en la próxima sincronización */ }
}

function renderAlertaSusc() {
  const n = state.suscNuevas.length;
  $('#alertaSusc').hidden = !n || state.mes !== mesActual();
  $('#alertaSuscTit').textContent = n === 1
    ? `¿${state.suscNuevas[0].nombre || nombreBonito(state.suscNuevas[0].comercio)} es una suscripción?`
    : `${n} posibles suscripciones nuevas`;
}
$('#alertaSusc').addEventListener('click', () => cambiarVista('presupuesto'));

function renderSuscNuevas() {
  const caja = $('#suscNuevas');
  caja.hidden = !state.suscNuevas.length;
  caja.replaceChildren(
    el('div', { class: 'susc-nuevas-tit' }, '✨ Posibles suscripciones nuevas'),
    ...state.suscNuevas.map((c) => el('div', { class: 'susc-nueva' },
      el('div', { class: 'info' },
        el('b', {}, c.nombre || nombreBonito(c.comercio)),
        el('small', {}, `${gs(c.monto)} por mes · ${c.meses} meses seguidos${c.motivo ? ' · ' + c.motivo : ''}`)),
      el('div', { class: 'botones' },
        el('button', { class: 'btn primario chico', type: 'button', onclick: () => resolverSusc(c, true) }, 'Sí'),
        el('button', { class: 'btn chico', type: 'button', onclick: () => resolverSusc(c, false) }, 'No')),
    )),
  );
}

async function resolverSusc(c, es) {
  vibrar(8);
  state.suscNuevas = state.suscNuevas.filter((x) => x.clave !== c.clave);
  await store.set('suscNuevas', { fecha: ahoraLocal().slice(0, 10), lista: state.suscNuevas });
  firmas.inicio = '';
  if (es) {
    const g = gastosTodos().find((x) => x.id === c.id);
    if (g) {
      const { pendiente, ...gasto } = g;
      const nuevo = { ...gasto, categoria: 'Suscripciones' };
      await encolar({ accion: 'guardar', gasto: nuevo });
      abrirRegla(nuevo); // ofrece la regla y cambiar los cobros anteriores
    }
  } else {
    let descartadas = [];
    try { descartadas = JSON.parse(localStorageGet('suscDescartadas') || '[]'); } catch { /* vacío */ }
    descartadas = [...new Set([...descartadas, c.clave])];
    localStorageSet('suscDescartadas', JSON.stringify(descartadas));
    apiPost({ accion: 'ajuste', clave: 'susc_descartadas', valor: JSON.stringify(descartadas) }).catch(() => {});
    toast('Listo, no te lo vuelvo a preguntar');
  }
  render();
}

/** Sueldo de SERCON: quincena (14/15) y fin de mes (28). GNB no avisa el depósito, así que se pregunta. */
const PAGOS_SUELDO = [{ dia: 14, nombre: 'la quincena', monto: 3600000 }, { dia: 28, nombre: 'el sueldo de fin de mes', monto: 6600000 }];
let sueldoPendiente = null;

function renderAlertaSueldo(ingresos) {
  sueldoPendiente = null;
  const hoyTxt = ahoraLocal().slice(0, 10);
  const hoy = new Date(hoyTxt + 'T12:00');
  if (state.mes !== mesActual() || localStorageGet('sueldoNo') === hoyTxt) { $('#alertaSueldo').hidden = true; return; }
  const sueldos = ingresos.filter((i) => i.categoria === 'Sueldo');
  for (const delta of [0, -1]) {
    const mes = moverMes(mesActual(), delta);
    for (const p of PAGOS_SUELDO) {
      const fecha = new Date(`${mes}-${String(p.dia).padStart(2, '0')}T12:00`);
      const dif = (hoy - fecha) / 86400000;
      if (dif < 0 || dif > 6) continue; // se pregunta desde el día de cobro y hasta 6 días después
      const desde = new Date(fecha.getTime() - 4 * 86400000).toISOString().slice(0, 10);
      const hasta = new Date(fecha.getTime() + 7 * 86400000).toISOString().slice(0, 10);
      const ya = sueldos.some((i) => i.fecha.slice(0, 10) >= desde && i.fecha.slice(0, 10) <= hasta);
      if (ya) continue;
      const anterior = sueldos.filter((i) => Math.abs(Number(i.fecha.slice(8, 10)) - p.dia) <= 4).sort((a, b) => b.fecha.localeCompare(a.fecha))[0];
      sueldoPendiente = { ...p, monto: anterior?.monto || p.monto };
    }
  }
  $('#alertaSueldo').hidden = !sueldoPendiente;
  if (sueldoPendiente) $('#alertaSueldoTit').textContent = `¿Cobraste ${sueldoPendiente.nombre} de SERCON?`;
}
$('#alertaSueldo').addEventListener('click', (ev) => {
  if (ev.target.closest('#alertaSueldoNo')) {
    localStorageSet('sueldoNo', ahoraLocal().slice(0, 10));
    $('#alertaSueldo').hidden = true;
    toast('Te vuelvo a preguntar mañana');
    return;
  }
  if (!sueldoPendiente) return;
  abrirIngreso(null, { categoria: 'Sueldo', pagador: 'SERCON S.A.', monto: sueldoPendiente.monto });
});

// ---------- Ingresos ----------

function etiquetaDia(dia) {
  const hoy = ahoraLocal().slice(0, 10);
  const d = new Date(); d.setDate(d.getDate() - 1); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  if (dia === hoy) return 'Hoy';
  if (dia === d.toISOString().slice(0, 10)) return 'Ayer';
  const [a, m, dd] = dia.split('-').map(Number);
  return new Date(a, m - 1, dd).toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'short' });
}

function renderIngresos() {
  const lista = delMes(ingresosTodos(), state.mes);
  $('#ingCant').textContent = `${lista.length} ingreso${lista.length === 1 ? '' : 's'}`;
  $('#ingTotal').textContent = '+' + gs(suma(lista));
  $('#ingDesglose').replaceChildren(...CATS_INGRESO.map((c) =>
    el('span', { class: 'mini-chip' }, `${iconoDe(c)} ${c}`, el('b', {}, gs(suma(lista.filter((i) => i.categoria === c)))))));
  const dias = new Map();
  for (const i of lista) {
    const d = i.fecha.slice(0, 10);
    if (!dias.has(d)) dias.set(d, []);
    dias.get(d).push(i);
  }
  $('#listaIng').replaceChildren(...[...dias].map(([dia, items]) => el('div', { class: 'grupo-dia' },
    el('div', { class: 'cab-dia' }, el('span', {}, etiquetaDia(dia)), el('span', { class: 'positivo' }, '+' + gs(suma(items)))),
    el('ul', { class: 'mov-lista' }, items.map((i) => el('li', { class: 'mov', onclick: () => abrirIngreso(i) },
      el('span', { class: 'ico', style: 'background:var(--ingreso-soft)' }, iconoDe(i.categoria)),
      el('div', { class: 'info' },
        el('div', { class: 'com' }, nombreBonito(i.pagador) || 'Sin nombre'),
        el('div', { class: 'meta' }, [i.categoria, i.banco, i.fecha.slice(11, 16)].filter(Boolean).join(' · ')),
      ),
      el('div', { class: 'monto ing' }, '+' + gs(i.monto), i.pendiente ? el('small', {}, 'pendiente') : null),
    ))),
  )));
  $('#vacioIng').hidden = lista.length > 0;
}

const formIng = { editando: null, categoria: 'Ventas' };

function abrirIngreso(i = null, sugerido = null) {
  formIng.editando = i;
  formIng.categoria = i?.categoria || sugerido?.categoria || 'Ventas';
  $('#ingTitulo').textContent = i ? 'Ingreso' : sugerido ? 'Confirmar sueldo' : 'Nuevo ingreso';
  $('#iMonto').value = i ? fmt.format(i.monto) : sugerido?.monto ? fmt.format(sugerido.monto) : '';
  $('#iPagador').value = i?.pagador || sugerido?.pagador || '';
  $('#iFecha').value = i ? i.fecha.replace(' ', 'T') : (state.mes === mesActual() ? ahoraLocal() : state.mes + '-01T12:00');
  $('#btnBorrarIng').hidden = !i;
  pintarCatsIngreso();
  abrirHoja($('#hojaIngreso'));
}
function pintarCatsIngreso() {
  $('#iCats').replaceChildren(...CATS_INGRESO.map((c) => el('button', {
    type: 'button', class: 'cat-chip' + (c === formIng.categoria ? ' activo' : ''),
    onclick: () => { formIng.categoria = c; vibrar(5); pintarCatsIngreso(); },
  }, el('span', { class: 'e' }, iconoDe(c)), el('span', {}, c))));
}
$('#iMonto').addEventListener('input', (e) => { const n = soloDigitos(e.target.value); e.target.value = n ? fmt.format(n) : ''; });
$('#formIngreso').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const monto = soloDigitos($('#iMonto').value);
  if (!monto) return toast('Ingresá un monto');
  const i = formIng.editando;
  const ingreso = {
    id: i?.id || uuid(),
    fecha: ($('#iFecha').value || ahoraLocal()).replace('T', ' ').slice(0, 16),
    monto,
    pagador: $('#iPagador').value.trim(),
    categoria: formIng.categoria,
    banco: i?.banco || '',
    origen: i?.origen || 'manual',
  };
  cerrarHoja($('#hojaIngreso'));
  vibrar(12);
  await encolar({ accion: 'ingreso', ingreso });
  toast(`Ingreso ${i ? 'actualizado' : 'guardado'}: ${gs(monto)} · ${ingreso.categoria}`);
});
$('#btnBorrarIng').addEventListener('click', async () => {
  const i = formIng.editando;
  if (!i || !confirm(`¿Quitar el ingreso de ${gs(i.monto)} de ${i.pagador || 'sin nombre'}?`)) return;
  cerrarHoja($('#hojaIngreso'));
  await encolar({ accion: 'borrarIngreso', id: i.id });
  toast('Ingreso quitado');
});
$('#btnNuevoIngreso').addEventListener('click', () => abrirIngreso());
for (const b of $$('.segmento button')) {
  b.addEventListener('click', () => { state.modoMov = b.dataset.modo; vibrar(5); renderMovimientos(); animarEntrada('entra'); });
}

// ---------- Por revisar ----------

const nombreDestinatario = (g) => nombreBonito(g.comercio).replace(/^Transferencia a /i, '');

function abrirRevisar() {
  const pendientes = gastosTodos().filter((g) => g.categoria === POR_REVISAR);
  if (!pendientes.length) {
    if (!$('#hojaRevisar').hidden) cerrarHoja($('#hojaRevisar'));
    toast('No quedan transferencias por revisar ✓');
    return;
  }
  const cats = state.config.categorias.map((c) => c.nombre);
  const elegir = new Map(); // id -> función para preseleccionar una categoría (la usa la sugerencia de la IA)
  $('#listaRevisar').replaceChildren(...pendientes.map((g) => {
    const nombre = nombreDestinatario(g);
    // Personas "a consultar siempre" (ej. Marcela): nunca se recuerda una regla, cada transferencia se decide.
    const siempre = (state.ia.consultarSiempre || []).some((n) => coincidePatron(nombre, n) || coincidePatron(n, nombre));
    let elegida = '';
    const marcar = (c) => {
      elegida = c;
      for (const x of chips.children) x.classList.toggle('activo', x.dataset.cat === c);
      btnGuardar.disabled = false;
    };
    const chips = el('div', { class: 'cat-chips' }, cats.map((c) => el('button', {
      type: 'button', class: 'cat-chip', 'data-cat': c,
      onclick: () => { vibrar(5); marcar(c); },
    }, el('span', { class: 'e' }, iconoDe(c)), el('span', {}, c))));
    const recordar = el('input', { type: 'checkbox', checked: !siempre });
    const btnGuardar = el('button', { type: 'button', class: 'btn primario', disabled: true, onclick: () => resolverRevisar(g, elegida, recordar.checked) }, 'Guardar');
    const sugerencia = el('div', { class: 'sugerencia-ia', hidden: true });
    elegir.set(g.id, (s) => { marcar(s.categoria); sugerencia.hidden = false; sugerencia.textContent = `✨ Sugerido: ${s.categoria}${s.motivo ? ' — ' + s.motivo : ''}`; });
    return el('div', { class: 'rev-item' },
      el('div', { class: 'rev-cab' }, el('b', {}, nombre), el('span', { class: 'm' }, gs(g.monto)),
        el('small', {}, [etiquetaDia(g.fecha.slice(0, 10)), g.fecha.slice(11, 16), g.tarjeta].filter(Boolean).join(' · '))),
      sugerencia,
      chips,
      siempre
        ? el('p', { class: 'ayuda' }, 'Con esta persona siempre se consulta: no se crea regla.')
        : el('label', { class: 'check' }, recordar, el('span', {}, `Recordar para ${nombre.split(' ').slice(0, 2).join(' ')}`)),
      el('div', { class: 'rev-acciones' },
        el('button', { type: 'button', class: 'btn', onclick: () => resolverRevisar(g, '', recordar.checked) }, 'No es gasto'),
        btnGuardar),
    );
  }));
  if ($('#hojaRevisar').hidden) abrirHoja($('#hojaRevisar'));
  // Sugerencias de la IA (si está configurada): preseleccionan la categoría, el usuario confirma.
  if (state.ia.disponible && state.online && conectado()) {
    apiPost({ accion: 'sugerencias' })
      .then((r) => { for (const s of (r.ok && r.sugerencias) || []) elegir.get(s.id)?.(s); })
      .catch(() => { /* sin sugerencias: se clasifica a mano */ });
  }
}

/** categoria vacía = no es gasto. Con "recordar", crea la regla y resuelve igual las otras del mismo destinatario. */
async function resolverRevisar(g, categoria, recordar) {
  const nombre = nombreDestinatario(g);
  const mismos = recordar ? gastosTodos().filter((x) => x.categoria === POR_REVISAR && nombreDestinatario(x) === nombre) : [g];
  vibrar(10);
  if (recordar) await encolar({ accion: 'destinatario', regla: { nombre, accion: categoria ? 'gasto' : 'ignorar', categoria } });
  for (const x of mismos) {
    const { pendiente, ...gasto } = x;
    if (categoria) await encolar({ accion: 'guardar', gasto: { ...gasto, categoria } });
    else await encolar({ accion: 'borrar', id: x.id });
  }
  toast(categoria ? `${nombre} → ${categoria}${recordar ? ' (recordado)' : ''}` : `${nombre}: no es gasto${recordar ? ' (recordado)' : ''}`);
  abrirRevisar();
}
$('#alertaRevisar').addEventListener('click', abrirRevisar);

// ---------- Presupuesto ----------

function renderPresupuesto() {
  const actuales = delMes(gastosTodos(), state.mes).filter(contable);
  renderSuscripciones();
  if (sinCambios('presupuesto', state.mes, firmaDatos(actuales), state.config, state.discreto)) return;
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

function renderDestinatarios() {
  const reglas = state.config.destinatarios || [];
  const ul = $('#listaDestinatarios');
  if (!reglas.length) { ul.replaceChildren(el('li', { class: 'vacio-grafico', style: 'display:block' }, 'Todavía no hay reglas.')); return; }
  ul.replaceChildren(...reglas.map((r) => {
    const ignorar = r.accion === 'ignorar';
    const det = ignorar ? 'No es gasto'
      : [r.categoria || 'Transferencias', r.etiqueta ? `"${r.etiqueta}"` : '', r.limite ? `más de ${gs(r.limite)} no es gasto` : ''].filter(Boolean).join(' · ');
    return el('li', {},
      el('span', { class: 'ico', style: ignorar ? 'background:var(--card-2)' : fondoIcono(colorDe(r.categoria)) }, ignorar ? '🚫' : iconoDe(r.categoria)),
      el('div', {}, el('div', { class: 'nom' }, r.nombre), el('div', { class: 'det' }, det)),
      el('button', { class: 'quitar', type: 'button', 'aria-label': 'Quitar regla', onclick: async () => {
        if (!confirm(`¿Quitar la regla de ${r.nombre}? Las próximas transferencias a esa persona van a ir a "Por revisar".`)) return;
        const destinatarios = reglas.filter((x) => x !== r);
        state.config = { ...state.config, destinatarios };
        await store.set('config', state.config);
        await encolar({ accion: 'config', config: { destinatarios } });
        renderDestinatarios();
      } }, '×'),
    );
  }));
}

function renderAjustes() {
  renderEstadoSistema();
  renderDestinatarios();
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
  $('#fEtiqueta').value = g?.etiqueta || '';
  $('#fTercero').value = g?.tercero || '';
  $('#btnBorrar').hidden = !g;
  const unicos = (k) => [...new Set(gastosTodos().map((x) => x[k]).filter(Boolean))];
  $('#etiquetas').replaceChildren(...unicos('etiqueta').map((t) => el('option', { value: t })));
  $('#terceros').replaceChildren(...unicos('tercero').map((t) => el('option', { value: t })));
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
    etiqueta: $('#fEtiqueta').value.trim(),
    tercero: $('#fTercero').value.trim(),
  };
  const parecido = !g && gastoParecido(gasto);
  if (parecido && !confirm(`Ya hay un gasto de ${gs(parecido.monto)} en ${nombreBonito(parecido.comercio) || 'sin comercio'} a las ${parecido.fecha.slice(11, 16)}` +
    `${fuenteLegible(parecido.origen) ? ` (entró por ${fuenteLegible(parecido.origen)})` : ''}.\n\n¿Guardar este de todos modos?`)) return;
  if (gasto.tarjeta) localStorageSet('ultimaTarjeta', gasto.tarjeta);
  state.recienGuardado = gasto.id;
  setTimeout(() => { state.recienGuardado = ''; }, 1500);
  // Si elegiste a mano una categoría distinta de la que darían las reglas, ofrecer recordarla.
  const aprender = form.manual && gasto.comercio && gasto.categoria !== categorizar(gasto.comercio) && (!g || g.categoria !== gasto.categoria);
  cerrarHoja($('#hoja'));
  vibrar(12);
  await encolar({ accion: 'guardar', gasto });
  toast(`${g ? 'Actualizado' : 'Guardado'}: ${gs(monto)} · ${gasto.tercero ? 'pagado por ' + gasto.tercero + ' (no suma)' : gasto.categoria}`);
  if (aprender) abrirRegla(gasto);
  if (!gasto.fecha.startsWith(state.mes)) { state.mes = gasto.fecha.slice(0, 7); render(); }
});

$('#btnBorrar').addEventListener('click', async () => {
  const g = form.editando;
  if (!g || !confirm(`¿Borrar ${gs(g.monto)} en ${g.comercio || 'sin comercio'}?`)) return;
  cerrarHoja($('#hoja'));
  await encolar({ accion: 'borrar', id: g.id });
  toast('Gasto borrado');
});

// ---------- Reglas que aprenden ----------

let reglaCtx = null;

/** "PETROBRAS SHAH 43 ASUNCION" -> "Petrobras"; "Transferencia a Liana Monserrat Martinez" -> "Liana Monserrat". */
function sugerirPatron(comercio) {
  const esTransf = /^transferencia a /i.test(comercio);
  const palabras = nombreBonito(comercio).replace(/^transferencia a /i, '').split(/\s+/).filter((w) => w && !/\d/.test(w));
  if (esTransf) return palabras.slice(0, 2).join(' ');
  const largas = palabras.filter((w) => w.length > 2);
  if (!largas.length) return palabras.join(' ');
  return largas[0].length >= 4 ? largas[0] : largas.slice(0, 2).join(' ');
}

function similaresA(patron, categoria) {
  return gastosTodos().filter((x) => x.id !== reglaCtx?.id && x.categoria !== categoria && coincidePatron(x.comercio, patron));
}

function abrirRegla(gasto) {
  reglaCtx = gasto;
  $('#fPatron').value = sugerirPatron(gasto.comercio);
  $('#reglaCategoria').textContent = `${iconoDe(gasto.categoria)} ${gasto.categoria}`;
  actualizarAplicar();
  setTimeout(() => abrirHoja($('#hojaRegla')), 450); // después de que se cierre la hoja del gasto
}

function actualizarAplicar() {
  const n = similaresA($('#fPatron').value, reglaCtx.categoria).length;
  $('#reglaAplicarFila').hidden = !n;
  $('#reglaAplicarTxt').textContent = `Cambiar también ${n} gasto${n === 1 ? '' : 's'} anterior${n === 1 ? '' : 'es'} con ese comercio`;
}
$('#fPatron').addEventListener('input', actualizarAplicar);

$('#formRegla').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const patron = $('#fPatron').value.trim();
  if (!patron) return;
  const categoria = reglaCtx.categoria;
  const aplicar = $('#fAplicar').checked ? similaresA(patron, categoria) : [];
  const cfg = structuredClone(state.config);
  // la regla nueva va primero: gana sobre las anteriores que coincidan
  cfg.reglas = [{ patron, categoria }, ...cfg.reglas.filter((r) => normalizar(r.patron) !== normalizar(patron))];
  state.config = cfg;
  state.borrador = null;
  await store.set('config', cfg);
  cerrarHoja($('#hojaRegla'));
  vibrar(10);
  await encolar({ accion: 'config', config: cfg });
  for (const x of aplicar) {
    const { pendiente, ...gasto } = x;
    await encolar({ accion: 'guardar', gasto: { ...gasto, categoria } });
  }
  toast(`Regla creada: "${patron}" → ${categoria}${aplicar.length ? ` · ${aplicar.length} gasto${aplicar.length === 1 ? '' : 's'} actualizado${aplicar.length === 1 ? '' : 's'}` : ''}`);
});

// ---------- Estado del sistema ----------

const CADA_CUANTO_ESTADO = 3 * 60 * 60 * 1000; // revisar solo cada 3 horas al abrir la app

function hace(fecha, ahora) {
  if (!fecha) return 'nunca';
  const min = Math.round(minutos(ahora) - minutos(fecha));
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.round(min / 60)} h`;
  const d = Math.round(min / 1440);
  return `hace ${d} día${d === 1 ? '' : 's'}`;
}
const diasDesde = (fecha, ahora) => (fecha ? (minutos(ahora) - minutos(fecha)) / 1440 : Infinity);

/** Convierte el estado del servidor en filas con semáforo. */
function filasEstado(e) {
  const filas = [];
  const minLectura = e.lecturaCorreos ? minutos(e.ahora) - minutos(e.lecturaCorreos) : Infinity;
  filas.push({
    nombre: 'Lectura automática de mails',
    cuando: hace(e.lecturaCorreos, e.ahora),
    nivel: minLectura <= 30 ? 'ok' : 'mal',
    nota: minLectura <= 30 ? 'Revisa Familiar y GNB cada 10 minutos' : 'Está detenida: los mails del banco no se leen',
  });
  filas.push({ nombre: 'Último aviso por mail', cuando: hace(e.mail, e.ahora), nivel: 'gris', nota: 'Transferencias y pagos de servicios' });
  const fuente = (nombre, fecha, dias, nota) => {
    const d = diasDesde(fecha, e.ahora);
    filas.push({ nombre, cuando: hace(fecha, e.ahora), nivel: d <= dias ? 'ok' : 'aviso', nota: d <= dias ? nota : `Sin avisos hace más de ${dias} días. Si usaste esa tarjeta, revisá la automatización` });
  };
  fuente('Apple Pay', e.applepay, 7, 'Automatización "Transacción"');
  fuente('SMS GNB', e.smsGnb, 10, 'Automatización "SMS GNB"');
  fuente('SMS Continental', e.smsContinental, 10, 'Automatización "SMS Continental"');
  const dRespaldo = diasDesde(e.respaldo, e.ahora);
  filas.push({ nombre: 'Respaldo semanal', cuando: hace(e.respaldo, e.ahora), nivel: dRespaldo <= 8 ? 'ok' : 'aviso', nota: 'Copia en Drive cada domingo' });
  filas.push({ nombre: 'Errores (7 días)', cuando: String(e.errores), nivel: e.errores ? 'mal' : 'ok', nota: e.errores ? 'Mirá "Últimos avisos procesados"' : 'Sin errores' });
  const pend = state.cola.length;
  filas.push({ nombre: 'Pendientes en este dispositivo', cuando: String(pend), nivel: pend ? 'aviso' : 'ok', nota: pend ? 'Se envían cuando haya conexión' : 'Todo enviado' });
  return filas;
}

async function cargarEstado() {
  if (!conectado() || !state.online) return;
  try {
    const r = await apiGet({ estado: 1 });
    if (!r.ok) throw new Error(r.error);
    state.estadoSis = r.estado;
    localStorageSet('estadoSis', JSON.stringify({ t: Date.now(), e: r.estado }));
  } catch (err) {
    console.warn('No se pudo leer el estado', err);
  }
  renderEstadoSistema();
  if (state.vista === 'inicio') renderAlertaSistema();
}

function renderEstadoSistema() {
  const e = state.estadoSis;
  const ul = $('#listaEstado');
  if (!e) { ul.replaceChildren(el('li', { class: 'vacio-grafico' }, conectado() ? 'Cargando…' : 'Conectá la app para ver el estado.')); return; }
  ul.replaceChildren(...filasEstado(e).map((f) => el('li', { class: 'fila-estado' },
    el('span', { class: 'luz ' + (f.nivel === 'ok' ? '' : f.nivel) }),
    el('div', { class: 'nom' }, f.nombre, el('span', { class: 'nota' }, f.nota)),
    el('span', { class: 'cuando' }, f.cuando),
  )));
  $('#listaAvisos').replaceChildren(...(e.ultimosAvisos || []).map((a) => el('li', {},
    el('div', { class: 'cab-aviso' }, el('span', {}, `${(NOMBRES_FUENTE[a.fuente] || a.fuente)} · ${a.resultado}`), el('span', {}, hace(a.fecha, e.ahora))),
    el('div', { class: 'det' }, state.discreto ? a.detalle.replace(/\d[\d.,]{2,}/g, '•••') : a.detalle),
  )));
}

function renderAlertaSistema() {
  const e = state.estadoSis;
  const malas = e ? filasEstado(e).filter((f) => f.nivel === 'mal') : [];
  $('#alertaSistema').hidden = !malas.length;
  if (malas.length) {
    $('#alertaSistemaTit').textContent = malas[0].nombre;
    $('#alertaSistemaSub').textContent = malas[0].nota;
  }
}
$('#alertaSistema').addEventListener('click', () => cambiarVista('ajustes'));
$('#btnEstado').addEventListener('click', () => { $('#listaEstado').replaceChildren(el('li', { class: 'vacio-grafico' }, 'Actualizando…')); cargarEstado(); });

// ---------- Modo discreto ----------

function aplicarDiscreto() {
  document.body.classList.toggle('discreto', state.discreto);
  $('#btnDiscreto').setAttribute('aria-pressed', String(state.discreto));
  $('#btnDiscreto').setAttribute('aria-label', state.discreto ? 'Mostrar montos' : 'Ocultar montos');
}
$('#btnDiscreto').addEventListener('click', () => {
  state.discreto = !state.discreto;
  localStorageSet('discreto', state.discreto ? '1' : '');
  vibrar(6);
  aplicarDiscreto();
  for (const k of Object.keys(firmas)) firmas[k] = '';
  render();
  if (state.vista === 'ajustes') renderEstadoSistema();
});

// ---------- CSV ----------

function aCsv(gastos) {
  const cols = ['fecha', 'monto', 'comercio', 'tarjeta', 'categoria', 'origen', 'etiqueta', 'tercero'];
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
  if (ir) {
    if (ir.dataset.ir === 'ingresos') { state.modoMov = 'ingresos'; cambiarVista('movimientos'); renderMovimientos(); return; }
    if (ir.dataset.ir === 'movimientos') { state.filtroCat = ''; state.modoMov = 'gastos'; }
    cambiarVista(ir.dataset.ir);
  }
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
    cargarEstado();
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
state.ingresos = (await store.get('ingresos:todos')) || [];
state.ia = (await store.get('ia')) || state.ia;
state.suscNuevas = (await store.get('suscNuevas'))?.lista || [];
state.cola = await store.cola();
state.discreto = localStorageGet('discreto') === '1';
aplicarDiscreto();
try {
  const guardado = JSON.parse(localStorageGet('estadoSis') || 'null');
  if (guardado) state.estadoSis = guardado.e;
  if (!guardado || Date.now() - guardado.t > CADA_CUANTO_ESTADO) setTimeout(cargarEstado, 4000);
} catch { /* sin estado guardado */ }
render();
animarEntrada('entra');
sincronizar();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW no registrado', err));
}
