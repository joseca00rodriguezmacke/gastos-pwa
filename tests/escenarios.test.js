// Escenarios QA del backend: cada uno arranca con una planilla vacía y simula lo que pasa en la vida real.
// Correr con:  node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearBackend, sms, mail, momento } = require('./arnes');

const applePay = (comercio, monto, extra = {}) => ({ monto: `Gs. ${monto}`, comercio, tarjeta: 'GNB APPLE', origen: 'applepay', ...extra });
const montoNum = (s) => Number(String(s).replace(/\D/g, ''));
const delMonto = (b, monto) => b.gastos().filter((g) => g.monto === montoNum(monto));

// ---------------------------------------------------------------- Apple Pay

test('Apple Pay: se guarda con monto "Gs. 763.393" y tarjeta GNB', () => {
  const b = crearBackend();
  const r = b.post(applePay('fcia.punto Farma-P147', '763.393', { momento: momento() }));
  assert.equal(r.ok, true);
  assert.equal(r.gasto.monto, 763393);
  assert.equal(b.gastos().length, 1);
});

test('Apple Pay: el mismo aviso reenviado (mismo momento) no duplica', () => {
  const b = crearBackend();
  const p = applePay('Sabores De Abuela', '34.000', { momento: momento() });
  b.post(p); b.post(p); b.post(p);
  assert.equal(b.gastos().length, 1);
});

test('Apple Pay: el atajo manda la compra con y sin "momento" a la vez → un solo gasto', () => {
  const b = crearBackend();
  b.post(applePay('Joseph Coiffure Multip', '80.000'));
  b.post(applePay('Joseph Coiffure Multip', '80.000', { momento: momento() }));
  assert.equal(delMonto(b, '80.000').length, 1);
});

test('Apple Pay: dos compras distintas del mismo monto en comercios distintos → dos gastos', () => {
  const b = crearBackend();
  b.post(applePay('Burger King', '50.000', { momento: momento(-1) }));
  b.post(applePay('Petrobras', '50.000', { momento: momento() }));
  assert.equal(delMonto(b, '50.000').length, 2);
});

test('Apple Pay: monto vacío responde error claro y queda anotado', () => {
  const b = crearBackend();
  const r = b.post(applePay('PRUEBA', ''));
  assert.equal(r.ok, false);
  assert.match(r.error, /Monto inválido/);
  assert.equal(b.gastos().length, 0);
});

test('Apple Pay: monto en dólares se convierte a guaraníes', () => {
  const b = crearBackend();
  const r = b.post({ monto: 'USD 9,99', comercio: 'OPENAI', tarjeta: 'GNB APPLE', origen: 'applepay' });
  assert.equal(r.ok, true);
  assert.ok(r.gasto.monto > 9.99 * 1000, 'convertido a Gs');
});

// ---------------------------------------------------------------- SMS del banco

test('SMS GNB: compra se guarda; el mismo SMS dos veces no duplica', () => {
  const b = crearBackend();
  const t = sms.compraGnb('BURGER KING-MULTIPLAZA', '7.500');
  assert.match(b.post({ accion: 'sms', texto: t }).resultado, /guardado/);
  b.post({ accion: 'sms', texto: t });
  assert.equal(b.gastos().length, 1);
});

test('Apple Pay + SMS de la misma compra (en cualquier orden) → un gasto "applepay+sms"', () => {
  for (const orden of ['applepay-primero', 'sms-primero']) {
    const b = crearBackend();
    const ap = () => b.post(applePay('fcia.punto Farma-P147', '763.393', { momento: momento() }));
    const s = () => b.post({ accion: 'sms', texto: sms.compraGnb('FCIA.PUNTO FARMA-P147  FDO. DE LA MO', '763.393', 2) });
    if (orden === 'applepay-primero') { ap(); s(); } else { s(); ap(); }
    const gs = b.gastos();
    assert.equal(gs.length, 1, orden);
    assert.match(gs[0].origen, /applepay/);
    assert.match(gs[0].origen, /sms/);
  }
});

