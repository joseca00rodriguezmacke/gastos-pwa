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
 *   accion "lote" (o si viene "lineas"): { lineas: "un gasto JSON por línea" }
 *                                   la cola del Atajo de iOS: reenviar es seguro, no duplica.
 *
 * Los campos del gasto aceptan alias en inglés (amount, merchant, card_or_pass) y
 * "momento" (AAAA-MM-DD HH:mm:ss) como fecha; con momento y sin id, el id sale del contenido.
 *
 * Respaldo: ejecutar instalarRespaldo() una vez; copia la planilla cada domingo a la
 * carpeta "Gastos - respaldos" de Drive y guarda las últimas 8 copias.
 */

const TZ = 'America/Asuncion';

const HOJAS = {
  // etiqueta: viaje o evento ("Miami 2026"); tercero: quién lo debe si lo pagaste por otro (no suma a tus gastos)
  Gastos: ['fecha', 'monto', 'comercio', 'tarjeta', 'categoria', 'origen', 'id', 'etiqueta', 'tercero'],
  Categorias: ['nombre', 'color'],
  Reglas: ['patron', 'categoria'],
  Presupuestos: ['categoria', 'monto'],
  Registro: ['fecha', 'fuente', 'aviso', 'resultado', 'detalle'],
  Ajustes: ['clave', 'valor'],
  Ingresos: ['fecha', 'monto', 'pagador', 'categoria', 'banco', 'origen', 'id'],
  // accion: "gasto" o "ignorar"; limite: si el monto lo supera, no es gasto; etiqueta: nombre a mostrar
  Destinatarios: ['nombre', 'accion', 'categoria', 'etiqueta', 'limite'],
  PagosTarjeta: ['fecha', 'monto', 'tarjeta', 'origen', 'id'],
  // clave = nombre del comercio normalizado (sin números); fuente = "ia" o "usuario"
  Comercios: ['clave', 'nombre', 'categoria', 'fuente'],
};

