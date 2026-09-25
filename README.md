# EMPACALO — Tienda online + panel de administración

Tienda para vender cajas de cartón en EE. UU. (inglés/español) con panel de administración en español.

**Tienda:** catálogo, página de producto, carrito, cupones, checkout con **envío a cualquier dirección de EE. UU.**, página de confirmación del pedido.
**Admin (`/admin`):** métricas de ventas, pedidos (estados, rastreo, notas, exportar CSV), productos (precio, stock, fotos), clientes, cupones y configuración (costo de entrega, impuesto, dirección de recogida).

Tecnología: Node.js 20+ · Express · PostgreSQL · (opcional) Stripe.

---

## Desplegar en Railway (paso a paso)

1. **Sube el código a GitHub**
   Crea un repositorio nuevo (privado) y sube esta carpeta:
   ```bash
   git init && git add . && git commit -m "Tienda Empacalo"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/empacalo-store.git
   git push -u origin main
   ```

2. **Crea el proyecto en Railway**
   En [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → elige el repositorio.

3. **Agrega la base de datos**
   Dentro del proyecto: **+ Create** → **Database** → **PostgreSQL**.

4. **Configura las variables** del servicio de la tienda (pestaña **Variables**):

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway la conecta sola) |
   | `SESSION_SECRET` | una cadena larga aleatoria (ej. genera una en 1password o con `openssl rand -hex 32`) |
   | `ADMIN_EMAIL` | correo del **primer** admin (solo se usa la primera vez) |
   | `ADMIN_PASSWORD` | contraseña del primer admin (solo la primera vez) |
   | `NODE_ENV` | `production` |
   | `PUBLIC_URL` | `https://empacalo.us` — dominio oficial: el de Railway y `www` redirigen aquí, y se usa en el sitemap y en Google |

   > Después del primer arranque, los admins viven en la base de datos: cambiar `ADMIN_PASSWORD` ya no hace nada. Cada admin cambia su clave en **Admin → Mi contraseña**, y el dueño invita/quita admins (con permisos de Pedidos, Tienda o completo) en **Admin → Usuarios admin**.

5. **Genera el dominio**: servicio → **Settings** → **Networking** → **Generate Domain**.
   Luego puedes conectar tu propio dominio (ej. `shop.empacalo.net`) en la misma sección.

6. Entra a `https://TU-DOMINIO/admin` con tu correo y contraseña. La primera vez se cargan 5 cajas de ejemplo y el cupón `WELCOME10`. **Cambia los precios y el stock** desde *Productos* y sube tus fotos.

Cada vez que hagas `git push`, Railway vuelve a desplegar solo.

---

## Pagos con tarjeta (Clover) — opcional

Sin Clover la tienda funciona en **modo pago manual**: los pedidos llegan como *Pendiente* y tú los marcas como *Pagado* en el admin cuando recibas el dinero (Zelle, transferencia, etc.).

Para cobrar con tarjeta usando Clover Hosted Checkout:

