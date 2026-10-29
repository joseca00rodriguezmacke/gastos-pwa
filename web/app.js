// Gastos PWA — lógica de la app (vanilla JS, sin dependencias).

const CONFIG_INICIAL = {
  categorias: [
    { nombre: 'Supermercado', color: '#16a34a' },
    { nombre: 'Restaurantes', color: '#ea580c' },
    { nombre: 'Combustible', color: '#ca8a04' },
    { nombre: 'Transporte', color: '#0891b2' },
    { nombre: 'Servicios', color: '#2563eb' },
    { nombre: 'Salud', color: '#dc2626' },
    { nombre: 'Suscripciones', color: '#7c3aed' },
    { nombre: 'Hogar', color: '#a16207' },
    { nombre: 'Ocio', color: '#db2777' },
    { nombre: 'Otros', color: '#64748b' },
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
const COLOR_DEFECTO = '#64748b';

const $ = (sel) => document.querySelector(sel);
const fmt = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 });
const gs = (n) => 'Gs ' + fmt.format(Math.round(n || 0));

const state = {
  mes: mesActual(),
  vista: 'gastos',
  conexion: { url: '', token: '' },
  gastos: [],        // gastos del mes según el servidor (o caché)
  config: structuredClone(CONFIG_INICIAL),
  borrador: null,    // copia editable de config en Ajustes
  cola: [],          // operaciones pendientes de enviar
  online: navigator.onLine,
  sincronizando: false,
  ultimoError: '',
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
function nombreMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const s = new Date(a, m - 1, 1).toLocaleDateString('es-PY', { month: 'long', year: 'numeric' });
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
function categorizar(comercio) {
  const c = normalizar(comercio);
  if (c) {
    for (const r of state.config.reglas) {
      const p = normalizar(r.patron);
      if (p && c.includes(p)) return r.categoria;
    }
  }
  return CATEGORIA_DEFECTO;
}
function colorDe(categoria) {
  return state.config.categorias.find((c) => c.nombre === categoria)?.color || COLOR_DEFECTO;
}
function el(tag, props = {}, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) e.append(h);
  return e;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

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
  const mes = state.mes;
  const r = await apiGet({ mes });
  if (!r.ok) throw new Error(r.error || 'Error del servidor');
  await store.set('gastos:' + mes, r.gastos);
  if (mes === state.mes) state.gastos = r.gastos;
  if (!hayConfigPendiente() && r.config?.categorias?.length) {
    state.config = r.config;
    await store.set('config', r.config);
  }
}

async function sincronizar() {
  if (state.sincronizando || !conectado() || !state.online) return render();
  state.sincronizando = true;
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
  }
}

async function encolar(body) {
  await store.encolar({ body, creado: Date.now() });
  state.cola = await store.cola();
  render();
  sincronizar();
}

// ---------- Datos visibles (servidor + cola pendiente) ----------

function gastosVisibles() {
  const mapa = new Map(state.gastos.map((g) => [g.id, { ...g }]));
  for (const { body } of state.cola) {
    if (body.accion === 'guardar') {
      const g = body.gasto;
      if (g.fecha.startsWith(state.mes)) mapa.set(g.id, { ...g, pendiente: true });
      else mapa.delete(g.id);
    } else if (body.accion === 'borrar') {
      mapa.delete(body.id);
    }
  }
  return [...mapa.values()].sort((a, b) => b.fecha.localeCompare(a.fecha));
}

function totalesPorCategoria(gastos) {
  const tot = new Map(state.config.categorias.map((c) => [c.nombre, 0]));
  for (const g of gastos) tot.set(g.categoria || CATEGORIA_DEFECTO, (tot.get(g.categoria || CATEGORIA_DEFECTO) || 0) + g.monto);
  const pres = new Map(state.config.presupuestos.map((p) => [p.categoria, Number(p.monto) || 0]));
  return [...tot.entries()]
    .map(([categoria, total]) => ({ categoria, total, presupuesto: pres.get(categoria) || 0 }))
    .filter((f) => f.total > 0 || f.presupuesto > 0)
    .sort((a, b) => b.total - a.total || b.presupuesto - a.presupuesto);
}

// ---------- Render ----------

