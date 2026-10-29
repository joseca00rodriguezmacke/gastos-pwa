/**
 * Gastos PWA — backend en Google Apps Script.
 *
 * Se pega en el editor de Apps Script de la Google Sheet (Extensiones > Apps Script),
 * se ejecuta setup() una vez y se publica como aplicación web.
 *
 * GET  ?token=...&mes=AAAA-MM   -> { ok, gastos, config }   (sin mes: todos los gastos)
 * POST { token, accion, ... }    -> { ok, ... }
 *   accion "guardar" (por defecto): { gasto: {id?, fecha?, monto, comercio, tarjeta?, categoria?, origen?} }
 *                                   o los campos del gasto sueltos (así lo manda el Atajo de iOS)
 *   accion "borrar":  { id }
 *   accion "config":  { config: { categorias?, reglas?, presupuestos? } }
 */

const TZ = 'America/Asuncion';

const HOJAS = {
  Gastos: ['fecha', 'monto', 'comercio', 'tarjeta', 'categoria', 'origen', 'id'],
  Categorias: ['nombre', 'color'],
  Reglas: ['patron', 'categoria'],
  Presupuestos: ['categoria', 'monto'],
};

const CATEGORIAS_INICIALES = [
  ['Supermercado', '#16a34a'],
  ['Restaurantes', '#ea580c'],
  ['Combustible', '#ca8a04'],
  ['Transporte', '#0891b2'],
  ['Servicios', '#2563eb'],
  ['Salud', '#dc2626'],
  ['Suscripciones', '#7c3aed'],
  ['Hogar', '#a16207'],
  ['Ocio', '#db2777'],
  ['Otros', '#64748b'],
];

const REGLAS_INICIALES = [
  ['Stock', 'Supermercado'],
  ['Superseis', 'Supermercado'],
  ['Biggie', 'Supermercado'],
  ['Casa Rica', 'Supermercado'],
  ['Petrobras', 'Combustible'],
  ['Copetrol', 'Combustible'],
  ['Shell', 'Combustible'],
  ['Puma', 'Combustible'],
  ['Bolt', 'Transporte'],
  ['Uber', 'Transporte'],
  ['Farmacenter', 'Salud'],
  ['Punto Farma', 'Salud'],
  ['Pedidos Ya', 'Restaurantes'],
  ['PedidosYa', 'Restaurantes'],
  ['Netflix', 'Suscripciones'],
  ['Spotify', 'Suscripciones'],
  ['ANDE', 'Servicios'],
  ['ESSAP', 'Servicios'],
  ['Tigo', 'Servicios'],
];

const CATEGORIA_DEFECTO = 'Otros';