1. Crea una cuenta de developer en [clover.com/developers](https://www.clover.com/developers) y, dentro de ella, un comercio (Merchant Dashboard).
2. En **Ecommerce Settings** activa **Hosted Checkout** y genera un **API token privado**; copia también el `merchantId`.
3. En Railway agrega `CLOVER_MERCHANT_ID` y `CLOVER_ECOMM_API_TOKEN` con esos valores.
4. En la sección de **Webhooks** de Hosted Checkout, agrega:
   - URL: `https://TU-DOMINIO/clover/webhook`
   - Genera una clave de firma y ponla en Railway como `CLOVER_WEBHOOK_SECRET`.
5. Prueba primero en el entorno **sandbox** (agrega `CLOVER_ENV=sandbox` en Railway mientras pruebas, y quítala para producción).

Cuando un pago se confirma, el pedido pasa a *Pagado* solo. Si el cliente abandona el pago, el pedido se cancela y el stock vuelve al inventario.

> Nota: los **pedidos recurrentes** (cobro automático semanal/mensual) siguen usando Stripe por ahora — Clover solo permite cobros recurrentes automáticos guardando la tarjeta del cliente (card-on-file), lo cual requiere una integración adicional (iframe) más allá de Hosted Checkout. Si quieres, esa parte se puede rehacer más adelante como un simple recordatorio por correo con un enlace de "reordenar" (el cliente paga de nuevo con un clic, sin guardar su tarjeta).

---

## Correr en tu computador

Necesitas Node.js 20+ y PostgreSQL.

```bash
cp .env.example .env      # y edita los valores
npm install
npm run dev               # http://localhost:3000  ·  admin: /admin
```

Sin `ADMIN_EMAIL`/`ADMIN_PASSWORD`, en desarrollo el acceso es `admin@empacalo.net` / `admin123`. En producción (o en cualquier deploy de Railway) es obligatorio definirlos.

---

## Correos automáticos (SendGrid)

Sin SendGrid la tienda funciona igual, pero no envía correos. Con SendGrid se envían:

- Al cliente: confirmación del pedido, pago recibido, "va en camino"/"listo para recoger" (con número de rastreo), entregado y cancelado; bienvenida con el cupón `WELCOME10`; enlace para recuperar la contraseña.
- A la tienda: aviso de cada pedido nuevo y de cada mensaje del formulario de contacto (se puede responder directo al cliente). Llegan al "Correo para avisos de pedidos" de *Configuración* (o al correo de contacto).

Pasos:

1. En SendGrid → **Settings → Sender Authentication → Authenticate Your Domain**: elige tu proveedor DNS (Hostinger), dominio `empacalo.us`, y agrega en Hostinger los registros CNAME que te da. Sin esto los correos caen en spam.
2. **Settings → API Keys → Create API Key** con permiso **Mail Send**.
3. En Railway → Variables:

   | Variable | Valor |
   |---|---|
   | `SENDGRID_API_KEY` | la llave `SG....` |
   | `EMAIL_FROM` | un correo de tu dominio autenticado, ej. `pedidos@empacalo.us` |
   | `EMAIL_FROM_NAME` | `EMPACALO` (opcional) |

**Cuándo sale cada correo**

| Momento | A quién | Correo |
|---|---|---|
| Pedido web con pago manual | Cliente + tienda | "Recibimos tu pedido" (con las *instrucciones de pago* de Configuración) / aviso de pedido nuevo |
| Pago con tarjeta confirmado | Cliente + tienda | "Pedido confirmado — pago recibido" / aviso de pedido nuevo |
| Pedido sin pagar a las 24 h | Cliente | Recordatorio de pago (una sola vez; se apaga en Configuración) |
| Admin lo marca *Enviado* | Cliente | "Va en camino" con rastreo y enlace a UPS/FedEx/USPS (o "Listo para recoger") |
| Admin lo marca *Entregado* / *Cancelado* | Cliente | Entregado / Cancelado |
| Todos los días a las 8 a.m. (Chicago) | Tienda | Resumen: por despachar, sin pagar, inventario bajo y ventas de ayer (se apaga en Configuración) |
| Unos días antes de un cobro recurrente | Cliente | Aviso con fecha y monto (evento `invoice.upcoming` de Stripe) |
| Cada cobro recurrente | Cliente + tienda | Pago recibido / aviso de pedido nuevo |
| Registro / olvidó contraseña / formulario de contacto | Cliente / cliente / tienda | Bienvenida con `WELCOME10` / enlace de 1 hora / mensaje con "responder" al cliente |

Los clientes sin cuenta rastrean su pedido en `/track` con el número de pedido y su correo o teléfono.

Al cambiar el estado de un pedido en el admin, la casilla *Enviar correo al cliente* decide si se le avisa. En los pedidos registrados a mano también puedes elegir si mandar la confirmación y en qué idioma.

## WhatsApp

En *Admin → Configuración* escribe tu número de WhatsApp: aparece un botón flotante en toda la tienda (en la página de cada caja, el mensaje ya menciona esa caja). Déjalo vacío para ocultarlo.

## SEO

Ya incluido: títulos y descripciones por página, canonical, versiones en inglés (`/`) y español (`/?lang=es`) enlazadas con hreflang, Open Graph para redes sociales, datos estructurados (Organization, FAQ, Product con precio/stock/envío, Breadcrumb), `/robots.txt` y `/sitemap.xml`. Carrito, checkout, cuenta y pedidos no se indexan.

Después de publicar: verifica el dominio en [Google Search Console](https://search.google.com/search-console) y envía `https://empacalo.us/sitemap.xml`.

---

## Cosas que puedes cambiar fácil

| Qué | Dónde |
|---|---|
| Precios, stock, fotos, descripciones | Admin → Productos |
| Costo de envío, envío gratis desde $X, impuesto, anuncio superior, foto principal | Admin → Configuración |
| Nombre y descripción de cada caja en español | Admin → Productos → "Texto en español" |
| Recoger en bodega (opcional, apagado por defecto) | Admin → Configuración |
| Textos de la tienda (inglés y español) | `src/i18n.js` |
| Colores | variables al inicio de `public/css/store.css` |
| Logo | `public/logo.png` y `public/logo-mark.png` |

## Notas importantes antes de vender

- **Impuesto de venta:** cambia según el estado del comprador. Confírmalo con tu contador; con Stripe puedes activar Stripe Tax para calcularlo automáticamente. La tasa fija de *Configuración* aplica a todos los pedidos.
- **Costo de envío:** hoy es una tarifa fija por pedido. Si envías por UPS/FedEx/USPS, cajas grandes pesan poco pero ocupan mucho (peso volumétrico); revisa que la tarifa cubra el costo.
- **Reembolsos con Stripe:** se hacen desde el panel de Stripe; luego marca el pedido como *Cancelado* en el admin para devolver el stock.
- **Respaldo:** Railway tiene backups de PostgreSQL en la pestaña de la base de datos; actívalos.
- Añade páginas de **política de devoluciones y privacidad** antes de lanzar (Stripe las puede pedir).

## Estructura

```
src/
  server.js        arranque, sesiones, rutas
  db.js            conexión, tablas y datos iniciales
  lib.js           precios del carrito, cupones, dibujo de cajas
  i18n.js          textos en inglés/español
  orders.js        crear/pagar/cancelar pedidos (con control de stock)
  payments.js      Stripe
  routes/store.js  tienda
  routes/admin.js  panel de administración
views/             plantillas (store/ y admin/)
public/            css, logo
```