function render() {
  $('#mesLabel').textContent = nombreMes(state.mes);
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('activa', b.dataset.vista === state.vista);
  for (const v of ['gastos', 'resumen', 'ajustes']) $('#vista-' + v).hidden = v !== state.vista;
  $('#fab').hidden = state.vista === 'ajustes';
  $('.mes').style.visibility = state.vista === 'ajustes' ? 'hidden' : '';
  renderEstado();
  if (state.vista === 'gastos') renderGastos();
  if (state.vista === 'resumen') renderResumen();
  if (state.vista === 'ajustes') renderAjustes();
}

function renderEstado() {
  const e = $('#estado');
  const pend = state.cola.length;
  let txt, cls = '';
  if (!conectado()) { txt = 'Sin configurar'; cls = 'error'; }
  else if (state.sincronizando) txt = '↻ Sincronizando…';
  else if (!state.online) { txt = pend ? `● Sin conexión · ${pend}` : '● Sin conexión'; cls = 'pendiente'; }
  else if (state.ultimoError) { txt = '⚠ ' + (pend ? `${pend} pendientes` : 'Error'); cls = 'error'; }
  else if (pend) { txt = `↻ ${pend} pendientes`; cls = 'pendiente'; }
  else txt = '✓ Al día';
  e.textContent = txt;
  e.className = 'estado ' + cls;
  e.title = state.ultimoError;
}

function renderGastos() {
  const gastos = gastosVisibles();
  const total = gastos.reduce((s, g) => s + g.monto, 0);
  const presTotal = state.config.presupuestos.reduce((s, p) => s + (Number(p.monto) || 0), 0);
  $('#totalMes').textContent = gs(total);
  $('#totalPresupuesto').textContent = presTotal
    ? `de ${gs(presTotal)} presupuestado · ${total > presTotal ? 'excedido por ' + gs(total - presTotal) : 'quedan ' + gs(presTotal - total)}`
    : `${gastos.length} gasto${gastos.length === 1 ? '' : 's'}`;

  const ul = $('#listaGastos');
  ul.replaceChildren();
  let diaActual = '';
  for (const g of gastos) {
    const dia = g.fecha.slice(0, 10);
    if (dia !== diaActual) {
      diaActual = dia;
      const [a, m, d] = dia.split('-').map(Number);
      ul.append(el('li', { class: 'dia' }, new Date(a, m - 1, d).toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'short' })));
    }
    ul.append(el('li', { class: 'gasto', onclick: () => abrirGasto(g) },
      el('span', { class: 'punto', style: `background:${colorDe(g.categoria)}` }),
      el('div', { class: 'info' },
        el('div', { class: 'comercio' }, g.comercio || 'Sin comercio'),
        el('div', { class: 'meta' }, [g.categoria, g.tarjeta, g.fecha.slice(11, 16), g.origen && g.origen !== 'manual' ? g.origen : ''].filter(Boolean).join(' · ')),
      ),
      el('div', { class: 'monto' }, gs(g.monto), g.pendiente ? el('small', {}, 'pendiente') : null),
    ));
  }
  $('#vacio').hidden = gastos.length > 0;
}

function renderResumen() {
  const filas = totalesPorCategoria(gastosVisibles());
  const cont = $('#grafico');
  cont.replaceChildren();
  if (!filas.length) {
    cont.append(el('p', { class: 'vacio' }, 'Sin gastos ni presupuestos este mes.'));
    return;
  }
  // Con presupuesto, la barra se mide contra el propio presupuesto; sin presupuesto, contra el mayor gasto.
  const mayorGasto = Math.max(1, ...filas.map((f) => f.total));
  for (const f of filas) {
    const escala = f.presupuesto ? Math.max(f.total, f.presupuesto) : mayorGasto;
    const excedido = f.presupuesto && f.total > f.presupuesto;
    let pie = '';
    if (f.presupuesto) {
      const pct = Math.round((f.total / f.presupuesto) * 100);
      pie = excedido
        ? `${pct}% · excedido por ${gs(f.total - f.presupuesto)}`
        : `${pct}% de ${gs(f.presupuesto)} · quedan ${gs(f.presupuesto - f.total)}`;
    }
    cont.append(el('div', { class: 'barra-fila' },
      el('div', { class: 'cab' }, el('span', {}, f.categoria), el('b', {}, gs(f.total))),
      el('div', { class: 'track' },
        el('div', { class: 'relleno', style: `width:${(f.total / escala) * 100}%;background:${excedido ? 'var(--danger)' : colorDe(f.categoria)}` }),
        f.presupuesto ? el('div', { class: 'marca', style: `left:calc(${(f.presupuesto / escala) * 100}% - 1px)`, title: 'Presupuesto' }) : null,
      ),
      pie ? el('div', { class: 'pie' + (excedido ? ' excedido' : '') }, pie) : null,
    ));
  }
}

