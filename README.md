# Gastos PWA

Control de gastos personales en guaraníes. Todo el stack es gratis:

- **Frontend:** PWA en HTML + JS vanilla (`web/`). Se instala en iPhone y funciona offline.
- **Backend:** Google Apps Script publicado como web app (`apps-script/Code.gs`). Guarda los datos en tu Google Sheet.
- **Hosting:** Cloudflare Pages o GitHub Pages, en el tier gratuito.
- **Apple Pay:** una automatización de Atajos de iOS hace un POST al backend en cada pago. La guía con maquetas está en [`web/guia-atajo.html`](web/guia-atajo.html) y también se abre desde la app (Ajustes > Apple Pay).

```
apps-script/Code.gs     backend (pegar en el editor de Apps Script)
web/                    la PWA: esto es lo que se publica
  index.html, app.js, styles.css, sw.js, manifest.json, icons/
  guia-atajo.html       guía paso a paso del Atajo de iOS
.github/workflows/      despliegue opcional a GitHub Pages
```

## Qué hace

- Registrar, editar y borrar gastos. El formulario pide monto, comercio, categoría, tarjeta y fecha.
- Lista por mes con selector ‹ › y total del mes.
- Resumen con barras por categoría y comparación contra el presupuesto mensual.
- Categorías, presupuestos y reglas de categorización editables. Una regla es algo como "Stock" → Supermercado: si el comercio contiene ese texto, se asigna esa categoría (sin importar mayúsculas ni tildes).
- Exportar CSV del mes o completo (separado por `;`, se abre bien en Excel en español).
- Offline: los gastos y cambios se guardan en una cola en IndexedDB y se envían cuando vuelve la conexión. El indicador arriba a la derecha muestra cuántos quedan pendientes.

### Hojas de la Sheet

| Hoja | Columnas |
|---|---|
| `Gastos` | fecha, monto, comercio, tarjeta, categoria, origen, id |
| `Categorias` | nombre, color |
| `Reglas` | patron, categoria |
| `Presupuestos` | categoria, monto |

La categorización se aplica **en el servidor**. Por eso los gastos que llegan desde Apple Pay se categorizan aunque la app no esté abierta. Si editás las hojas a mano, mantené el orden de las columnas.

### API

| Método | Uso | Respuesta |
|---|---|---|
| `GET ?token=T&mes=AAAA-MM` | lista los gastos del mes y la configuración (sin `mes` devuelve todos) | `{ok, gastos, config}` |
| `POST {token, monto, comercio, tarjeta?, categoria?, fecha?, origen?}` | registra un gasto (es el formato que usa el Atajo) | `{ok, gasto, mensaje}` |
| `POST {token, accion:"guardar", gasto:{id, ...}}` | crea o actualiza por `id` (no duplica si se reintenta) | `{ok, gasto, mensaje}` |
| `POST {token, accion:"borrar", id}` | borra un gasto | `{ok, borrado}` |
| `POST {token, accion:"config", config:{categorias, reglas, presupuestos}}` | reemplaza la configuración | `{ok, config}` |

Apps Script siempre responde HTTP 200. Los errores vienen como `{ok:false, error:"..."}`.

---

## Despliegue paso a paso

### 1. Google Sheet + Apps Script (backend)