test('SMS GNB: pago DE la tarjeta (sin comercio) no suma como gasto', () => {
  const b = crearBackend();
  const r = b.post({ accion: 'sms', texto: sms.pagoTarjetaGnb('150.000') });
  assert.equal(r.resultado, 'pago de tarjeta');
  assert.equal(b.gastos().length, 0);
  assert.equal(b.hojas.PagosTarjeta.filas.length, 2);
});

test('SMS GNB: reverso borra la compra', () => {
  const b = crearBackend();
  b.post({ accion: 'sms', texto: sms.compraGnb('TIENDA X', '120.000') });
  b.post({ accion: 'sms', texto: sms.reversoGnb('TIENDA X', '120.000') });
  assert.equal(b.gastos().length, 0);
});

test('SMS GNB en dólares y SMS Continental se leen', () => {
  const b = crearBackend();
  assert.match(b.post({ accion: 'sms', texto: sms.compraGnbUsd('CLOUDFLARE', '5,00') }).resultado, /guardado/);
  assert.match(b.post({ accion: 'sms', texto: sms.continental('SUPERSEIS HIPER', '13.565') }).resultado, /guardado/);
  assert.equal(b.gastos().length, 2);
});

test('SMS con formato desconocido: se anota y no rompe', () => {
  const b = crearBackend();
  const r = b.post({ accion: 'sms', texto: 'Banco GNB informa: mensaje nuevo que no conocemos' });
  assert.equal(r.ok, true);
  assert.match(r.resultado, /formato/);
});

// ---------------------------------------------------------------- Carga manual y fusiones

test('Gasto cargado a mano + Apple Pay después (±1 Gs) → se unen', () => {
  const b = crearBackend();
  b.post({ accion: 'guardar', gasto: { monto: 40000, comercio: 'Guido', categoria: 'Restaurantes', origen: 'manual', id: 'manual-1' } });
  b.post(applePay('GUIDO RESTAURANTE', '40.001', { momento: momento() }));
  const gs = b.gastos();
  assert.equal(gs.length, 1);
  assert.match(gs[0].origen, /manual\+applepay/);
  assert.equal(gs[0].categoria, 'Restaurantes', 'mantiene la categoría elegida a mano');
});

test('Editar un gasto (categoría, etiqueta, pagado por otro) y que un reenvío no lo pise', () => {
  const b = crearBackend();
  const ap = applePay('BEST BUY MIAMI', '250.000', { momento: momento() });
  const g = b.post(ap).gasto;
  b.post({ accion: 'guardar', gasto: { ...g, categoria: 'Compras', etiqueta: 'Viaje 2026', tercero: 'Mamá' } });
  b.post(ap);
  const x = b.gastos()[0];
  assert.equal(x.etiqueta, 'Viaje 2026');
  assert.equal(x.tercero, 'Mamá');
});

test('Borrar un gasto', () => {
  const b = crearBackend();
  const g = b.post(applePay('X', '1.000', { momento: momento() })).gasto;
  assert.equal(b.post({ accion: 'borrar', id: g.id }).ok, true);
  assert.equal(b.gastos().length, 0);
});

// ---------------------------------------------------------------- Mails del banco

const procesar = (b) => b.correr('procesarCorreos()');

test('Mail GNB: transferencia enviada a alguien nuevo → "Por revisar" (no suma hasta confirmar)', () => {
  const b = crearBackend();
  b.llegaMail(...mail.gnbEnviada('9001', '200.000', 'JUAN TERCERO LOPEZ'));
  procesar(b);
  const gs = b.gastos();
  assert.equal(gs.length, 1);
  assert.equal(gs[0].categoria, 'Por revisar');
});