const POR_REVISAR = 'Por revisar';

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
    if (p.estado) return { ok: true, estado: estadoSistema() };
    return { ok: true, gastos: listarGastos(p.mes || ''), ingresos: listarIngresos(p.mes || ''), config: leerConfig(), ia: infoIA() };
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
      if (accion === 'lote' || body.lineas !== undefined) {
        const guardados = guardarLote(body.lineas);
        if (!guardados.length) throw new Error('No llegó ningún gasto válido');
        const ultimo = guardados[guardados.length - 1];
        return {
          ok: true,
          guardados: guardados.length,
          mensaje: 'Gs ' + formatearGs(ultimo.monto) + ' · ' + (ultimo.comercio || 'sin comercio') + ' → ' + ultimo.categoria +
            (guardados.length > 1 ? ' (+' + (guardados.length - 1) + ' pendientes enviados)' : ''),
        };
      }
      if (accion === 'sms' || (body.texto !== undefined && body.accion === undefined)) {
        const r = procesarAviso(parsearSms(body.texto));
        return { ok: true, resultado: r.resultado, gasto: r.gasto, mensaje: r.mensaje };
      }
      if (accion === 'sugerencias') return { ok: true, sugerencias: sugerirPorRevisar() };
      if (accion === 'preguntar') return { ok: true, respuesta: preguntarGastos(String(body.pregunta || '')) };
      if (accion === 'consejo') return { ok: true, respuesta: consejoMes(String(body.mes || '')) };
      if (accion === 'ajuste') return { ok: true, ajustes: guardarAjuste(String(body.clave || ''), body.valor) };
      if (accion === 'iaMantenimiento') return { ok: true, resultado: unificarComerciosExistentes() };
      if (accion === 'resumenAhora') return { ok: true, resumen: resumenSemanal(true) };
      if (accion === 'simular') return { ok: true, respuesta: simular(String(body.escenario || '')) };
      if (accion === 'explicar') return { ok: true, respuesta: explicarMes(String(body.mes || '')) };
      if (accion === 'suscripcionesNuevas') return { ok: true, candidatos: suscripcionesNuevas() };
      if (accion === 'guardar') {
        const crudo = body.gasto || body;
        let gasto;
        try {
          gasto = guardarGasto(crudo);
        } catch (err) {
          registrarApplePay(crudo, 'error: ' + err.message);
          throw err;
        }
        registrarApplePay(crudo, gasto.fusionado ? 'fusionado' : 'guardado');
        return {
          ok: true,
          gasto: gasto,
          mensaje: 'Gs ' + formatearGs(gasto.monto) + ' · ' + (gasto.comercio || 'sin comercio') + ' → ' + gasto.categoria,
        };
      }
      if (accion === 'borrar') {
        return { ok: true, borrado: borrarGasto(body.id) };
      }
      if (accion === 'ingreso') {
        return { ok: true, ingreso: guardarIngreso(body.ingreso || {}) };
      }
      if (accion === 'borrarIngreso') {
        return { ok: true, borrado: borrarFila('Ingresos', String(body.id || '')) };
      }
      if (accion === 'destinatario') {
        guardarDestinatario(body.regla || {});
        return { ok: true, config: leerConfig() };
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

/** soloSiNuevo: un reenvío (la cola del Atajo) no pisa un gasto ya guardado ni lo que se le fusionó. */
function guardarGasto(g, soloSiNuevo) {
  const crudo = primero(g.monto, g.amount, g.importe);
  const textoMonto = String(crudo == null ? '' : crudo);
  const moneda = typeof crudo === 'number' ? 'PYG' : detectarMoneda(textoMonto);
  let monto;
  let nota = '';
  if (moneda === 'PYG') {
    monto = parsearMonto(crudo);
  } else {
    const original = parsearDecimal(textoMonto);
    const tc = cotizacion(moneda);
    monto = Math.round(original * tc);
    nota = ' · ' + moneda + ' ' + original.toFixed(2).replace('.', ',') + ' (TC ' + formatearGs(tc) + ')';
  }
  if (!monto) throw new Error('Monto inválido: ' + textoMonto);

  const comercio = String(primero(g.comercio, g.merchant) || '').trim();
  const tarjeta = String(primero(g.tarjeta, g.card_or_pass, g.card, g.tarjeta_o_pase) || '').trim();
  const momento = String(g.momento || '').trim();
  const origen = String(g.origen || 'manual').trim() + nota;

  const gasto = {
    fecha: normalizarFecha(g.fecha || momento),
    monto: monto,
    comercio: comercio,
    tarjeta: tarjeta,
    categoria: String(g.categoria || '').trim() || categorizar(comercio, leerConfig().reglas),
    origen: origen,
    // Con "momento" el id sale del contenido: reenviar el mismo gasto lo actualiza en vez de duplicarlo.
    id: String(g.id || (momento ? 'sc-' + resumenHex(momento + '|' + monto + '|' + comercio + '|' + tarjeta) : Utilities.getUuid())),
    etiqueta: String(g.etiqueta || '').trim(),
    tercero: String(g.tercero || '').trim(),
  };
  // Comercio de un aviso automático: nombre unificado y, si ninguna regla lo clasificó, categoría sugerida por IA.
  if (!String(g.categoria || '').trim() && FUENTES_COMERCIO.indexOf(fuenteDe(origen)) !== -1 && comercio && !/^Transferencia a /i.test(comercio)) {
    const info = infoComercio(comercio);
    if (info) {
      if (info.nombre) gasto.comercio = info.nombre;
      if (gasto.categoria === CATEGORIA_DEFECTO) {
        const porRegla = categorizar(info.nombre || '', leerConfig().reglas);
        gasto.categoria = porRegla !== CATEGORIA_DEFECTO ? porRegla : (info.categoria || CATEGORIA_DEFECTO);
      }
    }
  }
  const sh = hoja('Gastos');
  asegurarColumnasGastos(sh);
  const n = buscarFilaPorId(sh, gasto.id);
  if (n && (g.etiqueta === undefined || g.tercero === undefined)) {
    // Un reenvío automático no trae etiqueta ni tercero: se conservan los que ya tenía.
    const previo = leerObjetos('Gastos')[n - 2] || {};
    if (g.etiqueta === undefined) gasto.etiqueta = String(previo.etiqueta || '');
    if (g.tercero === undefined) gasto.tercero = String(previo.tercero || '');
  }
  if (n && soloSiNuevo) {
    const previo = leerObjetos('Gastos')[n - 2];
    previo.fecha = textoFecha(previo.fecha);
    return previo;
  }
  if (!n && FUENTES_AUTOMATICAS.indexOf(fuenteDe(gasto.origen)) !== -1) {
    // Reenvío de un aviso que ya se había fusionado con otro gasto: no se vuelve a sumar.
    const alias = aliasFusion(gasto.id);
    if (alias) {
      const previo = leerObjetos('Gastos').filter(function (x) { return String(x.id) === alias; })[0];
      if (previo) { previo.fecha = textoFecha(previo.fecha); previo.fusionado = true; return previo; }
    }
    const fusion = fusionarConExistente(sh, gasto);
    if (fusion) {
      registrar(fuenteDe(gasto.origen), gasto.id, 'fusionado con ' + fusion.id, gasto.comercio + ' ' + gasto.monto);
      return fusion;
    }
  }
  const fila = HOJAS.Gastos.map(function (c) { return gasto[c]; });
  if (n) sh.getRange(n, 1, 1, fila.length).setValues([fila]);
  else sh.appendRow(fila);
  return gasto;
}

const FUENTES_AUTOMATICAS = ['applepay', 'sms', 'mail'];
const FUENTES_COMERCIO = ['applepay', 'sms']; // compras con tarjeta: las únicas que la IA renombra
const VENTANA_FUSION_MIN = 30;
const VENTANA_FUSION_SIN_COMERCIO_MIN = 5;
const VENTANA_FUSION_MANUAL_MIN = 180; // un gasto cargado a mano + el aviso automático del mismo pago

/**
 * El mismo pago puede llegar por Apple Pay, SMS y mail. Si ya hay uno de otra fuente con el mismo
 * monto y comercio parecido (o sin comercio parecido pero casi al mismo minuto), se completa ese
 * en lugar de crear otro. Devuelve el gasto fusionado o null.
 */
function fusionarConExistente(sh, nuevo) {
  const datos = sh.getDataRange().getValues();
  const c = {};
  HOJAS.Gastos.forEach(function (k, i) { c[k] = i; });
  const fuente = fuenteDe(nuevo.origen);
  const t = minutosDe(nuevo.fecha);
  let mejor = 0;
  let mejorDif = Infinity;
  for (let i = 1; i < datos.length; i++) {
    const f = datos[i];
    const origen = String(f[c.origen]);
    const fuentes = origen.split(' · ')[0].split('+');
    if (fuentes.indexOf(fuente) !== -1) {
      // El atajo de Apple Pay a veces manda la misma compra dos veces (con y sin hora): mismo monto y comercio en 3 min.
      const dif0 = Math.abs(minutosDe(textoFecha(f[c.fecha])) - t);
      if (fuente === 'applepay' && Number(f[c.monto]) === nuevo.monto && mismoComercio(f[c.comercio], nuevo.comercio) && dif0 <= 3) {
        const previo = { fecha: textoFecha(f[c.fecha]), monto: Number(f[c.monto]), comercio: String(f[c.comercio]), tarjeta: String(f[c.tarjeta]), categoria: String(f[c.categoria]), origen: origen, id: String(f[c.id]), etiqueta: String(f[c.etiqueta] || ''), tercero: String(f[c.tercero] || ''), fusionado: true };
        return previo;
      }
      continue;
    }
    const esManual = fuentes.indexOf('manual') !== -1;
    // Lo cargado a mano suele tener otro nombre y otra hora (se carga después), y a veces difiere en 1 Gs.
    if (esManual ? Math.abs(Number(f[c.monto]) - nuevo.monto) > 1 : Number(f[c.monto]) !== nuevo.monto) continue;
    const dif = Math.abs(minutosDe(textoFecha(f[c.fecha])) - t);
    const ventana = esManual ? VENTANA_FUSION_MANUAL_MIN
      : mismoComercio(f[c.comercio], nuevo.comercio) ? VENTANA_FUSION_MIN : VENTANA_FUSION_SIN_COMERCIO_MIN;
    if (dif <= ventana && dif < mejorDif) { mejor = i; mejorDif = dif; }
  }
  if (!mejor) return null;

  const f = datos[mejor];
  const partes = String(f[c.origen]).split(' · ');
  partes[0] += '+' + fuente;
  const nota = nuevo.origen.split(' · ').slice(1);
  const fusionado = {
    fecha: textoFecha(f[c.fecha]),
    monto: Number(f[c.monto]),
    comercio: String(f[c.comercio]) || nuevo.comercio,
    tarjeta: String(f[c.tarjeta]) || nuevo.tarjeta,
    categoria: String(f[c.categoria]) || nuevo.categoria,
    origen: partes.concat(nota.filter(function (x) { return partes.indexOf(x) === -1; })).join(' · '),
    id: String(f[c.id]),
    etiqueta: String(f[c.etiqueta] || ''),
    tercero: String(f[c.tercero] || ''),
  };
  sh.getRange(mejor + 1, 1, 1, HOJAS.Gastos.length).setValues([HOJAS.Gastos.map(function (k) { return fusionado[k]; })]);
  fusionado.fusionado = true;
  return fusionado;
}

function fuenteDe(origen) {
  return String(origen || 'manual').split(' · ')[0].split('+')[0].trim();
}

function mismoComercio(a, b) {
  const x = normalizar(a).replace(/[^a-z0-9 ]/g, '');
  const y = normalizar(b).replace(/[^a-z0-9 ]/g, '');
  if (!x || !y) return true;
  if (x.indexOf(y) !== -1 || y.indexOf(x) !== -1) return true;
  // Coincide la primera palabra significativa: "PETROBRAS SHAH 43" ~ "Petrobras Mburucuya"
  const px = x.split(' ').filter(function (w) { return w.length > 2; })[0];
  const py = y.split(' ').filter(function (w) { return w.length > 2; })[0];
  return !!px && px === py;
}

function textoFecha(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm') : String(v);
}

function minutosDe(fecha) {
  const m = String(fecha).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
}

/** Una línea JSON por gasto; las líneas vacías o ilegibles se ignoran. */
function guardarLote(lineas) {
  const guardados = [];
  String(lineas || '').split(/\r?\n/).forEach(function (linea) {
    linea = linea.trim();
    if (!linea) return;
    let g;
    try { g = JSON.parse(linea); } catch (err) { registrarApplePay({ origen: 'applepay', linea: linea }, 'error: línea ilegible'); return; }
    try {
      const x = guardarGasto(g, true);
      guardados.push(x);
      registrarApplePay(g, x.fusionado ? 'fusionado' : 'guardado');
    } catch (err) {
      registrarApplePay(g, 'error: ' + err.message); // monto inválido: se descarta esa línea
    }
  });
  return guardados;
}

/** Deja en el Registro cada intento de Apple Pay con lo que mandó el iPhone (sin el token), para diagnosticar. */
function registrarApplePay(crudo, resultado) {
  // solo lo que llega del iPhone ("applepay"), no las ediciones desde la app ("applepay+sms", etc.)
  if (!/^applepay($|\s)/.test(String((crudo && crudo.origen) || ''))) return;
  const detalle = {};
  Object.keys(crudo).forEach(function (k) { if (k !== 'token' && k !== 'accion') detalle[k] = crudo[k]; });
  registrar('applepay', 'ap-' + resumenHex(JSON.stringify(detalle) + Date.now()), resultado, JSON.stringify(detalle));
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
      g.etiqueta = String(g.etiqueta || '');
      g.tercero = String(g.tercero || '');
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

/** Agrega al encabezado de Gastos las columnas nuevas (etiqueta, tercero) si la hoja es anterior. */
function asegurarColumnasGastos(sh) {
  sh = sh || hoja('Gastos');
  const n = HOJAS.Gastos.length;
  if (sh.getLastColumn() >= n) return;
  sh.getRange(1, 1, 1, n).setValues([HOJAS.Gastos]);
}

// ---------- Configuración ----------

function leerConfig() {
  return {
    categorias: leerObjetos('Categorias').filter(function (c) { return c.nombre; }),
    reglas: leerObjetos('Reglas').filter(function (r) { return r.patron; }),
    presupuestos: leerObjetos('Presupuestos')
      .filter(function (p) { return p.categoria; })
      .map(function (p) { return { categoria: p.categoria, monto: Number(p.monto) || 0 }; }),
    destinatarios: leerDestinatarios(),
  };
}

function guardarConfig(cfg) {
  ['categorias', 'reglas', 'presupuestos', 'destinatarios'].forEach(function (clave) {
    if (!Array.isArray(cfg[clave])) return;
    const nombreHoja = clave.charAt(0).toUpperCase() + clave.slice(1);
    const cols = HOJAS[nombreHoja];
    reemplazarFilas(nombreHoja, cfg[clave].map(function (o) {
      return cols.map(function (c) { return o[c] == null ? '' : o[c]; });
    }));
  });
}

// ---------- Avisos del banco: SMS y correos ----------
//
// Cada aviso se registra en la hoja "Registro" con un id estable (hash del SMS, número de
// operación del mail): si llega dos veces, la segunda se ignora. La hoja "Ajustes" tiene el
// titular (para no contar transferencias a cuentas propias) y las cotizaciones (GOOGLEFINANCE).

const REMITENTES_BANCO = ['operbancaweb@familiar.com.py', 'transferencias@bancognb.com.py', 'noreply@bancognb.com.py'];

function procesarAviso(av) {
  if (!av) return { resultado: 'no reconocido', mensaje: 'Aviso no reconocido' };
  if (yaRegistrado(av.id)) return { resultado: 'repetido', mensaje: 'Ya estaba registrado' };
  let r;
  if (av.tipo === 'gasto') {
    av.gasto.id = av.id;
    av.gasto.categoria = av.gasto.categoria || '';
    const g = guardarGasto(av.gasto);
    r = {
      resultado: g.fusionado ? 'fusionado' : 'guardado',
      gasto: g,
      mensaje: 'Gs ' + formatearGs(g.monto) + ' · ' + (g.comercio || 'sin comercio') + ' → ' + g.categoria + (g.fusionado ? ' (ya estaba, completado)' : ''),
    };
  } else if (av.tipo === 'ingreso') {
    av.ingreso.id = av.id;
    const i = guardarIngreso(av.ingreso);
    r = { resultado: 'ingreso ' + i.categoria, mensaje: 'Ingreso Gs ' + formatearGs(i.monto) + ' · ' + i.pagador + ' → ' + i.categoria };
  } else if (av.tipo === 'pagoTarjeta') {
    // No es un gasto (cada compra ya se registró): se guarda aparte para seguir el saldo de la tarjeta.
    const p = guardarPagoTarjeta(Object.assign({ id: av.id }, av.pago));
    r = {
      resultado: 'pago de tarjeta',
      mensaje: 'Pago de tarjeta ' + p.tarjeta + ': Gs ' + formatearGs(p.monto) + ' · no suma como gasto (las compras ya se registraron)',
    };
  } else if (av.tipo === 'reverso') {
    const borrado = aplicarReverso(av.gasto);
    r = { resultado: borrado ? 'reverso aplicado' : 'reverso sin pago original', mensaje: borrado ? 'Reverso: se quitó ' + borrado : 'Reverso recibido (no se encontró el pago)' };
  } else {
    r = { resultado: 'ignorado: ' + av.motivo, mensaje: 'Ignorado: ' + av.motivo };
  }
  if (av.porIA) { r.resultado += ' (IA)'; r.mensaje += ' · leído por IA'; }
  registrar(av.fuente, av.id, r.resultado, av.texto);
  return r;
}

function parsearSms(texto) {
  const t = String(texto || '').replace(/\r/g, '').trim();
  if (!t) return null;
  const id = 'sms-' + resumenHex(t.replace(/\s+/g, ' '));
  const base = { fuente: 'sms', id: id, texto: t };

  // Banco GNB: "La operación de pago en COMERCIO   CIUDAD PAIS por Gs 20.900 en TC *1313 de ... el 09/11/2026 18:03"
  let m = t.match(/operaci[oó]n de (pago|reverso|compra)\s+en\s+([\s\S]+?)\s+por\s+(USD|U\$S|Gs\.?|PYG|EUR|BRL)\s*(-?[\d.,]+)\s+en\s+(T[CD])\s*\*?\s*(\d{3,4})[\s\S]*?el\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/i);
  if (m) {
    const gasto = {
      monto: m[3] + ' ' + m[4].replace('-', ''),
      comercio: limpiarComercio(m[2]),
      tarjeta: (/gnb/i.test(t) ? 'GNB ' : '') + m[5].toUpperCase() + ' *' + m[6],
      fecha: fechaDeTexto(m[7]),
      origen: 'sms',
    };
    return Object.assign(base, { tipo: /reverso/i.test(m[1]) ? 'reverso' : 'gasto', gasto: gasto });
  }

  // Banco GNB, pago DE la tarjeta (sin comercio): "La operación de pago por Gs 115.000 en TC *1313 de ... el 13/11/2026 15:18"
  m = t.match(/operaci[oó]n de pago\s+por\s+(USD|U\$S|Gs\.?|PYG)\s*([\d.,]+)\s+en\s+(T[CD])\s*\*?\s*(\d{3,4})[\s\S]*?el\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/i);
  if (m) {
    return Object.assign(base, {
      tipo: 'pagoTarjeta',
      pago: {
        fecha: fechaDeTexto(m[5]),
        monto: m[1] + ' ' + m[2],
        tarjeta: (/gnb/i.test(t) ? 'GNB ' : '') + m[3].toUpperCase() + ' *' + m[4],
      },
    });
  }

  // Banco Continental: "TRANS. APROBADA de la tarjeta DINELCO CLASICA 0677 , monto: 13.565-, en: SUPERSEIS HIPER."
  m = t.match(/TRANS\.?\s*APROBADA\s+de\s+la\s+tarjeta\s+(.+?)\s*(\d{4})\s*,\s*monto:\s*([\d.,]+)-?\s*,\s*en:\s*([\s\S]+?)\.?\s*$/i);
  if (m) {
    return Object.assign(base, {
      tipo: 'gasto',
      gasto: {
        monto: 'Gs ' + m[3],
        comercio: m[4].trim(),
        tarjeta: 'Continental ' + titulo(m[1].trim()) + ' ' + m[2],
        fecha: '',
        origen: 'sms',
      },
    });
  }

  if (/pago\s+(de|a|en)\s+(su\s+|la\s+)?tarjeta|pago\s+recibido|acreditaci[oó]n|cr[eé]dito\s+a\s+su\s+cuenta/i.test(t)) {
    return Object.assign(base, { tipo: 'ignorar', motivo: 'pago de tarjeta o crédito' });
  }
  return Object.assign(base, { tipo: 'ignorar', motivo: 'formato de SMS no reconocido' });
}

function parsearCorreo(remitente, asunto, texto, idMensaje) {
  const de = String(remitente || '').toLowerCase();
  const a = normalizar(asunto);
  const base = { fuente: 'mail', texto: asunto + ' | ' + String(texto).replace(/\s+/g, ' ').slice(0, 400) };

  if (de.indexOf('familiar.com.py') !== -1) {
    if (a.indexOf('transferencia a otros bancos') !== -1 || /TRANSFERENCIA A OTRAS ENTIDADES CONFIRMADA/i.test(texto)) {
      return transferenciaEnviada(base, 'fam-' + (campo(texto, 'Nro\\. de Operaci[oó]n') || idMensaje), {
        monto: campo(texto, 'Monto a enviar') || campo(texto, 'Moneda y Monto'),
        beneficiario: campo(texto, 'Cliente Beneficiario'),
        fecha: campo(texto, 'Fecha y hora de Operaci[oó]n'),
        banco: 'Familiar',
      });
    }
    if (/TRANSFERENCIA DE OTRAS ENTIDADES RECIBIDA/i.test(texto)) {
      return ingresoRecibido(base, 'famr-' + (campo(texto, 'Nro\\. de Operaci[oó]n') || idMensaje), {
        monto: campo(texto, 'Moneda y Monto') || campo(texto, 'Monto'),
        pagador: campo(texto, 'Cliente Pagador'),
        fecha: campo(texto, 'Fecha y hora de Operaci[oó]n'),
        banco: 'Familiar',
      });
    }
    if (a.indexOf('pago de servicios') !== -1) {
      const servicio = campo(texto, 'Servicio');
      const categoria = categorizar(servicio, leerConfig().reglas);
      return Object.assign(base, {
        id: 'fam-' + (campo(texto, 'N[uú]mero de Transacci[oó]n') || idMensaje),
        tipo: 'gasto',
        gasto: {
          monto: campo(texto, 'Monto'),
          comercio: titulo(servicio) || 'Pago de servicios',
          tarjeta: 'Familiar',
          categoria: categoria === CATEGORIA_DEFECTO ? 'Servicios' : categoria,
          fecha: fechaDeTexto(campo(texto, 'Fecha')),
          origen: 'mail',
        },
      });
    }
  }

  if (de.indexOf('bancognb.com.py') !== -1 && /Transferencia interbancaria Enviada/i.test(texto)) {
    return transferenciaEnviada(base, 'gnb-' + (campo(texto, 'N° Comprobante') || idMensaje), {
      monto: campo(texto, 'Importe'),
      beneficiario: campo(texto, 'Cliente Beneficiario'),
      fecha: campo(texto, 'Fecha y hora'),
      banco: 'GNB',
    });
  }
  if (de.indexOf('bancognb.com.py') !== -1 && /Transferencia Interbancaria Recibida/i.test(texto)) {
    return ingresoRecibido(base, 'gnbr-' + (campo(texto, 'N° Comprobante') || idMensaje), {
      monto: campo(texto, 'Importe'),
      pagador: campo(texto, 'Enviado por'),
      fecha: campo(texto, 'Fecha y hora'),
      banco: 'GNB',
    });
  }
  if (de.indexOf('bancognb.com.py') !== -1 && /TRANSFERENCIA RECIBIDA DE CTA DE TERCEROS/i.test(texto)) {
    return ingresoRecibido(base, 'gnbr-' + (campo(texto, 'Nro\\. de Comprobante') || idMensaje), {
      monto: campo(texto, 'Importe'),
      pagador: campo(texto, 'Nombre del Ordenante'),
      fecha: campo(texto, 'Fecha y Hora'),
      banco: 'GNB',
    });
  }
  return null; // facturas, publicidad: no son gastos ni ingresos
}

function transferenciaEnviada(base, id, d) {
  const titular = String(ajustes().titular || '').trim();
  if (!titular) return Object.assign(base, { id: id, tipo: 'ignorar', motivo: 'falta el titular en la hoja Ajustes' });
  if (esTitular(d.beneficiario, titular)) return Object.assign(base, { id: id, tipo: 'ignorar', motivo: 'transferencia a cuenta propia' });
  const decision = decidirDestinatario(d.beneficiario, parsearMonto(d.monto));
  if (decision.ignorar) return Object.assign(base, { id: id, tipo: 'ignorar', motivo: decision.motivo });
  return Object.assign(base, {
    id: id,
    tipo: 'gasto',
    gasto: {
      monto: d.monto,
      comercio: decision.etiqueta,
      tarjeta: d.banco,
      categoria: decision.categoria,
      fecha: fechaDeTexto(d.fecha),
      origen: 'mail',
    },
  });
}

// ---------- Reglas por destinatario ----------

function leerDestinatarios() {
  if (!SpreadsheetApp.getActive().getSheetByName('Destinatarios')) return [];
  return leerObjetos('Destinatarios')
    .filter(function (r) { return String(r.nombre).trim(); })
    .map(function (r) {
      return {
        nombre: String(r.nombre).trim(),
        accion: String(r.accion || 'gasto').trim().toLowerCase() === 'ignorar' ? 'ignorar' : 'gasto',
        categoria: String(r.categoria || '').trim(),
        etiqueta: String(r.etiqueta || '').trim(),
        limite: Number(r.limite) || 0,
      };
    });
}

/** Todas las palabras de la regla tienen que estar en el nombre: "Liana Martinez" ~ "LIANA MONSERRAT MARTINEZ RECALDE". */
function coincideNombre(nombre, regla) {
  const palabras = function (s) { return normalizar(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 1; }); };
  const n = palabras(nombre);
  const r = palabras(regla);
  return r.length > 0 && r.every(function (w) { return n.indexOf(w) !== -1; });
}

function reglaDestinatario(nombre) {
  const reglas = leerDestinatarios();
  for (let i = 0; i < reglas.length; i++) if (coincideNombre(nombre, reglas[i].nombre)) return reglas[i];
  return null;
}

/** Qué hacer con una transferencia enviada a "nombre": ignorarla, o con qué categoría y etiqueta guardarla. */
function decidirDestinatario(nombre, monto) {
  const etiquetaBase = 'Transferencia a ' + titulo(nombre);
  const r = reglaDestinatario(nombre);
  if (!r) return { categoria: POR_REVISAR, etiqueta: etiquetaBase };
  if (r.accion === 'ignorar') return { ignorar: true, motivo: 'regla: ' + r.nombre + ' no es gasto' };
  if (r.limite && monto > r.limite) return { ignorar: true, motivo: 'regla: ' + r.nombre + ' por más de ' + formatearGs(r.limite) + ' no es gasto' };
  return { categoria: r.categoria || 'Transferencias', etiqueta: r.etiqueta || etiquetaBase };
}

/** Agrega o reemplaza la regla de un destinatario (desde la app, al revisar). */
function guardarDestinatario(r) {
  const nombre = String(r.nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre del destinatario');
  asegurarHojasLecturas();
  const reglas = leerDestinatarios().filter(function (x) { return normalizar(x.nombre) !== normalizar(nombre); });
  reglas.unshift({ nombre: nombre, accion: r.accion === 'ignorar' ? 'ignorar' : 'gasto', categoria: r.categoria || '', etiqueta: r.etiqueta || '', limite: Number(r.limite) || 0 });
  guardarConfig({ destinatarios: reglas });
}

/** Una vez: aplica las reglas de destinatario a las transferencias ya registradas por mail. */
function aplicarReglasDestinatarios() {
  const sh = hoja('Gastos');
  const datos = sh.getDataRange().getValues();
  const c = {};
  HOJAS.Gastos.forEach(function (k, i) { c[k] = i; });
  let cambios = 0;
  for (let i = datos.length - 1; i >= 1; i--) {
    const f = datos[i];
    const comercio = String(f[c.comercio]);
    if (fuenteDe(f[c.origen]) !== 'mail' || !/^Transferencia a /i.test(comercio) || String(f[c.categoria]) !== 'Transferencias') continue;
    const d = decidirDestinatario(comercio.replace(/^Transferencia a /i, ''), Number(f[c.monto]));
    if (d.ignorar) { sh.deleteRow(i + 1); cambios++; continue; }
    f[c.categoria] = d.categoria;
    f[c.comercio] = d.etiqueta;
    sh.getRange(i + 1, 1, 1, f.length).setValues([f]);
    cambios++;
  }
  return cambios;
}

// ---------- Ingresos ----------

/** Plata recibida de terceros: SERCON = Sueldo, el resto = Ventas. Lo de cuentas propias se ignora. */
function ingresoRecibido(base, id, d) {
  const titular = String(ajustes().titular || '').trim();
  if (!titular) return Object.assign(base, { id: id, tipo: 'ignorar', motivo: 'falta el titular en la hoja Ajustes' });
  if (esTitular(d.pagador, titular)) return Object.assign(base, { id: id, tipo: 'ignorar', motivo: 'transferencia desde cuenta propia' });
  const r = reglaDestinatario(d.pagador);
  if (r && r.accion === 'ignorar') return Object.assign(base, { id: id, tipo: 'ignorar', motivo: 'regla: ' + r.nombre + ' se ignora' });
  const patronSueldo = String(ajustes().empleador || 'SERCON');
  return Object.assign(base, {
    id: id,
    tipo: 'ingreso',
    ingreso: {
      fecha: fechaDeTexto(d.fecha),
      monto: parsearMonto(d.monto),
      pagador: titulo(d.pagador),
      categoria: coincideNombre(d.pagador, patronSueldo) ? 'Sueldo' : 'Ventas',
      banco: d.banco,
      origen: 'mail',
    },
  });
}

function guardarIngreso(i) {
  asegurarHojasLecturas();
  const ingreso = {
    fecha: normalizarFecha(i.fecha),
    monto: parsearMonto(i.monto),
    pagador: String(i.pagador || '').trim(),
    categoria: String(i.categoria || 'Ventas').trim(),
    banco: String(i.banco || '').trim(),
    origen: String(i.origen || 'manual').trim(),
    id: String(i.id || Utilities.getUuid()),
  };
  if (!ingreso.monto) throw new Error('Monto inválido');
  const sh = hoja('Ingresos');
  const n = buscarFilaPorIdEn(sh, 'Ingresos', ingreso.id);
  const fila = HOJAS.Ingresos.map(function (k) { return ingreso[k]; });
  if (n) sh.getRange(n, 1, 1, fila.length).setValues([fila]);
  else sh.appendRow(fila);
  return ingreso;
}

function listarIngresos(mes) {
  if (!SpreadsheetApp.getActive().getSheetByName('Ingresos')) return [];
  return leerObjetos('Ingresos')
    .map(function (g) { g.fecha = textoFecha(g.fecha); g.monto = Number(g.monto) || 0; g.id = String(g.id); return g; })
    .filter(function (g) { return g.id && g.fecha.indexOf(mes) === 0; })
    .sort(function (a, b) { return a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0; });
}

function buscarFilaPorIdEn(sh, nombre, id) {
  const col = HOJAS[nombre].indexOf('id');
  const datos = sh.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) if (String(datos[i][col]) === id) return i + 1;
  return 0;
}

function guardarPagoTarjeta(p) {
  asegurarHojasLecturas();
  const pago = {
    fecha: normalizarFecha(p.fecha),
    monto: detectarMoneda(p.monto) === 'PYG' ? parsearMonto(p.monto) : Math.round(parsearDecimal(p.monto) * cotizacion(detectarMoneda(p.monto))),
    tarjeta: String(p.tarjeta || '').trim(),
    origen: String(p.origen || 'sms'),
    id: String(p.id || Utilities.getUuid()),
  };
  const sh = hoja('PagosTarjeta');
  const n = buscarFilaPorIdEn(sh, 'PagosTarjeta', pago.id);
  const fila = HOJAS.PagosTarjeta.map(function (k) { return pago[k]; });
  if (n) sh.getRange(n, 1, 1, fila.length).setValues([fila]);
  else sh.appendRow(fila);
  return pago;
}

function borrarFila(nombre, id) {
  if (!id || !SpreadsheetApp.getActive().getSheetByName(nombre)) return false;
  const sh = hoja(nombre);
  const n = buscarFilaPorIdEn(sh, nombre, id);
  if (n) sh.deleteRow(n);
  return !!n;
}

/** Ejecutar una vez: hojas de ingresos y destinatarios, aplica las reglas y lee los mails desde el 1 del mes. */
function instalarIngresos() {
  asegurarHojasLecturas();
  const cambios = aplicarReglasDestinatarios();
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);
  PropertiesService.getScriptProperties().setProperty('CORREOS_DESDE', String(Math.floor(inicioMes.getTime() / 1000) + 600));
  procesarCorreos();
  Logger.log('Transferencias reclasificadas: ' + cambios + ' · ingresos: ' + listarIngresos('').length);
}