/** Ejecutar una vez desde el editor: crea las hojas, carga datos iniciales y genera el token. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(HOJAS).forEach(function (nombre) {
    const sh = ss.getSheetByName(nombre) || ss.insertSheet(nombre);
    if (sh.getLastRow() === 0) sh.appendRow(HOJAS[nombre]);
  });

  const gastos = ss.getSheetByName('Gastos');
  gastos.getRange('A:A').setNumberFormat('@'); // fecha como texto "AAAA-MM-DD HH:mm"
  gastos.getRange('B:B').setNumberFormat('#,##0');
  gastos.getRange('G:G').setNumberFormat('@');

  if (ss.getSheetByName('Categorias').getLastRow() === 1) reemplazarFilas('Categorias', CATEGORIAS_INICIALES);
  if (ss.getSheetByName('Reglas').getLastRow() === 1) reemplazarFilas('Reglas', REGLAS_INICIALES);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) {
    props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }
  Logger.log('TOKEN: ' + props.getProperty('TOKEN'));
}

function doGet(e) {
  return responder(function () {
    const p = (e && e.parameter) || {};
    autorizar(p.token);
    return { ok: true, gastos: listarGastos(p.mes || ''), config: leerConfig() };
  });
}

function doPost(e) {
  return responder(function () {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    autorizar(body.token);
    const accion = body.accion || 'guardar';

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (accion === 'guardar') {
        const gasto = guardarGasto(body.gasto || body);
        return {
          ok: true,
          gasto: gasto,
          mensaje: 'Gs ' + formatearGs(gasto.monto) + ' · ' + (gasto.comercio || 'sin comercio') + ' → ' + gasto.categoria,
        };
      }
      if (accion === 'borrar') {
        return { ok: true, borrado: borrarGasto(body.id) };
      }
      if (accion === 'config') {
        guardarConfig(body.config || {});
        return { ok: true, config: leerConfig() };
      }
      throw new Error('Acción desconocida: ' + accion);
    } finally {
      lock.releaseLock();
    }
  });
}

// ---------- Gastos ----------

function guardarGasto(g) {
  const textoMonto = String(g.monto == null ? '' : g.monto);
  const monto = parsearMonto(g.monto);
  if (!monto) throw new Error('Monto inválido: ' + textoMonto);

  const comercio = String(g.comercio || '').trim();
  let origen = String(g.origen || 'manual').trim();
  if (esMonedaExtranjera(textoMonto)) origen += ' · moneda extranjera: ' + textoMonto;

  const gasto = {
    fecha: normalizarFecha(g.fecha),
    monto: monto,
    comercio: comercio,
    tarjeta: String(g.tarjeta || '').trim(),
    categoria: String(g.categoria || '').trim() || categorizar(comercio, leerConfig().reglas),
    origen: origen,
    id: String(g.id || Utilities.getUuid()),
  };
  const fila = HOJAS.Gastos.map(function (c) { return gasto[c]; });

  const sh = hoja('Gastos');
  const n = buscarFilaPorId(sh, gasto.id);
  if (n) sh.getRange(n, 1, 1, fila.length).setValues([fila]);
  else sh.appendRow(fila);
  return gasto;
}

function borrarGasto(id) {
  const sh = hoja('Gastos');
  const n = buscarFilaPorId(sh, String(id || ''));
  if (n) sh.deleteRow(n);
  return !!n;
}

function listarGastos(mes) {
  return leerObjetos('Gastos')
    .map(function (g) {
      g.fecha = g.fecha instanceof Date ? Utilities.formatDate(g.fecha, TZ, 'yyyy-MM-dd HH:mm') : String(g.fecha);
      g.monto = Number(g.monto) || 0;
      g.id = String(g.id);
      return g;
    })
    .filter(function (g) { return g.id && g.fecha.indexOf(mes) === 0; })
    .sort(function (a, b) { return a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0; });
}

function buscarFilaPorId(sh, id) {
  if (!id) return 0;
  const col = HOJAS.Gastos.indexOf('id');
  const datos = sh.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    if (String(datos[i][col]) === id) return i + 1;
  }
  return 0;
}

// ---------- Configuración ----------

function leerConfig() {
  return {
    categorias: leerObjetos('Categorias').filter(function (c) { return c.nombre; }),
    reglas: leerObjetos('Reglas').filter(function (r) { return r.patron; }),
    presupuestos: leerObjetos('Presupuestos')
      .filter(function (p) { return p.categoria; })
      .map(function (p) { return { categoria: p.categoria, monto: Number(p.monto) || 0 }; }),
  };
}

function guardarConfig(cfg) {
  ['categorias', 'reglas', 'presupuestos'].forEach(function (clave) {
    if (!Array.isArray(cfg[clave])) return;
    const nombreHoja = clave.charAt(0).toUpperCase() + clave.slice(1);
    const cols = HOJAS[nombreHoja];
    reemplazarFilas(nombreHoja, cfg[clave].map(function (o) {
      return cols.map(function (c) { return o[c] == null ? '' : o[c]; });
    }));
  });
}

// ---------- Utilidades ----------

/** "Gs 150.000", "₲150,000", "PYG 150.000,00", 150000 -> 150000 (guaraníes no tienen decimales). */
function parsearMonto(v) {
  if (typeof v === 'number') return Math.abs(Math.round(v));
  let s = String(v || '').replace(/[^\d.,]/g, '');
  s = s.replace(/[.,]\d{1,2}$/, ''); // descarta decimales
  const n = parseInt(s.replace(/\D/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function esMonedaExtranjera(texto) {
  return /US\$|U\$S|USD|EUR|€|R\$|BRL|ARS|\$/i.test(texto) && !/Gs|PYG|₲/i.test(texto);
}

function categorizar(comercio, reglas) {
  const c = normalizar(comercio);
  if (c) {
    for (let i = 0; i < reglas.length; i++) {
      const p = normalizar(reglas[i].patron);
      if (p && c.indexOf(p) !== -1) return reglas[i].categoria;
    }
  }
  return CATEGORIA_DEFECTO;
}

function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/** Acepta "AAAA-MM-DD", "AAAA-MM-DDTHH:mm", "AAAA-MM-DD HH:mm" o nada (ahora). */
function normalizarFecha(f) {
  const m = String(f || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (m) return m[1] + ' ' + (m[2] || '00:00');
  const d = f ? new Date(f) : new Date();
  return Utilities.formatDate(isNaN(d) ? new Date() : d, TZ, 'yyyy-MM-dd HH:mm');
}

function formatearGs(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function hoja(nombre) {
  const sh = SpreadsheetApp.getActive().getSheetByName(nombre);
  if (!sh) throw new Error('Falta la hoja "' + nombre + '": ejecutá setup()');
  return sh;
}

function leerObjetos(nombre) {
  const datos = hoja(nombre).getDataRange().getValues();
  const cols = HOJAS[nombre];
  return datos.slice(1).map(function (fila) {
    const o = {};
    cols.forEach(function (c, i) { o[c] = fila[i] === undefined ? '' : fila[i]; });
    return o;
  });
}

function reemplazarFilas(nombre, filas) {
  const sh = hoja(nombre);
  const ultima = sh.getLastRow();
  if (ultima > 1) sh.deleteRows(2, ultima - 1);
  if (filas.length) sh.getRange(2, 1, filas.length, HOJAS[nombre].length).setValues(filas);
}

function autorizar(token) {
  const esperado = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!esperado) throw new Error('TOKEN no configurado: ejecutá setup()');
  if (String(token || '') !== esperado) throw new Error('No autorizado');
}

function responder(fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    out = { ok: false, error: err.message || String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