function renderAjustes() {
  if (!state.borrador) state.borrador = structuredClone(state.config);
  const b = state.borrador;
  if (document.activeElement?.id !== 'cfgUrl') $('#cfgUrl').value = state.conexion.url;
  if (document.activeElement?.id !== 'cfgToken') $('#cfgToken').value = state.conexion.token;

  const cambio = () => { $('#barraGuardar').hidden = false; };
  const nombres = b.categorias.map((c) => c.nombre).filter(Boolean);

  $('#listaCategorias').replaceChildren(...b.categorias.map((c, i) => el('li', {},
    el('input', { type: 'color', value: c.color || COLOR_DEFECTO, 'aria-label': 'Color', oninput: (e) => { c.color = e.target.value; cambio(); } }),
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
    el('button', { class: 'quitar', 'aria-label': 'Quitar', onclick: () => {
      if (b.categorias.length <= 1) return toast('Tiene que quedar al menos una categoría');
      b.categorias.splice(i, 1);
      b.presupuestos = b.presupuestos.filter((p) => p.categoria !== c.nombre);
      cambio(); renderAjustes();
    } }, '×'),
  )));

  $('#listaPresupuestos').replaceChildren(...nombres.map((nombre) => {
    const p = b.presupuestos.find((x) => x.categoria === nombre);
    return el('li', {},
      el('span', { class: 'punto', style: `background:${b.categorias.find((c) => c.nombre === nombre).color}` }),
      el('span', { class: 'nombre-cat' }, nombre),
      el('input', {
        class: 'monto-pres', inputmode: 'numeric', placeholder: 'Sin límite', value: p?.monto ? fmt.format(p.monto) : '',
        'aria-label': 'Presupuesto ' + nombre,
        oninput: (e) => {
          const n = soloDigitos(e.target.value);
          e.target.value = n ? fmt.format(n) : '';
          b.presupuestos = b.presupuestos.filter((x) => x.categoria !== nombre);
          if (n) b.presupuestos.push({ categoria: nombre, monto: n });
          cambio();
        },
      }),
    );
  }));

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

// ---------- Formulario de gasto ----------

let editando = null;

function abrirGasto(g = null) {
  editando = g;
  $('#dlgTitulo').textContent = g ? 'Editar gasto' : 'Nuevo gasto';
  $('#fMonto').value = g ? fmt.format(g.monto) : '';
  $('#fComercio').value = g?.comercio || '';
  $('#fTarjeta').value = g ? g.tarjeta : (localStorageGet('ultimaTarjeta') || '');
  $('#fFecha').value = g ? g.fecha.replace(' ', 'T') : (state.mes === mesActual() ? ahoraLocal() : state.mes + '-01T12:00');
  $('#btnBorrar').hidden = !g;

  const sel = $('#fCategoria');
  const nombres = state.config.categorias.map((c) => c.nombre);
  sel.replaceChildren(
    el('option', { value: '' }, 'Automática (según reglas)'),
    ...nombres.map((n) => el('option', { value: n }, n)),
    g && g.categoria && !nombres.includes(g.categoria) ? el('option', { value: g.categoria }, g.categoria) : null,
  );
  sel.value = g?.categoria || '';
  actualizarSugerencia();

  const tarjetas = [...new Set(state.gastos.map((x) => x.tarjeta).filter(Boolean))];
  $('#tarjetas').replaceChildren(...tarjetas.map((t) => el('option', { value: t })));

  $('#dlgGasto').showModal();
  if (!g) setTimeout(() => $('#fMonto').focus(), 50);
}

function actualizarSugerencia() {
  const auto = $('#fCategoria').options[0];
  auto.textContent = `Automática: ${categorizar($('#fComercio').value)}`;
}

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }

async function guardarFormulario(ev) {
  ev.preventDefault();
  const monto = soloDigitos($('#fMonto').value);
  if (!monto) return toast('Ingresá un monto');
  const comercio = $('#fComercio').value.trim();
  const gasto = {
    id: editando?.id || uuid(),
    fecha: $('#fFecha').value.replace('T', ' ').slice(0, 16),
    monto,
    comercio,
    tarjeta: $('#fTarjeta').value.trim(),
    categoria: $('#fCategoria').value || categorizar(comercio),
    origen: editando?.origen || 'manual',
  };
  if (gasto.tarjeta) localStorageSet('ultimaTarjeta', gasto.tarjeta);
  $('#dlgGasto').close();
  await encolar({ accion: 'guardar', gasto });
  if (!gasto.fecha.startsWith(state.mes)) toast('Guardado en ' + nombreMes(gasto.fecha.slice(0, 7)));
}