/** Borra el pago que revierte (mismo monto ±3%, comercio parecido, hasta 3 días antes). */
function aplicarReverso(g) {
  const moneda = detectarMoneda(g.monto);
  const monto = moneda === 'PYG' ? parsearMonto(g.monto) : Math.round(parsearDecimal(g.monto) * cotizacion(moneda));
  const t = minutosDe(g.fecha || normalizarFecha(''));
  const sh = hoja('Gastos');
  const datos = sh.getDataRange().getValues();
  const c = {};
  HOJAS.Gastos.forEach(function (k, i) { c[k] = i; });
  for (let i = datos.length - 1; i >= 1; i--) {
    const f = datos[i];
    const dif = t - minutosDe(textoFecha(f[c.fecha]));
    if (dif < 0 || dif > 3 * 24 * 60) continue;
    if (Math.abs(Number(f[c.monto]) - monto) > Math.max(1, monto * 0.03)) continue;
    if (!mismoComercio(f[c.comercio], g.comercio)) continue;
    sh.deleteRow(i + 1);
    return f[c.comercio] + ' Gs ' + formatearGs(f[c.monto]);
  }
  return '';
}

// Apps Script corta a los 6 minutos: cada pasada trabaja hasta 4,5 y deja el resto para la siguiente.
const LIMITE_CORREOS_MS = 4.5 * 60 * 1000;

