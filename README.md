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
   | `ADMIN_EMAIL` | tu correo para entrar al admin |
   | `ADMIN_PASSWORD` | una contraseña fuerte |
   | `NODE_ENV` | `production` |

5. **Genera el dominio**: servicio → **Settings** → **Networking** → **Generate Domain**.
   Luego puedes conectar tu propio dominio (ej. `shop.empacalo.net`) en la misma sección.

6. Entra a `https://TU-DOMINIO/admin` con tu correo y contraseña. La primera vez se cargan 5 cajas de ejemplo y el cupón `WELCOME10`. **Cambia los precios y el stock** desde *Productos* y sube tus fotos.

Cada vez que hagas `git push`, Railway vuelve a desplegar solo.

---

## Pagos con tarjeta (Stripe) — opcional

Sin Stripe la tienda funciona en **modo pago manual**: los pedidos llegan como *Pendiente* y tú los marcas como *Pagado* en el admin cuando recibas el dinero (Zelle, transferencia, etc.).

Para cobrar con tarjeta:

1. Crea una cuenta en [stripe.com](https://stripe.com) (necesitas una empresa o datos fiscales en EE. UU.).
2. En Stripe → **Developers → API keys**, copia la **Secret key** y ponla en Railway como `STRIPE_SECRET_KEY`.
3. En Stripe → **Developers → Webhooks → Add endpoint**:
   - URL: `https://TU-DOMINIO/stripe/webhook`
   - Eventos: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
   - Copia el **Signing secret** y ponlo en Railway como `STRIPE_WEBHOOK_SECRET`.
4. Prueba primero con las llaves de **modo prueba** (`sk_test_...`) y la tarjeta `4242 4242 4242 4242`.

Cuando un pago se confirma, el pedido pasa a *Pagado* solo. Si el cliente abandona el pago, el pedido se cancela y el stock vuelve al inventario.

---

## Correr en tu computador

Necesitas Node.js 20+ y PostgreSQL.

```bash
cp .env.example .env      # y edita los valores
npm install
npm run dev               # http://localhost:3000  ·  admin: /admin
```

Sin `ADMIN_EMAIL`/`ADMIN_PASSWORD`, en desarrollo el acceso es `admin@empacalo.net` / `admin123` (en producción es obligatorio definirlos).

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
