// Arnés de pruebas: ejecuta apps-script/Code.gs real en Node con imitaciones de los servicios de Google
// (planilla, Gmail, caché, propiedades, IA). Datos 100 % ficticios: no usa cuentas ni tokens reales.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const TITULAR = 'ANA MARIA PEREZ GOMEZ';

class Hoja {
  constructor() { this.filas = []; }
  getLastRow() { return this.filas.length; }
  getLastColumn() { return Math.max(0, ...this.filas.map((f) => f.length)); }
  appendRow(f) { this.filas.push(f.slice()); }
  getRange(a, b) {
    const hoja = this;
    if (typeof a === 'string') return { setNumberFormat() { return this; } };
    return {
      setNumberFormat() { return this; },
      setFormula() { (hoja.filas[a - 1] = hoja.filas[a - 1] || [])[(b || 1) - 1] = 7300; return this; },
      setValues(valores) {
        valores.forEach((v, i) => {
          const fila = (hoja.filas[a - 1 + i] = (hoja.filas[a - 1 + i] || []).slice());
          v.forEach((x, j) => { fila[(b || 1) - 1 + j] = x; });
        });
        return this;
      },
    };
  }
  getDataRange() { const hoja = this; return { getValues: () => hoja.filas.map((f) => f.slice()) }; }
  deleteRow(n) { this.filas.splice(n - 1, 1); }
  deleteRows(n, c) { this.filas.splice(n - 1, c); }
}

/**
 * Crea un backend nuevo y vacío.
 * ia: 'sin-clave' | 'ok' | 'saturada' | función(prompt, modelo) que devuelve {code, texto}.
 */