1. Entrá a [sheets.new](https://sheets.new) y creá una hoja nueva, por ejemplo "Gastos".
2. Andá a **Extensiones > Apps Script**.
3. Borrá el contenido de `Código.gs` y pegá todo [`apps-script/Code.gs`](apps-script/Code.gs). Guardá con 💾.
4. En la barra de arriba elegí la función **`setup`** y tocá **Ejecutar**.
   - La primera vez Google pide permisos: **Revisar permisos**, elegí tu cuenta y después **Configuración avanzada > Ir a (proyecto) (no seguro) > Permitir**. Es tu propio script, por eso aparece ese aviso.
   - `setup` crea las 4 hojas, carga categorías y reglas de ejemplo y genera un token.
5. Abrí **Ver > Registros** (o el panel "Registro de ejecución") y copiá el valor que aparece como `TOKEN: …`.
   - Lo podés ver o cambiar después en **⚙ Configuración del proyecto > Propiedades del script > TOKEN**.
6. Tocá **Implementar > Nueva implementación**. En el ⚙, el tipo es **Aplicación web**. Configurá:
   - **Ejecutar como:** Yo
   - **Quién tiene acceso:** Cualquier usuario
7. Tocá **Implementar** y copiá la **URL de la aplicación web**. Termina en `/exec`.

> **Si cambiás el código después:** usá **Implementar > Gestionar implementaciones > ✏️ > Versión: Nueva versión**. Así la URL no cambia. Si hacés una "Nueva implementación", la URL cambia y hay que actualizarla en la app y en el Atajo.

### 2. Probar el endpoint con curl

Reemplazá `URL` y `TOKEN` por los tuyos. El `-L` es obligatorio porque Apps Script redirige a `script.googleusercontent.com`.

```bash
URL="https://script.google.com/macros/s/XXXXXXXX/exec"
TOKEN="tu_token"
```

Registrar un gasto, igual que lo haría el Atajo de Apple Pay:

```bash
curl -sL -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\",\"monto\":\"₲25.000\",\"comercio\":\"STOCK MCAL LOPEZ\",\"tarjeta\":\"Visa\",\"origen\":\"curl\"}" "$URL"
```

Respuesta esperada (la regla "Stock" lo categoriza como Supermercado):

```json
{"ok":true,"gasto":{"fecha":"2026-10-29 10:15","monto":25000,"comercio":"STOCK MCAL LOPEZ","tarjeta":"Visa","categoria":"Supermercado","origen":"curl","id":"…"},"mensaje":"Gs 25.000 · STOCK MCAL LOPEZ → Supermercado"}
```

Listar los gastos del mes:

```bash
curl -sL "$URL?token=$TOKEN&mes=2026-10"
```

Comprobar que el token se valida (tiene que responder `{"ok":false,"error":"No autorizado"}`):

```bash
curl -sL "$URL?token=incorrecto"
```

En Windows PowerShell, `curl` es otro comando. Usá `Invoke-RestMethod`:

```powershell
Invoke-RestMethod -Method Post -Uri $URL -ContentType "application/json" -Body (@{token=$TOKEN; monto="25000"; comercio="Stock"; tarjeta="Visa"; origen="powershell"} | ConvertTo-Json)
```

Nota: con `-L`, curl convierte el POST en GET al seguir la redirección. Es correcto: Apps Script ya procesó el POST y la redirección solo entrega la respuesta.

### 3. Publicar la PWA

Se publica solo la carpeta `web/`. No hay build.

**Opción A — Cloudflare Pages (recomendada)**

- *Sin Git:* en [dash.cloudflare.com](https://dash.cloudflare.com) andá a **Workers & Pages > Create > Pages > Upload assets**. Poné un nombre (por ejemplo `gastos`) y arrastrá la carpeta `web/`. Queda en `https://gastos.pages.dev` o similar.
- *Con Git:* subí este repo a GitHub y elegí **Workers & Pages > Create > Pages > Connect to Git**. Elegí el repo y configurá:
  - Framework preset: **None**
  - Build command: *(vacío)*
  - Build output directory: **`web`**

  Cada push a `main` se publica solo.

**Opción B — GitHub Pages**

1. Subí el repo a GitHub.
2. En **Settings > Pages > Build and deployment > Source**, elegí **GitHub Actions**.
3. El workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publica `web/` en cada push a `main`. La app queda en `https://<usuario>.github.io/<repo>/`.

> En cada despliegue subí `VERSION` en [`web/sw.js`](web/sw.js) (`gastos-v2`, `gastos-v3`, …). Así los dispositivos instalados toman los archivos nuevos. Puede hacer falta abrir y cerrar la app dos veces.

### 4. Instalar en el iPhone

1. Abrí la URL publicada en **Safari**. Tiene que ser Safari, no otro navegador.
2. Tocá **Compartir** (□↑) y después **Añadir a pantalla de inicio**, y luego **Añadir**.
3. Abrí la app desde el ícono y andá a **Ajustes > Conexión**. Pegá la URL `/exec` y el token, y tocá **Guardar y probar**.

La app instalada en iOS tiene su propio almacenamiento, separado de Safari. Por eso la URL y el token se cargan **dentro de la app instalada**. En la compu, hacé lo mismo en el navegador. Chrome y Edge también ofrecen "Instalar".

### 5. Apple Pay con Atajos

Seguí la guía [`web/guia-atajo.html`](web/guia-atajo.html). También está en la app, en **Ajustes > Apple Pay > Ver guía del Atajo**. En resumen:

1. **Atajos > Automatización > + > Transacción**.
2. Elegí las tarjetas, marcá **Ejecutar inmediatamente** y tocá **Siguiente**.
3. **Crear atajo nuevo**, con la acción **Obtener contenido de URL**:
   - URL `/exec`, método **POST**, cuerpo **JSON**.
   - Campos: `token` (texto), `monto` (Entrada del atajo → Monto), `comercio` (→ Comercio), `tarjeta` (→ Tarjeta o pase) y `origen` = `applepay`.
4. Opcional: **Obtener valor de diccionario** con la clave `mensaje` y después **Mostrar notificación**.

---

## Seguridad y límites

- El token protege el endpoint de quien no lo conoce. Viaja en la URL de los GET, y en el iPhone queda guardado en la app y en el Atajo. Para uso personal alcanza, pero no es seguridad fuerte. Si se filtra, cambialo en **Propiedades del script** y actualizalo en la app y en el Atajo.
- La web app corre con tu cuenta. Solo accede a la Sheet donde está pegado el script.
- Cuotas gratuitas de Apps Script: miles de requests por día, de sobra para uso personal.
- El disparador "Transacción" requiere iOS 17 o superior y una tarjeta en Wallet. El comercio llega como lo informe el banco o la red, a veces abreviado o en mayúsculas. Las reglas no distinguen mayúsculas, así que conviene ajustarlas con lo que veas llegar.
- El Atajo no tiene cola offline: si no hay internet al pagar, ese gasto no llega. La cola offline existe solo dentro de la PWA.
- iOS no ejecuta sincronización en segundo plano en las PWA. La cola se envía cuando abrís la app o vuelve la conexión.