/** Activador cada 10 minutos: lee los correos nuevos de los bancos (solo lectura). */
function procesarCorreos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('CORREOS_ULTIMA_CORRIDA', normalizarFecha(''));
    const desde = Number(props.getProperty('CORREOS_DESDE')) || Math.floor(Date.now() / 1000) - 3600;
    const consulta = 'from:(' + REMITENTES_BANCO.join(' OR ') + ') after:' + (desde - 600);
    CACHE_REGISTRO = new Set(filasRegistro().slice(1)
      .filter(function (f) { return !SE_PUEDE_REPROCESAR.test(String(f[3])); })
      .map(function (f) { return String(f[2]); }));
    // Mails ya leídos (por id de Gmail): si una pasada se corta por tiempo, la siguiente sigue desde ahí.
    const cache = CacheService.getScriptCache();
    const vistos = new Set(JSON.parse(cache.get('CORREOS_VISTOS') || '[]'));
    const inicio = Date.now();
    let completo = true;
    let ultimo = desde;
    const hilos = GmailApp.search(consulta, 0, 100);
    recorrer:
    for (let h = 0; h < hilos.length; h++) {
      const mensajes = hilos[h].getMessages();
      for (let m = 0; m < mensajes.length; m++) {
        const msg = mensajes[m];
        const t = Math.floor(msg.getDate().getTime() / 1000);
        if (t < desde - 600) continue;
        if (t > ultimo) ultimo = t;
        const idMsg = msg.getId();
        if (vistos.has(idMsg)) continue;
        if (Date.now() - inicio > LIMITE_CORREOS_MS) { completo = false; break recorrer; }
        try {
          procesarAviso(parsearCorreo(msg.getFrom(), msg.getSubject(), textoPlano(msg.getBody()), idMsg));
        } catch (err) {
          registrar('mail', 'error-' + idMsg, 'error: ' + err.message, msg.getSubject());
        }
        vistos.add(idMsg);
      }
    }
    cache.put('CORREOS_VISTOS', JSON.stringify(Array.from(vistos).slice(-3000)), 21600);
    // Solo se avanza la fecha cuando se leyó todo; si no, la próxima pasada (10 min) continúa.
    if (completo) props.setProperty('CORREOS_DESDE', String(ultimo));
  } finally {
    CACHE_REGISTRO = null;
    lock.releaseLock();
  }
  try { tareasIA(); } catch (err) { registrar('ia', 'tareas-' + Date.now(), 'error: ' + err.message, 'tareas de fondo'); }
}

/**
 * IA en segundo plano (después de leer los correos, sin bloquear Apple Pay ni SMS):
 * nombre y categoría de comercios nuevos y lectura de SMS con formato desconocido.
 */
function tareasIA() {
  if (!iaDisponible() || iaEnPausa()) return;
  const cache = CacheService.getScriptCache();
  if (cache.get('ia-corriendo')) return;
  cache.put('ia-corriendo', '1', 330);
  const inicio = Date.now();
  try {
    unificarComerciosExistentes(20);
    // SMS de los últimos 3 días que el lector fijo no reconoció: hasta 3 intentos por aviso.
    const hace3 = Utilities.formatDate(new Date(Date.now() - 3 * 86400000), TZ, 'yyyy-MM-dd HH:mm');
    const vistos = {};
    let leidosIA = 0;
    filasRegistro().slice(1).reverse().forEach(function (f) {
      if (String(f[1]) !== 'sms' || !/^ignorado: formato/.test(String(f[3]))) return;
      if (textoFecha(f[0]) < hace3 || vistos[String(f[2])]) return;
      vistos[String(f[2])] = String(f[4]);
    });
    Object.keys(vistos).forEach(function (id) {
      if (Date.now() - inicio > 120000 || leidosIA >= 2 || iaEnPausa() || yaRegistrado(id)) return;
      leidosIA++;
      const k = 'ia-sms-' + id;
      const intentos = Number(cache.get(k) || 0);
      if (intentos >= 3) return;
      cache.put(k, String(intentos + 1), 6 * 3600);
      const texto = vistos[id];
      const av = parsearSms(texto);
      const leido = conLectorIA(av, texto, 'sms');
      if (leido && leido.porIA) procesarAviso(leido);
    });
  } finally {
    cache.remove('ia-corriendo');
  }
}