test('Mail GNB: transferencia con regla de destinatario → categoría y nombre de la regla, y la IA no la renombra', () => {
  const b = crearBackend({ ia: 'ok' });
  b.post({ accion: 'destinatario', regla: { nombre: 'Liana Martinez', accion: 'gasto', categoria: 'Hogar', etiqueta: 'Liana (gastos varios)' } });
  b.llegaMail(...mail.gnbEnviada('9002', '15.000', 'LIANA MONSERRAT MARTINEZ'));
  procesar(b);
  procesar(b); // segunda pasada: corre la IA de fondo
  const g = b.gastos()[0];
  assert.equal(g.comercio, 'Liana (gastos varios)');
  assert.equal(g.categoria, 'Hogar');
});

test('Mail GNB: transferencia a cuenta propia se ignora', () => {
  const b = crearBackend();
  b.llegaMail(...mail.gnbEnviada('9003', '1.000.000', 'ANA MARIA PEREZ GOMEZ'));
  procesar(b);
  assert.equal(b.gastos().length, 0);
});

test('Mails de ingresos: tercero = Ventas, empleador = Sueldo, cuenta propia (nombre completo o abreviado) se ignora', () => {
  const b = crearBackend();
  b.llegaMail(...mail.gnbRecibida('7001', '300.000', 'CLIENTE UNO SA'));
  b.llegaMail(...mail.gnbTerceros('7002', '3.600.000', 'SERCON S.A.'));
  b.llegaMail(...mail.familiarRecibida('7003', '500.000', 'ANA PEREZ'));
  b.llegaMail(...mail.gnbRecibida('7004', '700.000', 'PEREZ GOMEZ, ANA MARIA'));
  procesar(b);
  const ing = b.ingresos();
  assert.deepEqual(ing.map((i) => i.categoria).sort(), ['Sueldo', 'Ventas']);
});

test('Familiar manda el mismo mail dos veces → una sola transferencia', () => {
  const b = crearBackend();
  b.llegaMail(...mail.familiarEnviada('5001', '100.000', 'PEDRO NUEVO'));
  b.llegaMail(...mail.familiarEnviada('5001', '100.000', 'PEDRO NUEVO'));
  procesar(b);
  assert.equal(b.gastos().length, 1);
});

test('Familiar: pago de servicios → gasto en Servicios', () => {
  const b = crearBackend();
  b.llegaMail(...mail.familiarServicio('4001', '155.000', 'ANDE'));
  procesar(b);
  const g = b.gastos()[0];
  assert.equal(g.monto, 155000);
  assert.equal(g.categoria, 'Servicios');
});

test('Leer los correos varias veces no duplica nada', () => {
  const b = crearBackend();
  b.llegaMail(...mail.gnbEnviada('9010', '20.000', 'ALGUIEN NUEVO'));
  b.llegaMail(...mail.gnbRecibida('7010', '90.000', 'CLIENTE DOS'));
  procesar(b); procesar(b); procesar(b);
  assert.equal(b.gastos().length, 1);
  assert.equal(b.ingresos().length, 1);
});

// ---------------------------------------------------------------- IA (Gemini)

test('Sin clave de IA: todo funciona y nunca se llama a Gemini', () => {
  const b = crearBackend();
  b.post(applePay('Sup Hiperseis', '50.000', { momento: momento() }));
  b.post({ accion: 'sms', texto: 'Banco GNB informa: algo raro por Gs 1.000' });
  procesar(b);
  assert.equal(b.llamadasIA.length, 0);
  assert.equal(b.get().ia.disponible, false);
});