function crearBackend({ ia = 'sin-clave' } = {}) {
  const hojas = {};
  const props = {};
  const cacheDatos = {};
  const correos = [];
  const llamadasIA = [];
  const mailsEnviados = [];
  const planilla = {
    getSheetByName: (n) => hojas[n] || null,
    insertSheet: (n) => (hojas[n] = new Hoja()),
    getId: () => 'planilla-prueba',
    getName: () => 'Gastos',
  };
  const respuestaIA = (prompt, modelo) => {
    if (typeof ia === 'function') return ia(prompt, modelo);
    if (ia === 'saturada') return { code: 503, texto: '{"error":{"code":503,"message":"high demand"}}' };
    let t = 'Respuesta de prueba';
    if (/avisos bancarios/.test(prompt)) t = JSON.stringify({ tipo: 'compra', monto: 'Gs 12.500', comercio: 'KIOSCO PRUEBA', tarjeta: 'GNB TD', fecha: '' });
    else if (/nombre comercial limpio/.test(prompt)) {
      const lista = prompt.split('Comercios:')[1].trim().split('\n');
      t = JSON.stringify(lista.map((l) => {
        const nombre = l.replace(/^\d+\.\s*/, '');
        return /seis|s6/i.test(nombre) ? { nombre: 'Superseis', categoria: 'Supermercado' } : { nombre: nombre.split(/[-*]/)[0].trim(), categoria: 'Restaurantes' };
      }));
    }
    return { code: 200, texto: JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }) };
  };
  const ctx = {
    SpreadsheetApp: { getActive: () => planilla },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cacheDatos[k] ?? null, put: (k, v) => { cacheDatos[k] = String(v); }, remove: (k) => { delete cacheDatos[k]; } }) },
    ScriptApp: {
      getProjectTriggers: () => [], deleteTrigger() {},
      newTrigger: () => { const t = { timeBased: () => t, everyMinutes: () => t, everyWeeks: () => t, onWeekDay: () => t, atHour: () => t, create() {} }; return t; },
      WeekDay: { MONDAY: 'MONDAY', SUNDAY: 'SUNDAY' },
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'ana@example.com' }) },
    GmailApp: {
      search: () => [{ getMessages: () => correos }],
      sendEmail: (...a) => { mailsEnviados.push(a); },
    },
    UrlFetchApp: {
      fetch(url, o) {
        if (/\/models\?/.test(url)) {
          llamadasIA.push('LISTA');
          const models = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.8-flash-lite'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] }));
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ models }) };
        }
        const modelo = url.split('/models/')[1].split(':')[0];
        llamadasIA.push(modelo);
        const prompt = JSON.parse(o.payload).contents[0].parts[0].text;
        const r = respuestaIA(prompt, modelo);
        return { getResponseCode: () => r.code, getContentText: () => r.texto };
      },
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      sleep() {},
      DigestAlgorithm: { MD5: 'md5' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, txt) => [...crypto.createHash(alg).update(txt, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (d, tz, formato) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
        if (formato === 'yyyy-MM') return `${p.year}-${p.month}`;
        if (formato === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
        return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
      },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(CODIGO, ctx, { filename: 'Code.gs' });
  vm.runInContext('setup(); asegurarHojasLecturas();', ctx);
  hojas.Ajustes.filas.find((f) => f[0] === 'titular')[1] = TITULAR;
  if (ia !== 'sin-clave') vm.runInContext("fijarAjuste('gemini_key', 'CLAVE-DE-PRUEBA'); fijarAjuste('gemini_modelo', 'gemini-3.8-flash');", ctx);
  const token = props.TOKEN;

  const correr = (codigo, datos = {}) => { Object.assign(ctx, datos); return vm.runInContext(codigo, ctx); };
  const post = (cuerpo, tok = token) => JSON.parse(correr('doPost(__e)', { __e: { postData: { contents: typeof cuerpo === 'string' ? cuerpo : JSON.stringify({ token: tok, ...cuerpo }) } } }).s);
  const get = (params = {}) => JSON.parse(correr('doGet(__e)', { __e: { parameter: { token, ...params } } }).s);
  let idMail = 0;
  const llegaMail = (de, asunto, html, fecha = new Date()) => {
    const id = 'msg-' + (++idMail);
    correos.push({ getFrom: () => de, getSubject: () => asunto, getBody: () => html, getDate: () => fecha, getId: () => id });
    return id;
  };
  const gastos = () => get().gastos;
  const ingresos = () => get().ingresos;
  return { ctx, hojas, props, cacheDatos, correos, llamadasIA, mailsEnviados, token, correr, post, get, llegaMail, gastos, ingresos };
}

// --- Avisos de ejemplo con el formato real de cada banco (datos inventados) ---

const ahora = new Date();
const dd = String(ahora.getDate()).padStart(2, '0');
const mm = String(ahora.getMonth() + 1).padStart(2, '0');
const aaaa = ahora.getFullYear();
const hhmm = (min = 0) => { const d = new Date(Date.now() + min * 60000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const hoy = `${dd}/${mm}/${aaaa}`;
const momento = (min = 0) => { const d = new Date(Date.now() + min * 60000); return `${aaaa}-${mm}-${dd} ${hhmm(min)}:${String(d.getSeconds()).padStart(2, '0')}`; };

const sms = {
  compraGnb: (comercio, monto, min = 0) => `Banco GNB informa: La operación de pago  en ${comercio}      ASUNCION      PRY   por Gs ${monto} en TC *1313 de ANA PEREZ el ${hoy} ${hhmm(min)} en BANCO GNB`,
  compraGnbUsd: (comercio, monto) => `Banco GNB informa: La operación de pago  en ${comercio}      SAN FRANCISCO USA   por USD ${monto} en TC *1313 de ANA PEREZ el ${hoy} ${hhmm()} en BANCO GNB`,
  reversoGnb: (comercio, monto) => `Banco GNB informa: La operación de reverso  en ${comercio}      ASUNCION      PRY   por Gs ${monto} en TC *1313 de ANA PEREZ el ${hoy} ${hhmm()} en BANCO GNB`,
  pagoTarjetaGnb: (monto) => `Banco GNB informa: La operación de pago    por Gs ${monto} en TC *1313 de ANA PEREZ el ${hoy} ${hhmm()} en BANCO GNB`,
  continental: (comercio, monto) => `Banco Continental: TRANS. APROBADA de la tarjeta DINELCO CLASICA 0677 , monto: ${monto}-, en: ${comercio}.`,
};

const fila = (etiqueta, valor) => `<tr><td>${etiqueta}:</td><td>${valor}</td></tr>`;
const mail = {
  gnbEnviada: (comprobante, monto, beneficiario) => ['Transferencias@bancognb.com.py', 'Transferencias Enviadas SPI',
    `<p>Transferencia interbancaria Enviada</p><table>${fila('N° Comprobante', comprobante)}${fila('Fecha y hora', `${hoy} ${hhmm()}:00`)}${fila('Ordenante', TITULAR)}${fila('Importe', 'PYG ' + monto)}${fila('Entidad Beneficiaria', 'BANCO ITAU PARAGUAY S.A.')}${fila('Cliente Beneficiario', beneficiario)}</table>`],
  gnbRecibida: (comprobante, monto, pagador) => ['noreply@bancognb.com.py', 'Transferencia SPI',
    `<p>Transferencia Interbancaria Recibida</p><table>${fila('N° Comprobante', comprobante)}${fila('Fecha y hora', `${dd}/${mm}/${String(aaaa).slice(2)} ${hhmm()}`)}${fila('Enviado por', pagador)}${fila('Importe', 'PYG ' + monto)}</table>`],
  gnbTerceros: (comprobante, monto, ordenante) => ['Transferencias@bancognb.com.py', 'TRANSFERENCIA RECIBIDA DE CTA DE TERCEROS',
    `<p>TRANSFERENCIA RECIBIDA DE CTA DE TERCEROS: Estimado cliente</p><table>${fila('Fecha y Hora', `${hoy} ${hhmm()}:00`)}${fila('Nro. de Comprobante', comprobante)}${fila('Nombre del Ordenante', ordenante)}${fila('Importe', 'PYG ' + monto)}</table>`],
  familiarEnviada: (operacion, monto, beneficiario) => ['operbancaweb@familiar.com.py', 'Transferencia a otros bancos',
    `<p>TRANSFERENCIA A OTRAS ENTIDADES CONFIRMADA</p><table>${fila('Nro. de Operación', operacion)}${fila('Fecha y hora de Operación', `${hoy} ${hhmm()}:00`)}${fila('Cliente Beneficiario', beneficiario)}${fila('Monto a enviar', 'Gs. ' + monto)}</table>`],
  familiarRecibida: (operacion, monto, pagador) => ['operbancaweb@familiar.com.py', 'Transferencia de otros bancos',
    `<p>TRANSFERENCIA DE OTRAS ENTIDADES RECIBIDA</p><table>${fila('Nro. de Operación', operacion)}${fila('Fecha y hora de Operación', `${hoy} ${hhmm()}:00`)}${fila('Cliente Pagador', pagador)}${fila('Moneda y Monto', 'Gs. ' + monto)}</table>`],
  familiarServicio: (transaccion, monto, servicio) => ['operbancaweb@familiar.com.py', 'Pago de servicios',
    `<table>${fila('Número de Transacción', transaccion)}${fila('Servicio', servicio)}${fila('Monto', 'Gs. ' + monto)}${fila('Fecha', `${hoy} ${hhmm()}:00`)}</table>`],
};

module.exports = { crearBackend, sms, mail, momento, TITULAR };