/** Ejecutar una vez: crea Registro/Ajustes, la categoría Transferencias y el activador de correos. */
function instalarLecturas() {
  asegurarHojasLecturas();
  if (!String(ajustes().titular || '').trim()) throw new Error('Completá tu nombre en la hoja Ajustes (fila "titular") y volvé a ejecutar');
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'procesarCorreos'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('procesarCorreos').timeBased().everyMinutes(10).create();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CORREOS_DESDE')) {
    const inicioMes = new Date();
    inicioMes.setDate(1);
    inicioMes.setHours(0, 0, 0, 0);
    props.setProperty('CORREOS_DESDE', String(Math.floor(inicioMes.getTime() / 1000) + 600));
  }
  procesarCorreos();
}

const CATEGORIAS_EXTRA = [
  ['Transferencias', '#0d9488'], ['Auto', '#0e7490'], ['Inversiones', '#4d7c0f'],
  ['Tecnología', '#7c3aed'], ['Educación', '#b45309'],
];

function asegurarHojasLecturas() {
  const ss = SpreadsheetApp.getActive();
  ['Registro', 'Ajustes', 'Ingresos', 'Destinatarios', 'PagosTarjeta', 'Comercios'].forEach(function (nombre) {
    const sh = ss.getSheetByName(nombre) || ss.insertSheet(nombre);
    if (sh.getLastRow() === 0) sh.appendRow(HOJAS[nombre]);
  });
  const aj = ss.getSheetByName('Ajustes');
  const claves = aj.getDataRange().getValues().map(function (f) { return String(f[0]); });
  if (claves.indexOf('titular') === -1) aj.appendRow(['titular', '']);
  ['USD', 'EUR', 'BRL', 'ARS'].forEach(function (mon) {
    if (claves.indexOf(mon) !== -1) return;
    aj.appendRow([mon, '']);
    aj.getRange(aj.getLastRow(), 2).setFormula('=GOOGLEFINANCE("CURRENCY:' + mon + 'PYG")');
  });
  const cats = leerObjetos('Categorias').map(function (x) { return String(x.nombre); });
  CATEGORIAS_EXTRA.forEach(function (c) {
    if (cats.indexOf(c[0]) === -1) ss.getSheetByName('Categorias').appendRow(c);
  });
}

function ajustes() {
  const sh = SpreadsheetApp.getActive().getSheetByName('Ajustes');
  const out = {};
  if (!sh) return out;
  sh.getDataRange().getValues().forEach(function (f) { if (f[0]) out[String(f[0]).trim()] = f[1]; });
  return out;
}

function cotizacion(moneda) {
  const v = Number(ajustes()[moneda]);
  if (!v || isNaN(v)) throw new Error('Sin cotización ' + moneda + ' en la hoja Ajustes');
  return v;
}

const MAX_REGISTRO = 2000;

function registrar(fuente, aviso, resultado, detalle) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Registro');
  if (!sh) return;
  sh.appendRow([normalizarFecha(''), fuente, aviso, resultado, String(detalle || '').slice(0, 500)]);
  if (CACHE_REGISTRO && !SE_PUEDE_REPROCESAR.test(resultado)) CACHE_REGISTRO.add(aviso);
  if (sh.getLastRow() > MAX_REGISTRO + 200) sh.deleteRows(2, 200);
}

function filasRegistro() {
  const sh = SpreadsheetApp.getActive().getSheetByName('Registro');
  return sh ? sh.getDataRange().getValues() : [];
}

// Durante procesarCorreos se cachean los avisos ya registrados: evita releer la hoja por cada mail.
let CACHE_REGISTRO = null;

/** Los errores y los formatos no reconocidos no cuentan: si se reenvían (p. ej. tras sumar un formato), se reprocesan. */
const SE_PUEDE_REPROCESAR = /^(error|ignorado: formato)/;

function yaRegistrado(aviso) {
  if (CACHE_REGISTRO) return CACHE_REGISTRO.has(aviso);
  return filasRegistro().some(function (f) { return String(f[2]) === aviso && !SE_PUEDE_REPROCESAR.test(String(f[3])); });
}

function aliasFusion(aviso) {
  const f = filasRegistro().filter(function (x) { return String(x[2]) === aviso && /^fusionado con /.test(String(x[3])); })[0];
  return f ? String(f[3]).replace('fusionado con ', '') : '';
}

/** "JOSE CARLOS RODRIGUEZ MACKE" vs "José Carlos Rodriguez Macke" / "RODRIGUEZ MACKE, JOSE CARLOS". */
function esTitular(nombre, titular) {
  const palabras = function (s) { return normalizar(s).replace(/[^a-z ]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 2; }); };
  const n = palabras(nombre);
  const t = palabras(titular);
  if (!n.length || !t.length) return false;
  const comunes = t.filter(function (w) { return n.indexOf(w) !== -1; }).length;
  if (comunes >= Math.min(3, t.length)) return true;
  // Abreviado: todas sus palabras son del titular, empieza por su primer nombre y trae al menos un apellido.
  return n.length >= 2 && n[0] === t[0] && n.every(function (w) { return t.indexOf(w) !== -1; });
}

/** "CLOUDFLARE            SAN FRANCISCO USA" -> "CLOUDFLARE" (el SMS separa comercio y ciudad con varios espacios). */
function limpiarComercio(s) {
  const t = String(s || '').replace(/\n/g, ' ').trim();
  const partes = t.split(/\s{2,}/);
  return (partes.length > 1 ? partes[0] : t.replace(/\s+[A-Z]{3}$/, '')).trim();
}

function textoPlano(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(tr|p|div|h\d|li|table)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&([aeiou])acute;/g, function (m, v) { return { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' }[v]; })
    .replace(/&ntilde;/g, 'ñ')
    .replace(/[ \t]+/g, ' ');
}

/** Valor que sigue a "Etiqueta:" en tablas de texto ("| Etiqueta: | valor |"). */
function campo(texto, etiqueta) {
  const m = String(texto).match(new RegExp(etiqueta + '\\s*:\\s*\\|?\\s*([^|\\n]+)', 'i'));
  return m ? m[1].trim() : '';
}

/** "10/11/2026 09:25:41" o "12/11/26 09:25" -> "2026-11-10 09:25"; vacío -> ahora. */
function fechaDeTexto(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{2}|\d{4})\s+(\d{2}:\d{2})/);
  if (!m) return normalizarFecha('');
  return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + m[2] + '-' + m[1] + ' ' + m[4];
}

function titulo(s) {
  return String(s || '').trim().toLowerCase().replace(/(^|[\s\-/.(])(\S)/g, function (m, a, b) { return a + b.toUpperCase(); });
}

// ---------- IA (Gemini, plan gratuito) ----------
//
// La clave se pega en la hoja Ajustes (fila "gemini_key"). Sin clave, todo funciona como antes.
// A Gemini se le manda lo mínimo: textos de avisos, nombres de comercios y montos agregados;
// nunca el token ni números de cuenta.

const IA_MODELO_DEFECTO = 'gemini-3.8-flash';
const IA_PAUSA_SEG = 30 * 60;
const iaEnPausa = function () { return !!CacheService.getScriptCache().get('ia-pausa'); };

function iaDisponible() {
  return !!String(ajustes().gemini_key || '').trim();
}

/** Llama a Gemini. Con json=true pide y parsea una respuesta JSON. */
function gemini(prompt, json) {
  const aj = ajustes();
  const clave = String(aj.gemini_key || '').trim();
  if (!clave) throw new Error('IA sin configurar: falta gemini_key en la hoja Ajustes');
  let principal = String(aj.gemini_modelo || IA_MODELO_DEFECTO).trim();
  const cuerpo = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } };
  if (json) cuerpo.generationConfig.responseMimeType = 'application/json';
  const pedir = function (modelo) {
    return UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': clave },
      payload: JSON.stringify(cuerpo),
      muteHttpExceptions: true,
    });
  };
  const saturado = function (code) { return code === 429 || code >= 500; };
  // Si hace poco el principal estaba saturado y otro respondió, se usa ese directo (1 h).
  const cacheIA = CacheService.getScriptCache();
  const activo = cacheIA.get('modelo-activo');
  if (activo) {
    const rapido = pedir(activo);
    if (rapido.getResponseCode() === 200) return leerRespuestaGemini(rapido, json);
    cacheIA.remove('modelo-activo');
  }
  let r = pedir(principal);
  // Modelo retirado (404 que sugiere otro): se cambia solo y se guarda.
  const sugerido = r.getResponseCode() === 404 && (r.getContentText().match(/use models\/([a-z0-9.\-]+)/i) || [])[1];
  if (sugerido && sugerido !== principal) {
    principal = sugerido;
    fijarAjuste('gemini_modelo', principal);
    r = pedir(principal);
  }
  // Saturación: un reintento corto y después los otros modelos "flash" de la cuenta, del más nuevo al más viejo.
  if (saturado(r.getResponseCode())) {
    Utilities.sleep(1200);
    r = pedir(principal);
  }
  if (saturado(r.getResponseCode())) {
    const alternativos = modelosAlternativos(clave, principal);
    for (let i = 0; i < alternativos.length && i < 3 && saturado(r.getResponseCode()); i++) {
      r = pedir(alternativos[i]);
      if (r.getResponseCode() === 200) cacheIA.put('modelo-activo', alternativos[i], 3600);
    }
  }
  if (r.getResponseCode() !== 200) {
    const code = r.getResponseCode();
    if (saturado(code)) {
      CacheService.getScriptCache().put('ia-pausa', '1', IA_PAUSA_SEG);
      throw new Error('La IA de Google está saturada en este momento, probá de nuevo en un rato');
    }
    throw new Error('Gemini ' + code + ': ' + r.getContentText().slice(0, 200));
  }
  return leerRespuestaGemini(r, json);
}

function leerRespuestaGemini(r, json) {
  const datos = JSON.parse(r.getContentText());
  const texto = ((((datos.candidates || [])[0] || {}).content || {}).parts || []).map(function (p) { return p.text || ''; }).join('').trim();
  if (!json) return texto;
  const m = texto.match(/[\[{][\s\S]*[\]}]/);
  return JSON.parse(m ? m[0] : texto);
}