test('Con IA: Apple Pay y SMS se guardan sin esperar a Gemini; la IA ordena después, en segundo plano', () => {
  const b = crearBackend({ ia: 'ok' });
  b.post(applePay('Sup Hiperseis', '50.000', { momento: momento() }));
  b.post({ accion: 'sms', texto: 'Banco GNB informa: debito TD por compra en KIOSCO PRUEBA por Gs 12.500' });
  assert.equal(b.llamadasIA.length, 0, 'nada de IA en el momento del aviso');
  procesar(b);
  const gs = b.gastos();
  assert.ok(gs.some((g) => g.comercio === 'Superseis' && g.categoria === 'Supermercado'), 'nombre unificado');
  assert.ok(gs.some((g) => g.monto === 12500), 'SMS leído por IA');
  const n = b.llamadasIA.length;
  procesar(b);
  assert.equal(b.gastos().length, gs.length, 'sin duplicados');
  assert.ok(b.llamadasIA.length - n <= 1, 'no repite trabajo');
});

test('IA saturada: la tarea de fondo se frena 30 min (no gasta la cuota diaria) y los avisos siguen entrando', () => {
  const b = crearBackend({ ia: 'saturada' });
  b.post(applePay('Comercio Nuevo', '10.000', { momento: momento() }));
  procesar(b);
  const n = b.llamadasIA.length;
  assert.ok(n > 0);
  procesar(b); procesar(b);
  assert.equal(b.llamadasIA.length, n, 'en pausa: no vuelve a llamar');
  assert.equal(b.post(applePay('Otro', '5.000', { momento: momento(1) })).ok, true);
});

test('IA: modelo retirado (404) se cambia solo; saturado (503) prueba otro modelo y lo recuerda', () => {
  let llamadas = 0;
  const b = crearBackend({
    ia: (prompt, modelo) => {
      llamadas++;
      if (modelo === 'gemini-3.8-flash' && llamadas === 1) return { code: 404, texto: 'is no longer available. Please use models/gemini-9-flash instead' };
      if (modelo === 'gemini-9-flash') return { code: 503, texto: 'busy' };
      return { code: 200, texto: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hola' }] } }] }) };
    },
  });
  assert.equal(b.post({ accion: 'preguntar', pregunta: '¿cuánto gasté?' }).respuesta, 'hola');
  assert.equal(b.hojas.Ajustes.filas.find((f) => f[0] === 'gemini_modelo')[1], 'gemini-9-flash');
  const antes = b.llamadasIA.length;
  b.post({ accion: 'preguntar', pregunta: 'otra' });
  assert.equal(b.llamadasIA.length - antes, 1, 'va directo al modelo que respondió');
});

test('Pagado por otro no entra en lo que analiza la IA', () => {
  const b = crearBackend({ ia: 'ok' });
  b.post({ accion: 'guardar', gasto: { monto: 55000, comercio: 'Farmacia de mamá', categoria: 'Salud', tercero: 'Mamá', origen: 'manual' } });
  assert.equal(JSON.stringify(b.correr('contextoFinanciero(30)')).includes('Farmacia de mamá'), false);
});

// ---------------------------------------------------------------- Seguridad y entradas raras

test('Token incorrecto → no autorizado', () => {
  const b = crearBackend();
  assert.equal(b.post(applePay('X', '1.000'), 'token-falso').ok, false);
});

test('Cuerpo que no es JSON → error controlado (no se cae)', () => {
  const b = crearBackend();
  const r = b.post('esto no es json');
  assert.equal(r.ok, false);
});

test('La clave de la IA no se puede cambiar desde afuera', () => {
  const b = crearBackend({ ia: 'ok' });
  assert.equal(b.post({ accion: 'ajuste', clave: 'gemini_key', valor: 'otra' }).ok, false);
});

test('Planilla vieja (7 columnas) se actualiza sola y no pierde datos', () => {
  const b = crearBackend();
  b.hojas.Gastos.filas[0] = ['fecha', 'monto', 'comercio', 'tarjeta', 'categoria', 'origen', 'id'];
  b.hojas.Gastos.filas.push(['2026-11-01 10:00', 1000, 'Viejo', '', 'Otros', 'manual', 'v1']);
  b.post(applePay('Nuevo', '2.000', { momento: momento() }));
  assert.equal(b.hojas.Gastos.filas[0].length, 9);
  assert.equal(b.gastos().length, 2);
});
