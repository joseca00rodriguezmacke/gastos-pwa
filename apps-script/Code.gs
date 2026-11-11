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
  Gastos: ['fecha', 'monto', 'comercio', 'tarjeta', 'categoria', 'origen', 'id'],
  Categorias: ['nombre', 'color'],
  Reglas: ['patron', 'categoria'],
  Presupuestos: ['categoria', 'monto'],
  Registro: ['fecha', 'fuente', 'aviso', 'resultado', 'detalle'],
  Ajustes: ['clave', 'valor'],
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
  };
  const sh = hoja('Gastos');
  const n = buscarFilaPorId(sh, gasto.id);
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
const VENTANA_FUSION_MIN = 30;
const VENTANA_FUSION_SIN_COMERCIO_MIN = 5;

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
    if (Number(f[c.monto]) !== nuevo.monto) continue;
    const origen = String(f[c.origen]);
    const fuentes = origen.split(' · ')[0].split('+');
    if (fuentes.indexOf(fuente) !== -1 || fuentes.indexOf('manual') !== -1) continue;
    const dif = Math.abs(minutosDe(textoFecha(f[c.fecha])) - t);
    const ventana = mismoComercio(f[c.comercio], nuevo.comercio) ? VENTANA_FUSION_MIN : VENTANA_FUSION_SIN_COMERCIO_MIN;
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
    try { g = JSON.parse(linea); } catch (err) { return; }
    try { guardados.push(guardarGasto(g, true)); } catch (err) { /* monto inválido: se descarta esa línea */ }
  });
  return guardados;
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
  } else if (av.tipo === 'reverso') {
    const borrado = aplicarReverso(av.gasto);
    r = { resultado: borrado ? 'reverso aplicado' : 'reverso sin pago original', mensaje: borrado ? 'Reverso: se quitó ' + borrado : 'Reverso recibido (no se encontró el pago)' };
  } else {
    r = { resultado: 'ignorado: ' + av.motivo, mensaje: 'Ignorado: ' + av.motivo };
  }
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
  return null; // transferencias recibidas, facturas, publicidad: no son gastos
}

function transferenciaEnviada(base, id, d) {
  const titular = String(ajustes().titular || '').trim();
  if (!titular) return Object.assign(base, { id: id, tipo: 'ignorar', motivo: 'falta el titular en la hoja Ajustes' });
  if (esTitular(d.beneficiario, titular)) return Object.assign(base, { id: id, tipo: 'ignorar', motivo: 'transferencia a cuenta propia' });
  return Object.assign(base, {
    id: id,
    tipo: 'gasto',
    gasto: {
      monto: d.monto,
      comercio: 'Transferencia a ' + titulo(d.beneficiario),
      tarjeta: d.banco,
      categoria: 'Transferencias',
      fecha: fechaDeTexto(d.fecha),
      origen: 'mail',
    },
  });
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

/** Activador cada 10 minutos: lee los correos nuevos de los bancos (solo lectura). */
function procesarCorreos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const desde = Number(props.getProperty('CORREOS_DESDE')) || Math.floor(Date.now() / 1000) - 3600;
    const consulta = 'from:(' + REMITENTES_BANCO.join(' OR ') + ') after:' + (desde - 600);
    let ultimo = desde;
    GmailApp.search(consulta, 0, 100).forEach(function (hilo) {
      hilo.getMessages().forEach(function (msg) {
        const t = Math.floor(msg.getDate().getTime() / 1000);
        if (t < desde - 600) return;
        try {
          procesarAviso(parsearCorreo(msg.getFrom(), msg.getSubject(), textoPlano(msg.getBody()), msg.getId()));
        } catch (err) {
          registrar('mail', 'error-' + msg.getId(), 'error: ' + err.message, msg.getSubject());
        }
        if (t > ultimo) ultimo = t;
      });
    });
    props.setProperty('CORREOS_DESDE', String(ultimo));
  } finally {
    lock.releaseLock();
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

function asegurarHojasLecturas() {
  const ss = SpreadsheetApp.getActive();
  ['Registro', 'Ajustes'].forEach(function (nombre) {
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
  const cats = leerConfig().categorias.map(function (x) { return x.nombre; });
  if (cats.indexOf('Transferencias') === -1) ss.getSheetByName('Categorias').appendRow(['Transferencias', '#0d9488']);
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
  if (sh.getLastRow() > MAX_REGISTRO + 200) sh.deleteRows(2, 200);
}

function filasRegistro() {
  const sh = SpreadsheetApp.getActive().getSheetByName('Registro');
  return sh ? sh.getDataRange().getValues() : [];
}

function yaRegistrado(aviso) {
  return filasRegistro().some(function (f) { return String(f[2]) === aviso && !/^error/.test(String(f[3])); });
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
  return comunes >= Math.min(3, t.length);
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

/** "10/11/2026 09:25:41" -> "2026-11-10 09:25"; vacío -> ahora. */
function fechaDeTexto(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] + ' ' + m[4] : normalizarFecha('');
}

function titulo(s) {
  return String(s || '').trim().toLowerCase().replace(/(^|[\s\-/.(])(\S)/g, function (m, a, b) { return a + b.toUpperCase(); });
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