/** Modelos "flash" que la clave puede usar (ListModels), sin el principal; se guardan 6 h en caché. */
function modelosAlternativos(clave, principal) {
  const cache = CacheService.getScriptCache();
  let lista = null;
  try { lista = JSON.parse(cache.get('modelos-ia') || 'null'); } catch (err) { lista = null; }
  if (!lista) {
    lista = [];
    try {
      const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
        headers: { 'x-goog-api-key': clave }, muteHttpExceptions: true,
      });
      if (r.getResponseCode() === 200) {
        lista = (JSON.parse(r.getContentText()).models || [])
          .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1; })
          .map(function (m) { return String(m.name || '').replace(/^models\//, ''); })
          .filter(function (n) { return /flash/.test(n) && !/(image|tts|audio|live|thinking|embedding|exp)/.test(n); });
        // Más nuevo primero (por número de versión); las "lite" al final.
        const version = function (n) { const v = n.match(/(\d+(?:\.\d+)?)/); return v ? Number(v[1]) : 0; };
        lista.sort(function (a, b) { return (/lite/.test(a) - /lite/.test(b)) || (version(b) - version(a)) || a.localeCompare(b); });
      }
    } catch (err) { lista = []; }
    cache.put('modelos-ia', JSON.stringify(lista), 6 * 3600);
  }
  return lista.filter(function (n) { return n !== principal; });
}

/** Igual que gemini() pero nunca rompe: ante cualquier error devuelve null y lo anota en el Registro. */
function geminiSeguro(prompt, json, contexto) {
  if (!iaDisponible() || iaEnPausa()) return null;
  try {
    return gemini(prompt, json);
  } catch (err) {
    registrar('ia', 'ia-' + resumenHex(contexto + Date.now()), 'error: ' + err.message, contexto);
    return null;
  }
}

function infoIA() {
  const aj = ajustes();
  let resumen = null;
  try { resumen = JSON.parse(String(aj.resumen_semanal || 'null')); } catch (err) { /* sin resumen */ }
  return {
    disponible: iaDisponible(),
    resumen: resumen,
    consultarSiempre: String(aj.consultar_siempre || '').split(',').map(function (s) { return s.trim(); }).filter(String),
    metaAhorro: Number(aj.meta_ahorro) || 0,
  };
}

const AJUSTES_EDITABLES = ['meta_ahorro', 'susc_descartadas'];

function guardarAjuste(clave, valor) {
  if (AJUSTES_EDITABLES.indexOf(clave) === -1) throw new Error('Ajuste no editable: ' + clave);
  fijarAjuste(clave, valor);
  return infoIA();
}

function fijarAjuste(clave, valor) {
  asegurarHojasLecturas();
  const sh = hoja('Ajustes');
  const datos = sh.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    if (String(datos[i][0]) === clave) { sh.getRange(i + 1, 2, 1, 1).setValues([[valor]]); return; }
  }
  sh.appendRow([clave, valor]);
}

// --- IA 1: avisos con formato no reconocido ---

/** Si el lector fijo no reconoció el aviso, lo intenta leer la IA. Devuelve el aviso original si no hay IA o falla. */
function conLectorIA(av, texto, fuente) {
  if (!av || av.tipo !== 'ignorar' || !/formato/.test(av.motivo || '') || yaRegistrado(av.id)) return av;
  if (!/informa|banco|tarjeta|transf|monto|\bGs\b|PYG|USD/i.test(String(texto))) return av;
  const r = geminiSeguro(
    'Sos un lector de avisos bancarios de Paraguay. Leé este ' + fuente + ' y devolvé SOLO un JSON con: ' +
    '{"tipo": "compra" | "pago_tarjeta" | "transferencia_enviada" | "transferencia_recibida" | "otro", ' +
    '"monto": texto con moneda, ej. "Gs 30.000" o "USD 9,99", "comercio": nombre del comercio o persona (vacío si no hay), ' +
    '"tarjeta": tarjeta o cuenta si aparece, "fecha": "dd/mm/aaaa hh:mm" si aparece, si no ""}. ' +
    '"pago_tarjeta" es cuando el cliente paga su propia tarjeta de crédito (no es una compra). ' +
    'Si no es un movimiento de dinero, tipo "otro".\n\nAviso:\n' + String(texto).slice(0, 1200),
    true, 'lector ' + fuente);
  if (!r || !r.tipo) return av;
  const base = { fuente: fuente, id: av.id, texto: av.texto, porIA: true };
  if (r.tipo === 'compra' && r.monto) {
    return Object.assign(base, { tipo: 'gasto', gasto: { monto: r.monto, comercio: r.comercio || '', tarjeta: r.tarjeta || '', fecha: fechaDeTexto(r.fecha), origen: fuente } });
  }
  if (r.tipo === 'pago_tarjeta' && r.monto) {
    return Object.assign(base, { tipo: 'pagoTarjeta', pago: { monto: r.monto, tarjeta: r.tarjeta || '', fecha: fechaDeTexto(r.fecha) } });
  }
  if (r.tipo === 'transferencia_enviada' && r.monto) {
    const tr = transferenciaEnviada({ fuente: fuente, texto: av.texto }, av.id, { monto: r.monto, beneficiario: r.comercio || '', fecha: r.fecha || '', banco: r.tarjeta || '' });
    return Object.assign(tr, { porIA: true });
  }
  if (r.tipo === 'transferencia_recibida' && r.monto) {
    const ing = ingresoRecibido({ fuente: fuente, texto: av.texto }, av.id, { monto: r.monto, pagador: r.comercio || '', fecha: r.fecha || '', banco: r.tarjeta || '' });
    return Object.assign(ing, { porIA: true });
  }
  return Object.assign(av, { motivo: 'no es un movimiento (según IA)' });
}

// --- IA 2 y 3: nombre unificado y categoría de comercios ---

function claveComercio(comercio) {
  return normalizar(comercio).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function nombresCategorias() {
  return leerConfig().categorias.map(function (c) { return c.nombre; }).filter(function (n) { return n !== POR_REVISAR; });
}

/** Nombre limpio y categoría de un comercio: primero la hoja Comercios, si no, la IA (y se guarda). */
function infoComercio(comercio, conIA) {
  const clave = claveComercio(comercio);
  if (!clave) return null;
  const sh = SpreadsheetApp.getActive().getSheetByName('Comercios');
  if (sh) {
    const fila = leerObjetos('Comercios').filter(function (r) { return String(r.clave) === clave; })[0];
    if (fila) return { nombre: String(fila.nombre || ''), categoria: String(fila.categoria || '') };
  }
  if (!conIA || !iaDisponible()) return null; // en Apple Pay/SMS no se espera a la IA: lo clasifica tareasIA()
  const r = clasificarComerciosIA([comercio])[0];
  if (!r) return null;
  guardarComercio(clave, r.nombre, r.categoria, 'ia');
  return r;
}

/** Pide a la IA nombre limpio + categoría para una lista de comercios. Devuelve [{nombre, categoria}] en el mismo orden. */
function clasificarComerciosIA(comercios) {
  const cats = nombresCategorias();
  const r = geminiSeguro(
    'Para cada comercio de pagos con tarjeta en Paraguay, devolvé su nombre comercial limpio y su categoría. ' +
    'Nombre limpio: la marca, sin ciudad, sucursal, país ni códigos (ej. "Hiperseis hypermarket" y "Selfcheckout-S6 Hiper" → "Superseis"; ' +
    '"BURGER KING-MCAL.LOPEZ ASUNCION" → "Burger King"; "OPENAI *CHATGPT SUBSCR" → "ChatGPT"). ' +
    'Categoría: una de ' + JSON.stringify(cats) + ' (si no estás seguro, "' + CATEGORIA_DEFECTO + '"). ' +
    'Devolvé SOLO un JSON: [{"nombre": "...", "categoria": "..."}] en el mismo orden.\n\nComercios:\n' +
    comercios.map(function (c, i) { return (i + 1) + '. ' + c; }).join('\n'),
    true, 'comercios');
  if (!Array.isArray(r)) return [];
  return comercios.map(function (c, i) {
    const x = r[i] || {};
    return { nombre: String(x.nombre || '').trim(), categoria: cats.indexOf(x.categoria) !== -1 ? x.categoria : CATEGORIA_DEFECTO };
  });
}

function guardarComercio(clave, nombre, categoria, fuente) {
  asegurarHojasLecturas();
  const sh = hoja('Comercios');
  const datos = sh.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    if (String(datos[i][0]) === clave) { sh.getRange(i + 1, 1, 1, 4).setValues([[clave, nombre, categoria, fuente]]); return; }
  }
  sh.appendRow([clave, nombre, categoria, fuente]);
}

/** Una vez: unifica nombres de comercios ya registrados y categoriza los que estaban en "Otros". */
function unificarComerciosExistentes(limite) {
  if (!iaDisponible()) throw new Error('Falta la clave de Gemini en la hoja Ajustes');
  asegurarHojasLecturas();
  const sh = hoja('Gastos');
  const datos = sh.getDataRange().getValues();
  const c = {};
  HOJAS.Gastos.forEach(function (k, i) { c[k] = i; });
  const conocidos = {};
  leerObjetos('Comercios').forEach(function (r) { conocidos[String(r.clave)] = r; });
  const nuevos = [];
  for (let i = 1; i < datos.length; i++) {
    const com = String(datos[i][c.comercio]);
    const auto = FUENTES_COMERCIO.indexOf(fuenteDe(datos[i][c.origen])) !== -1;
    if (!auto || !com || /^Transferencia a /i.test(com)) continue;
    const k = claveComercio(com);
    if (k && !conocidos[k] && nuevos.indexOf(com) === -1 && !nuevos.some(function (x) { return claveComercio(x) === k; })) nuevos.push(com);
  }
  if (limite) nuevos.splice(limite);
  for (let i = 0; i < nuevos.length; i += 40) {
    const lote = nuevos.slice(i, i + 40);
    clasificarComerciosIA(lote).forEach(function (r, j) {
      if (!r.nombre) return;
      const k = claveComercio(lote[j]);
      guardarComercio(k, r.nombre, r.categoria, 'ia');
      conocidos[k] = { nombre: r.nombre, categoria: r.categoria };
    });
  }
  let cambios = 0;
  for (let i = 1; i < datos.length; i++) {
    const f = datos[i];
    const com = String(f[c.comercio]);
    const auto = FUENTES_COMERCIO.indexOf(fuenteDe(f[c.origen])) !== -1;
    const info = auto && conocidos[claveComercio(com)];
    if (!info) continue;
    let cambio = false;
    if (info.nombre && info.nombre !== com) { f[c.comercio] = info.nombre; cambio = true; }
    if (String(f[c.categoria]) === CATEGORIA_DEFECTO && info.categoria && info.categoria !== CATEGORIA_DEFECTO) { f[c.categoria] = info.categoria; cambio = true; }
    if (cambio) { sh.getRange(i + 1, 1, 1, f.length).setValues([f]); cambios++; }
  }
  return { comerciosNuevos: nuevos.length, gastosActualizados: cambios };
}