async function borrarActual() {
  if (!editando || !confirm(`¿Borrar ${gs(editando.monto)} en ${editando.comercio || 'sin comercio'}?`)) return;
  $('#dlgGasto').close();
  await encolar({ accion: 'borrar', id: editando.id });
}

// ---------- CSV ----------

function aCsv(gastos) {
  const cols = ['fecha', 'monto', 'comercio', 'tarjeta', 'categoria', 'origen'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // ";" y BOM para que Excel en español lo abra bien.
  return '﻿' + [cols.join(';'), ...gastos.map((g) => cols.map((c) => esc(g[c])).join(';'))].join('\r\n');
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

async function exportarTodo() {
  if (!conectado() || !state.online) return toast('Necesitás conexión para exportar todo');
  try {
    const r = await apiGet({});
    if (!r.ok) throw new Error(r.error);
    await descargarCsv('gastos-todos.csv', r.gastos);
  } catch (err) {
    toast('No se pudo exportar: ' + err.message);
  }
}

// ---------- Eventos ----------

async function cambiarMes(delta) {
  state.mes = moverMes(state.mes, delta);
  state.gastos = (await store.get('gastos:' + state.mes)) || [];
  render();
  try { await cargarDelServidor(); state.ultimoError = ''; } catch (err) { state.ultimoError = err.message; }
  render();
}

$('#mesPrev').onclick = () => cambiarMes(-1);
$('#mesNext').onclick = () => cambiarMes(1);
$('#fab').onclick = () => abrirGasto();
$('#estado').onclick = () => {
  if (!conectado()) { state.vista = 'ajustes'; return render(); }
  if (state.ultimoError) toast(state.ultimoError);
  sincronizar();
};
for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => {
    if (state.vista === 'ajustes' && $('#barraGuardar').hidden) state.borrador = null; // sin cambios sin guardar
    state.vista = b.dataset.vista;
    window.scrollTo(0, 0);
    render();
  };
}

$('#formGasto').addEventListener('submit', guardarFormulario);
$('#btnCancelar').onclick = () => $('#dlgGasto').close();
$('#btnBorrar').onclick = borrarActual;
$('#fComercio').addEventListener('input', actualizarSugerencia);
$('#fMonto').addEventListener('input', (e) => {
  const n = soloDigitos(e.target.value);
  e.target.value = n ? fmt.format(n) : '';
});

$('#btnConectar').onclick = async () => {
  const url = $('#cfgUrl').value.trim();
  const token = $('#cfgToken').value.trim();
  if (url && !/^(https:\/\/script\.google(usercontent)?\.com\/|http:\/\/localhost[:/])/.test(url)) return toast('La URL debe ser de script.google.com');
  state.conexion = { url, token };
  await store.set('conexion', state.conexion);
  if (!conectado()) return render();
  try {
    await cargarDelServidor();
    state.ultimoError = '';
    state.borrador = null;
    toast('Conexión correcta ✓');
    sincronizar();
  } catch (err) {
    state.ultimoError = err.message;
    toast('No conecta: ' + err.message);
    render();
  }
};

$('#btnAddCategoria').onclick = () => {
  const b = state.borrador;
  let n = 1;
  while (b.categorias.some((c) => c.nombre === `Nueva ${n}`)) n++;
  b.categorias.push({ nombre: `Nueva ${n}`, color: '#0f766e' });
  $('#barraGuardar').hidden = false;
  renderAjustes();
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

$('#btnCsvMes').onclick = () => descargarCsv(`gastos-${state.mes}.csv`, gastosVisibles());
$('#btnCsvTodo').onclick = exportarTodo;

window.addEventListener('online', () => { state.online = true; sincronizar(); });
window.addEventListener('offline', () => { state.online = false; render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) sincronizar(); });

// ---------- Inicio ----------

state.conexion = (await store.get('conexion')) || state.conexion;
state.config = (await store.get('config')) || state.config;
state.gastos = (await store.get('gastos:' + state.mes)) || [];
state.cola = await store.cola();
render();
sincronizar();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW no registrado', err));
}