// --- IA 4: sugerencias para "Por revisar" ---

function sugerirPorRevisar() {
  const gastos = listarGastos('');
  const pendientes = gastos.filter(function (g) { return g.categoria === POR_REVISAR; }).slice(0, 30);
  if (!pendientes.length || !iaDisponible()) return [];
  const nombreDe = function (g) { return String(g.comercio).replace(/^Transferencia a /i, ''); };
  const items = pendientes.map(function (g) {
    const n = nombreDe(g);
    const historial = gastos
      .filter(function (x) { return x.id !== g.id && x.categoria !== POR_REVISAR && coincideNombre(x.comercio, n.split(' ').slice(0, 2).join(' ')); })
      .slice(0, 5)
      .map(function (x) { return x.fecha.slice(0, 10) + ' ' + x.monto + ' ' + x.comercio + ' → ' + x.categoria; });
    return { id: g.id, destinatario: n, monto: g.monto, fecha: g.fecha, historial: historial };
  });
  const r = geminiSeguro(
    'Estas son transferencias enviadas que el usuario todavía no clasificó. Para cada una sugerí la categoría más probable ' +
    'usando su historial con esa persona (si no hay historial, usá el monto y el nombre; si no se puede saber, "' + CATEGORIA_DEFECTO + '"). ' +
    'Categorías válidas: ' + JSON.stringify(nombresCategorias()) + '. ' +
    'Devolvé SOLO un JSON: [{"id": "...", "categoria": "...", "motivo": "frase corta en español"}].\n\n' + JSON.stringify(items),
    true, 'sugerencias');
  if (!Array.isArray(r)) return [];
  const cats = nombresCategorias();
  return r.filter(function (x) { return x && x.id && cats.indexOf(x.categoria) !== -1; })
    .map(function (x) { return { id: String(x.id), categoria: x.categoria, motivo: String(x.motivo || '').slice(0, 140) }; });
}

// --- IA 5, 6 y 10: preguntas, resumen semanal y consejo del mes ---

/** Datos compactos (sin cuentas ni tokens) para que la IA responda sobre los gastos. */
function contextoFinanciero(diasDetalle) {
  const gastos = listarGastos('').filter(function (g) { return g.categoria !== POR_REVISAR && !g.tercero; });
  const ingresos = listarIngresos('');
  const porMes = {};
  gastos.forEach(function (g) {
    const m = g.fecha.slice(0, 7);
    porMes[m] = porMes[m] || { gastos: {}, ingresos: {} };
    porMes[m].gastos[g.categoria] = (porMes[m].gastos[g.categoria] || 0) + g.monto;
  });
  ingresos.forEach(function (i) {
    const m = i.fecha.slice(0, 7);
    porMes[m] = porMes[m] || { gastos: {}, ingresos: {} };
    porMes[m].ingresos[i.categoria] = (porMes[m].ingresos[i.categoria] || 0) + i.monto;
  });
  const desde = Utilities.formatDate(new Date(Date.now() - diasDetalle * 864e5), TZ, 'yyyy-MM-dd');
  return {
    hoy: normalizarFecha(''),
    presupuestos: leerConfig().presupuestos,
    totalesPorMes: porMes,
    gastosRecientes: gastos.filter(function (g) { return g.fecha >= desde; }).slice(0, 400)
      .map(function (g) { return [g.fecha, g.monto, g.comercio, g.categoria]; }),
    ingresosRecientes: ingresos.filter(function (i) { return i.fecha >= desde; }).slice(0, 300)
      .map(function (i) { return [i.fecha, i.monto, i.pagador, i.categoria]; }),
  };
}

const ESTILO_IA = 'Respondé en español rioplatense, breve y concreto. Montos en guaraníes con punto de miles (ej. Gs 1.250.000). ' +
  'Usá solo los datos dados; si no alcanzan, decilo.';

/** IA 6: "¿y si…?" — impacto mensual y anual de un cambio de hábito, con su promedio de los últimos 3 meses. */
function simular(escenario) {
  if (!escenario.trim()) throw new Error('Escribí un escenario');
  if (!iaDisponible()) throw new Error('La IA no está configurada');
  return gemini('Sos el asistente de finanzas personales del usuario y simulás escenarios "¿y si…?". ' + ESTILO_IA +
    ' Calculá el gasto mensual actual de las categorías y comercios involucrados con el promedio de los meses que haya (hasta 3); ' +
    'si solo hay el mes en curso, proyectalo a mes completo según los días transcurridos y aclaralo en una frase. ' +
    'Si el escenario menciona algo que no aparece tal cual (ej. delivery), usá comercios o categorías parecidas y decí cuáles. ' +
    'Respondé con: cuánto gasta hoy por mes en eso, cuánto ahorraría por mes y por año con el cambio, y a qué equivale ese ahorro ' +
    '(ej. % de su gasto mensual o cuántos meses de alguna suscripción). Máximo 6 líneas.' +
    '\n\nDatos (gastosRecientes: [fecha, monto, comercio, categoría]):\n' + JSON.stringify(contextoFinanciero(100)) +
    '\n\nEscenario: ' + escenario.slice(0, 400), false);
}

/** IA 4: en una o dos frases, por qué este mes va distinto del anterior (mismo tramo de días). */
function explicarMes(mes) {
  if (!iaDisponible()) throw new Error('La IA no está configurada');
  mes = mes || normalizarFecha('').slice(0, 7);
  const hoy = normalizarFecha('');
  const enCurso = hoy.slice(0, 7) === mes;
  const dia = enCurso ? Number(hoy.slice(8, 10)) : 31;
  const p = new Date(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)) - 2, 1);
  const previo = Utilities.formatDate(p, TZ, 'yyyy-MM');
  const contables = listarGastos('').filter(function (g) { return g.categoria !== POR_REVISAR && !g.tercero; });
  const tramo = function (m) {
    return contables.filter(function (g) { return g.fecha.indexOf(m) === 0 && Number(g.fecha.slice(8, 10)) <= dia; });
  };
  const resumir = function (lista) {
    const cats = {};
    lista.forEach(function (g) { cats[g.categoria] = (cats[g.categoria] || 0) + g.monto; });
    return {
      total: lista.reduce(function (t, g) { return t + g.monto; }, 0),
      porCategoria: cats,
      mayores: lista.slice().sort(function (a, b) { return b.monto - a.monto; }).slice(0, 8)
        .map(function (g) { return [g.fecha.slice(0, 10), g.monto, g.comercio, g.categoria]; }),
    };
  };
  const clave = 'explica-' + mes + '-' + dia + '-' + resumenHex(JSON.stringify([resumir(tramo(mes)), resumir(tramo(previo))]));
  const cache = CacheService.getScriptCache();
  const guardado = cache.get(clave);
  if (guardado) return guardado;
  const texto = gemini('Explicá en UNA o DOS frases cortas por qué el usuario gastó más o menos este mes que el anterior, ' +
    (enCurso ? 'comparando ambos meses hasta el día ' + dia + '. ' : 'comparando los meses completos. ') +
    'Nombrá las 1 o 2 causas principales con su monto (categoría o gasto puntual grande). Sin saludo ni viñetas. ' + ESTILO_IA +
    '\n\nEste mes (' + mes + '): ' + JSON.stringify(resumir(tramo(mes))) +
    '\nMes anterior (' + previo + '): ' + JSON.stringify(resumir(tramo(previo))), false);
  cache.put(clave, texto, 6 * 3600);
  return texto;
}

/**
 * IA 3: cobros que se repiten todos los meses con monto parecido y todavía no están en Suscripciones.
 * Sin IA devuelve los candidatos por regla; con IA, Gemini descarta los que no son servicios recurrentes.
 */
function suscripcionesNuevas() {
  const hoy = normalizarFecha('');
  const d = new Date(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)) - 4, 1);
  const desde = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  let descartadas = [];
  try { descartadas = JSON.parse(String(ajustes().susc_descartadas || '[]')); } catch (err) { /* lista vacía */ }
  const grupos = {};
  listarGastos('').forEach(function (g) {
    if (g.fecha < desde || g.tercero || /^Transferencia a /i.test(g.comercio)) return;
    if (['Suscripciones', POR_REVISAR, 'Transferencias', 'Créditos'].indexOf(g.categoria) !== -1) return;
    const palabras = claveComercio(g.comercio).split(' ').filter(function (w) { return w.length > 1; });
    if (!palabras.length) return;
    const k = palabras[0].length >= 4 ? palabras[0] : palabras.slice(0, 2).join(' ');
    (grupos[k] = grupos[k] || []).push(g);
  });
  const candidatos = [];
  Object.keys(grupos).forEach(function (k) {
    if (descartadas.indexOf(k) !== -1) return;
    const lista = grupos[k];
    const meses = {};
    lista.forEach(function (g) { (meses[g.fecha.slice(0, 7)] = meses[g.fecha.slice(0, 7)] || []).push(g.monto); });
    const claves = Object.keys(meses).sort();
    if (claves.length < 2) return;
    if (claves.some(function (m) { return meses[m].length > 2; })) return; // compras frecuentes, no un cobro mensual
    const montos = claves.map(function (m) { return meses[m][0]; });
    const ref = montos[montos.length - 1];
    if (!montos.every(function (x) { return Math.abs(x - ref) <= ref * 0.15; })) return;
    const ultimo = lista[0];
    candidatos.push({ clave: k, comercio: ultimo.comercio, categoria: ultimo.categoria, monto: ref, meses: claves.length, ultimo: ultimo.fecha.slice(0, 10), id: ultimo.id });
  });
  if (!candidatos.length || !iaDisponible()) {
    return candidatos.filter(function (c) { return ['Supermercado', 'Combustible', 'Restaurantes'].indexOf(c.categoria) === -1; });
  }
  const cache = CacheService.getScriptCache();
  const clave = 'susc-' + resumenHex(JSON.stringify(candidatos));
  const enCache = cache.get(clave);
  if (enCache) return JSON.parse(enCache);
  const r = geminiSeguro('Estos comercios le cobran al usuario casi el mismo monto una vez por mes. Decidí cuáles son ' +
    'servicios o suscripciones recurrentes (streaming, software, telefonía, internet, gimnasio, seguros, cuotas de servicio, etc.) ' +
    'y cuáles son compras que casualmente se repiten (supermercado, combustible, restaurantes). ' +
    'Devolvé SOLO un JSON: [{"clave": "...", "nombre": "nombre comercial limpio", "motivo": "frase corta"}] con los que SÍ son recurrentes.\n\n' +
    JSON.stringify(candidatos.map(function (c) { return { clave: c.clave, comercio: c.comercio, categoria: c.categoria, monto: c.monto, meses: c.meses }; })),
    true, 'suscripciones nuevas');
  if (!Array.isArray(r)) return candidatos.filter(function (c) { return ['Supermercado', 'Combustible', 'Restaurantes'].indexOf(c.categoria) === -1; });
  const elegidos = r.map(function (x) {
    const c = candidatos.filter(function (y) { return y.clave === String(x && x.clave); })[0];
    return c ? Object.assign({}, c, { nombre: String(x.nombre || '').slice(0, 60), motivo: String(x.motivo || '').slice(0, 120) }) : null;
  }).filter(Boolean);
  cache.put(clave, JSON.stringify(elegidos), 12 * 3600);
  return elegidos;
}

function preguntarGastos(pregunta) {
  if (!pregunta.trim()) throw new Error('Escribí una pregunta');
  if (!iaDisponible()) throw new Error('La IA no está configurada');
  return gemini('Sos el asistente de finanzas personales del usuario. ' + ESTILO_IA +
    '\n\nDatos (gastosRecientes y ingresosRecientes: [fecha, monto, comercio/pagador, categoría]):\n' + JSON.stringify(contextoFinanciero(120)) +
    '\n\nPregunta: ' + pregunta.slice(0, 500), false);
}

function consejoMes(mes) {
  if (!iaDisponible()) throw new Error('La IA no está configurada');
  const meta = Number(ajustes().meta_ahorro) || 0;
  return gemini('Sos un coach de finanzas personales. ' + ESTILO_IA +
    ' Mes: ' + (mes || normalizarFecha('').slice(0, 7)) + '. Meta de ahorro mensual: Gs ' + formatearGs(meta) + '. ' +
    'Decí cómo viene el mes (ingresos, gastos, ahorro proyectado), cuánto puede gastar por día hasta fin de mes para cumplir la meta, ' +
    'y 2 o 3 recomendaciones puntuales basadas en sus categorías y comercios. Máximo 8 líneas.\n\nDatos:\n' + JSON.stringify(contextoFinanciero(45)), false);
}

/** Lunes 8 AM: resumen de la semana por IA, guardado en Ajustes (lo muestra la app) y enviado por mail al titular. */
function resumenSemanal(forzar) {
  if (!iaDisponible()) return null;
  const texto = geminiSeguro('Escribí el resumen semanal de finanzas del usuario. ' + ESTILO_IA +
    ' Incluí: cuánto gastó en los últimos 7 días vs. su promedio semanal, las categorías que más subieron, ' +
    'las suscripciones cobradas, cómo vienen los ingresos (sueldo y ventas) y un consejo para la semana. Máximo 10 líneas, con viñetas.' +
    '\n\nDatos:\n' + JSON.stringify(contextoFinanciero(35)), false, 'resumen semanal');
  if (!texto) return null;
  const resumen = { fecha: normalizarFecha(''), texto: texto };
  fijarAjuste('resumen_semanal', JSON.stringify(resumen));
  if (!forzar) {
    try {
      GmailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Gastos · resumen de la semana', texto);
    } catch (err) { registrar('ia', 'mail-' + Date.now(), 'error: ' + err.message, 'envío del resumen'); }
  }
  return resumen;
}

/** Ejecutar una vez (tras pegar gemini_key en Ajustes): activador del resumen y unificación de comercios. */
function instalarIA() {
  asegurarHojasLecturas();
  const aj = ajustes();
  if (aj.gemini_modelo === undefined) fijarAjuste('gemini_modelo', IA_MODELO_DEFECTO);
  if (aj.gemini_key === undefined) fijarAjuste('gemini_key', '');
  if (aj.consultar_siempre === undefined) fijarAjuste('consultar_siempre', '');
  if (aj.meta_ahorro === undefined) fijarAjuste('meta_ahorro', 0);
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'resumenSemanal'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('resumenSemanal').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).inTimezone(TZ).create();
  // Prueba de conexión (pide el permiso de servicios externos aunque todavía no haya clave).
  UrlFetchApp.fetch('https://generativelanguage.googleapis.com/', { muteHttpExceptions: true });
  if (iaDisponible()) Logger.log(JSON.stringify(unificarComerciosExistentes()));
}

// ---------- Estado del sistema ----------

/** Cuándo llegó por última vez cada fuente, si la lectura de mails corre y los últimos avisos. */
function estadoSistema() {
  const reg = filasRegistro().slice(1).map(function (f) {
    return { fecha: textoFecha(f[0]), fuente: String(f[1]), aviso: String(f[2]), resultado: String(f[3]), detalle: String(f[4] || '') };
  });
  const ultimo = function (filtro) {
    for (let i = reg.length - 1; i >= 0; i--) if (filtro(reg[i])) return reg[i].fecha;
    return '';
  };
  let applepay = '';
  leerObjetos('Gastos').forEach(function (g) {
    const f = textoFecha(g.fecha);
    if (/applepay/.test(String(g.origen)) && f > applepay) applepay = f;
  });
  ultimo(function (r) { if (r.fuente === 'applepay' && r.fecha > applepay) applepay = r.fecha; return false; });

  let respaldo = '';
  try {
    const carpetas = DriveApp.getFoldersByName(CARPETA_RESPALDOS);
    if (carpetas.hasNext()) {
      const archivos = carpetas.next().getFiles();
      while (archivos.hasNext()) {
        const f = Utilities.formatDate(archivos.next().getDateCreated(), TZ, 'yyyy-MM-dd HH:mm');
        if (f > respaldo) respaldo = f;
      }
    }
  } catch (err) { /* sin permiso de Drive: se informa vacío */ }

  const hace7 = Utilities.formatDate(new Date(Date.now() - 7 * 864e5), TZ, 'yyyy-MM-dd HH:mm');
  return {
    ahora: normalizarFecha(''),
    lecturaCorreos: PropertiesService.getScriptProperties().getProperty('CORREOS_ULTIMA_CORRIDA') || '',
    applepay: applepay,
    smsGnb: ultimo(function (r) { return r.fuente === 'sms' && /banco gnb/i.test(r.detalle); }),
    smsContinental: ultimo(function (r) { return r.fuente === 'sms' && /continental/i.test(r.detalle); }),
    mail: ultimo(function (r) { return r.fuente === 'mail'; }),
    respaldo: respaldo,
    errores: reg.filter(function (r) { return /^error/.test(r.resultado) && r.fecha >= hace7; }).length,
    ultimosAvisos: reg.slice(-20).reverse().map(function (r) {
      return { fecha: r.fecha, fuente: r.fuente, resultado: r.resultado, detalle: r.detalle.replace(/\s+/g, ' ').slice(0, 140) };
    }),
  };
}

// ---------- Respaldo semanal ----------

const CARPETA_RESPALDOS = 'Gastos - respaldos';
const RESPALDOS_A_GUARDAR = 8;

/** Copia la planilla a la carpeta de respaldos y manda a la papelera las copias más viejas. */
function respaldoSemanal() {
  const ss = SpreadsheetApp.getActive();
  const carpetas = DriveApp.getFoldersByName(CARPETA_RESPALDOS);
  const carpeta = carpetas.hasNext() ? carpetas.next() : DriveApp.createFolder(CARPETA_RESPALDOS);
  DriveApp.getFileById(ss.getId())
    .makeCopy(ss.getName() + ' - respaldo ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), carpeta);

  const copias = [];
  const archivos = carpeta.getFiles();
  while (archivos.hasNext()) copias.push(archivos.next());
  copias.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  copias.slice(RESPALDOS_A_GUARDAR).forEach(function (f) { f.setTrashed(true); });
}

/** Ejecutar una vez: programa el respaldo los domingos a las 3 AM y hace el primero. */
function instalarRespaldo() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'respaldoSemanal'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('respaldoSemanal').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).inTimezone(TZ).create();
  respaldoSemanal();
}

// ---------- Utilidades ----------

function primero() {
  for (let i = 0; i < arguments.length; i++) {
    if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i];
  }
  return undefined;
}

function resumenHex(texto) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, texto, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('')
    .slice(0, 20);
}

/** "Gs 150.000", "₲150,000", "PYG 150.000,00", 150000 -> 150000 (guaraníes no tienen decimales). */
function parsearMonto(v) {
  if (typeof v === 'number') return Math.abs(Math.round(v));
  let s = String(v || '').replace(/[^\d.,]/g, '');
  s = s.replace(/[.,]\d{1,2}$/, ''); // descarta decimales
  const n = parseInt(s.replace(/\D/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function detectarMoneda(texto) {
  const t = String(texto || '');
  if (/Gs|PYG|₲/i.test(t)) return 'PYG';
  if (/R\$|BRL/i.test(t)) return 'BRL';
  if (/€|EUR/i.test(t)) return 'EUR';
  if (/ARS/i.test(t)) return 'ARS';
  if (/US\$|U\$S|USD|\$/i.test(t)) return 'USD';
  return 'PYG';
}

/** "USD 9,99" -> 9.99; "12.50" -> 12.5; "1.234,56" -> 1234.56 (decimales = 1 o 2 dígitos al final). */
function parsearDecimal(v) {
  let s = String(v || '').replace(/[^\d.,]/g, '');
  let dec = 0;
  const m = s.match(/[.,](\d{1,2})$/);
  if (m) {
    dec = Number('0.' + (m[1].length === 1 ? m[1] + '0' : m[1]));
    s = s.slice(0, -m[0].length);
  }
  return (parseInt(s.replace(/\D/g, ''), 10) || 0) + dec;
}

function categorizar(comercio, reglas) {
  const c = normalizar(comercio);
  if (c) {
    for (let i = 0; i < reglas.length; i++) {
      if (coincidePatron(c, normalizar(reglas[i].patron))) return reglas[i].categoria;
    }
  }
  return CATEGORIA_DEFECTO;
}

/** El patrón tiene que aparecer como palabra(s) completa(s): "stock" no coincide con "stockholm". */
function coincidePatron(texto, patron) {
  if (!patron) return false;
  const p = patron.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + p + '($|[^a-z0-9])').test(texto);
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
