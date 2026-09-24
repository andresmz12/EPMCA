// Downloadable reports (inventory, sales metrics, orders) as Excel and PDF.
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { all, one } = require('./db');
const lib = require('./lib');

const TZ = 'America/Chicago';
const PAID = `status IN ('paid','shipped','delivered')`;
const LOGO = path.join(__dirname, '..', 'public', 'logo.png');
const dollars = (c) => Math.round(Number(c || 0)) / 100;
const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const fmtDateTime = (d) => new Date(d).toLocaleString('es-US', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });

/** "YYYY-MM-DD" range from the query string; defaults to the last 30 days. */
function parseRange(query) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));
  let to = ok(query.to) ? query.to : todayLocal();
  let from = ok(query.from) ? query.from : null;
  if (!from) {
    const d = new Date(`${to}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 29);
    from = d.toISOString().slice(0, 10);
  }
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

/* ───────────── Data ───────────── */

async function inventoryData() {
  const rows = await all(
    `SELECT p.name, p.slug, p.dimensions, p.pack_size, p.price_cents, p.stock, p.active,
       COALESCE((SELECT sum(oi.qty) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=p.id AND o.${PAID}),0)::int AS sold,
       COALESCE((SELECT sum(oi.qty) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=p.id AND o.status='pending'),0)::int AS reserved
     FROM products p ORDER BY p.sort, p.id`);
  const totals = rows.reduce((t, p) => ({
    stock: t.stock + p.stock, value: t.value + p.stock * p.price_cents, sold: t.sold + p.sold, reserved: t.reserved + p.reserved,
  }), { stock: 0, value: 0, sold: 0, reserved: 0 });
  return { rows, totals, generated: fmtDateTime(new Date()) };
}

async function salesData({ from, to }) {
  const inRange = `(o.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`;
  const params = [from, to];
  const summary = await one(
    `SELECT count(*) FILTER (WHERE o.${PAID})::int AS orders,
       COALESCE(sum(o.total_cents) FILTER (WHERE o.${PAID}),0)::int AS revenue,
       COALESCE(sum(o.subtotal_cents) FILTER (WHERE o.${PAID}),0)::int AS subtotal,
       COALESCE(sum(o.discount_cents) FILTER (WHERE o.${PAID}),0)::int AS discount,
       COALESCE(sum(o.shipping_cents) FILTER (WHERE o.${PAID}),0)::int AS shipping,
       COALESCE(sum(o.tax_cents) FILTER (WHERE o.${PAID}),0)::int AS tax,
       count(*) FILTER (WHERE o.status='pending')::int AS pending,
       count(*) FILTER (WHERE o.status='cancelled')::int AS cancelled
     FROM orders o WHERE ${inRange}`, params);
  summary.units = (await one(
    `SELECT COALESCE(sum(oi.qty),0)::int AS n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.${PAID} AND ${inRange}`, params)).n;
  summary.newCustomers = (await one(
    `SELECT count(*)::int AS n FROM customers c WHERE (c.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`, params)).n;
  summary.aov = summary.orders ? Math.round(summary.revenue / summary.orders) : 0;

  const daily = await all(
    `SELECT d::date AS day, count(o.id)::int AS orders, COALESCE(sum(o.total_cents),0)::int AS revenue,
       COALESCE(sum((SELECT sum(qty) FROM order_items WHERE order_id=o.id)),0)::int AS units
     FROM generate_series($1::date, $2::date, '1 day') d
     LEFT JOIN orders o ON (o.created_at AT TIME ZONE '${TZ}')::date = d::date AND o.${PAID}
     GROUP BY d ORDER BY d`, params);
  const products = await all(
    `SELECT oi.name, sum(oi.qty)::int AS units, sum(oi.qty * oi.unit_price_cents)::int AS revenue
     FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.${PAID} AND ${inRange}
     GROUP BY oi.name ORDER BY revenue DESC`, params);
  const payments = await all(
    `SELECT o.payment_method AS method, count(*)::int AS orders, sum(o.total_cents)::int AS revenue
     FROM orders o WHERE o.${PAID} AND ${inRange} GROUP BY o.payment_method ORDER BY revenue DESC`, params);
  const channels = await all(
    `SELECT o.source, count(*)::int AS orders, sum(o.total_cents)::int AS revenue
     FROM orders o WHERE o.${PAID} AND ${inRange} GROUP BY o.source ORDER BY revenue DESC`, params);
  const orders = await ordersData({ sql: `WHERE ${inRange}`, params });
  return { from, to, summary, daily, products, payments, channels, orders, generated: fmtDateTime(new Date()) };
}

async function ordersData(filter) {
  return all(
    `SELECT o.*, (SELECT string_agg(qty || ' x ' || name, '; ' ORDER BY id) FROM order_items WHERE order_id=o.id) AS items,
       (SELECT COALESCE(sum(qty),0) FROM order_items WHERE order_id=o.id)::int AS units
     FROM orders o ${filter.sql} ORDER BY created_at DESC`, filter.params);
}

const channelName = (s) => (s === 'admin' ? 'Registrado en admin' : 'Tienda web');
const paymentName = (m) => lib.PAYMENT_ES[m] || m;

/* ───────────── Excel ───────────── */

const MONEY_FMT = '"$"#,##0.00';

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 14, style: c.money ? { numFmt: MONEY_FMT } : {} }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111214' } };
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

function addTotalRow(ws, values) {
  const row = ws.addRow(values);
  row.font = { bold: true };
  row.border = { top: { style: 'thin' } };
}

async function sendXlsx(res, wb, filename) {
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

function newWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EMPACALO';
  wb.created = new Date();
  return wb;
}

const ORDER_COLS = [
  { header: 'Pedido', key: 'number', width: 16 }, { header: 'Fecha', key: 'date', width: 18 },
  { header: 'Estado', key: 'status', width: 12 }, { header: 'Canal', key: 'channel', width: 18 },
  { header: 'Pago', key: 'payment', width: 22 }, { header: 'Cliente', key: 'name', width: 22 },
  { header: 'Correo', key: 'email', width: 26 }, { header: 'Teléfono', key: 'phone', width: 14 },
  { header: 'Entrega', key: 'fulfillment', width: 12 }, { header: 'Dirección', key: 'address', width: 36 },
  { header: 'Productos', key: 'items', width: 40 }, { header: 'Cajas', key: 'units', width: 8 },
  { header: 'Subtotal', key: 'subtotal', money: true }, { header: 'Descuento', key: 'discount', money: true },
  { header: 'Envío', key: 'shipping', money: true }, { header: 'Impuesto', key: 'tax', money: true },
  { header: 'Total', key: 'total', money: true }, { header: 'Cupón', key: 'coupon', width: 12 },
  { header: 'Rastreo', key: 'tracking', width: 22 }, { header: 'Registrado por', key: 'created_by', width: 22 },
];
const orderRow = (o) => ({
  number: o.number, date: fmtDateTime(o.created_at), status: lib.STATUS_ES[o.status] || o.status,
  channel: channelName(o.source), payment: paymentName(o.payment_method), name: o.name, email: o.email, phone: o.phone,
  fulfillment: o.fulfillment === 'pickup' ? 'Recoge' : 'Envío',
  address: o.fulfillment === 'pickup' ? '' : [o.address1, o.address2, o.city, o.state, o.zip].filter(Boolean).join(', '),
  items: o.items || '', units: o.units, subtotal: dollars(o.subtotal_cents), discount: dollars(o.discount_cents),
  shipping: dollars(o.shipping_cents), tax: dollars(o.tax_cents), total: dollars(o.total_cents),
  coupon: o.coupon_code || '', tracking: o.tracking || '', created_by: o.created_by || '',
});

async function inventoryXlsx(res) {
  const d = await inventoryData();
  const wb = newWorkbook();
  const ws = addSheet(wb, 'Inventario', [
    { header: 'Producto', key: 'name', width: 34 }, { header: 'Medidas', key: 'dims', width: 18 },
    { header: 'SKU', key: 'sku', width: 18 }, { header: 'Unid./paquete', key: 'pack', width: 13 },
    { header: 'En stock', key: 'stock', width: 10 }, { header: 'Reservadas (pedidos pendientes)', key: 'reserved', width: 16 },
    { header: 'Vendidas (total)', key: 'sold', width: 14 }, { header: 'Precio', key: 'price', money: true },
    { header: 'Valor del stock', key: 'value', money: true, width: 16 }, { header: 'Visible en tienda', key: 'active', width: 14 },
  ], d.rows.map((p) => ({
    name: p.name, dims: p.dimensions, sku: p.slug, pack: p.pack_size, stock: p.stock, reserved: p.reserved, sold: p.sold,
    price: dollars(p.price_cents), value: dollars(p.stock * p.price_cents), active: p.active ? 'Sí' : 'No',
  })));
  addTotalRow(ws, { name: 'TOTAL', stock: d.totals.stock, reserved: d.totals.reserved, sold: d.totals.sold, value: dollars(d.totals.value) });
  ws.addRow({});
  ws.addRow({ name: `Generado: ${d.generated}` }).font = { italic: true, color: { argb: 'FF6A6E75' } };
  await sendXlsx(res, wb, `inventario-${todayLocal()}.xlsx`);
}

async function salesXlsx(res, range) {
  const d = await salesData(range);
  const s = d.summary;
  const wb = newWorkbook();
  const sum = addSheet(wb, 'Resumen', [{ header: 'Métrica', key: 'k', width: 34 }, { header: 'Valor', key: 'v', width: 18 }], []);
  const put = (k, v, money) => { const r = sum.addRow({ k, v }); if (money) r.getCell('v').numFmt = MONEY_FMT; };
  put('Periodo', `${d.from} a ${d.to}`);
  put('Ingresos (pedidos pagados/enviados/entregados)', dollars(s.revenue), true);
  put('Pedidos', s.orders);
  put('Cajas vendidas', s.units);
  put('Ticket promedio', dollars(s.aov), true);
  put('Subtotal productos', dollars(s.subtotal), true);
  put('Descuentos', dollars(s.discount), true);
  put('Envío cobrado', dollars(s.shipping), true);
  put('Impuesto cobrado', dollars(s.tax), true);
  put('Clientes nuevos', s.newCustomers);
  put('Pedidos pendientes de pago', s.pending);
  put('Pedidos cancelados', s.cancelled);
  put('Generado', d.generated);

  const daily = addSheet(wb, 'Por día', [{ header: 'Día', key: 'day', width: 14 }, { header: 'Pedidos', key: 'orders' },
    { header: 'Cajas', key: 'units' }, { header: 'Ingresos', key: 'revenue', money: true }],
  d.daily.map((r) => ({ day: new Date(r.day).toISOString().slice(0, 10), orders: r.orders, units: r.units, revenue: dollars(r.revenue) })));
  addTotalRow(daily, { day: 'TOTAL', orders: s.orders, units: s.units, revenue: dollars(s.revenue) });

  addSheet(wb, 'Por producto', [{ header: 'Producto', key: 'name', width: 34 }, { header: 'Cajas', key: 'units' },
    { header: 'Ingresos', key: 'revenue', money: true }], d.products.map((p) => ({ name: p.name, units: p.units, revenue: dollars(p.revenue) })));
  addSheet(wb, 'Por método de pago', [{ header: 'Método', key: 'm', width: 26 }, { header: 'Pedidos', key: 'orders' },
    { header: 'Ingresos', key: 'revenue', money: true }], d.payments.map((p) => ({ m: paymentName(p.method), orders: p.orders, revenue: dollars(p.revenue) })));
  addSheet(wb, 'Por canal', [{ header: 'Canal', key: 'c', width: 22 }, { header: 'Pedidos', key: 'orders' },
    { header: 'Ingresos', key: 'revenue', money: true }], d.channels.map((c) => ({ c: channelName(c.source), orders: c.orders, revenue: dollars(c.revenue) })));
  addSheet(wb, 'Pedidos del periodo', ORDER_COLS, d.orders.map(orderRow));
  await sendXlsx(res, wb, `ventas-${d.from}_${d.to}.xlsx`);
}

async function ordersXlsx(res, filter) {
  const rows = await ordersData(filter);
  const wb = newWorkbook();
  addSheet(wb, 'Pedidos', ORDER_COLS, rows.map(orderRow));
  await sendXlsx(res, wb, `pedidos-${todayLocal()}.xlsx`);
}

/* ───────────── PDF ───────────── */

function startPdf(res, filename, title, subtitle) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, info: { Title: title, Author: 'EMPACALO' } });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  if (fs.existsSync(LOGO)) {
    try { doc.image(LOGO, 40, 36, { height: 30 }); } catch { /* unreadable logo: skip it */ }
  }
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111214').text(title, 40, 80);
  doc.font('Helvetica').fontSize(10).fillColor('#6A6E75').text(subtitle);
  doc.moveDown(1);
  return doc;
}

function heading(doc, text) {
  ensureSpace(doc, 60);
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(13).fillColor('#111214').text(text, 40);
  doc.moveDown(0.3);
}

const bottom = (doc) => doc.page.height - doc.page.margins.bottom;

function ensureSpace(doc, h) {
  if (doc.y + h > bottom(doc)) doc.addPage();
}

/** cols: [{ label, width, align }]; rows: arrays of strings. Repeats the header on page breaks. */
function table(doc, cols, rows, { totalRow } = {}) {
  const x0 = 40, rowH = 18;
  const drawHeader = () => {
    // Keep the header with at least one row; text drawn past the margin makes
    // pdfkit add pages on its own (which left blank pages behind).
    if (doc.y + rowH * 2 > bottom(doc)) doc.addPage();
    let x = x0;
    const y = doc.y;
    doc.rect(x0, y, cols.reduce((s, c) => s + c.width, 0), rowH).fill('#111214');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
    cols.forEach((c) => { doc.text(c.label, x + 4, y + 5, { width: c.width - 8, align: c.align || 'left', lineBreak: false, ellipsis: true }); x += c.width; });
    doc.y = y + rowH;
  };
  drawHeader();
  const all = totalRow ? [...rows, totalRow] : rows;
  all.forEach((r, i) => {
    if (doc.y + rowH > bottom(doc)) { doc.addPage(); drawHeader(); }
    const y = doc.y;
    const isTotal = totalRow && i === all.length - 1;
    if (isTotal) doc.rect(x0, y, cols.reduce((s, c) => s + c.width, 0), rowH).fill('#FCEFD9');
    else if (i % 2) doc.rect(x0, y, cols.reduce((s, c) => s + c.width, 0), rowH).fill('#F5F3EF');
    doc.font(isTotal ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor('#111214');
    let x = x0;
    cols.forEach((c, j) => { doc.text(String(r[j] ?? ''), x + 4, y + 5, { width: c.width - 8, align: c.align || 'left', lineBreak: false, ellipsis: true }); x += c.width; });
    doc.y = y + rowH;
  });
  doc.x = x0;
}

function kpis(doc, items) {
  const w = 127, h = 46, gap = 8; // 4 × 127 + 3 × 8 = 532, the letter-page content width
  let rowY = doc.y; // text() moves doc.y, so each row keeps its own y
  items.forEach((it, i) => {
    if (i % 4 === 0) {
      if (i) rowY += h + gap;
      if (rowY + h > bottom(doc)) { doc.addPage(); rowY = doc.page.margins.top; }
    }
    const x = 40 + (i % 4) * (w + gap);
    doc.roundedRect(x, rowY, w, h, 4).fill('#F5F3EF');
    doc.font('Helvetica').fontSize(8).fillColor('#6A6E75').text(it[0], x + 8, rowY + 8, { width: w - 16, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111214').text(it[1], x + 8, rowY + 22, { width: w - 16, lineBreak: false });
  });
  doc.y = rowY + h + gap;
  doc.x = 40;
}

async function inventoryPdf(res) {
  const d = await inventoryData();
  const doc = startPdf(res, `inventario-${todayLocal()}.pdf`, 'Inventario', `Generado: ${d.generated}`);
  kpis(doc, [
    ['Cajas en stock', d.totals.stock.toLocaleString('en-US')],
    ['Valor del stock', lib.money(d.totals.value)],
    ['Reservadas (pendientes)', d.totals.reserved.toLocaleString('en-US')],
    ['Vendidas (histórico)', d.totals.sold.toLocaleString('en-US')],
  ]);
  heading(doc, 'Detalle por producto');
  table(doc, [
    { label: 'Producto', width: 150 }, { label: 'Medidas', width: 88 }, { label: 'Stock', width: 46, align: 'right' },
    { label: 'Reserv.', width: 46, align: 'right' }, { label: 'Vendidas', width: 50, align: 'right' },
    { label: 'Precio', width: 52, align: 'right' }, { label: 'Valor', width: 62, align: 'right' }, { label: 'Visible', width: 38 },
  ], d.rows.map((p) => [p.name, p.dimensions, p.stock, p.reserved, p.sold, lib.money(p.price_cents), lib.money(p.stock * p.price_cents), p.active ? 'Sí' : 'No']),
  { totalRow: ['TOTAL', '', d.totals.stock, d.totals.reserved, d.totals.sold, '', lib.money(d.totals.value), ''] });
  const low = d.rows.filter((p) => p.active && p.stock <= 20);
  if (low.length) {
    heading(doc, 'Inventario bajo (20 o menos)');
    doc.font('Helvetica').fontSize(10).fillColor('#8F5400');
    low.forEach((p) => doc.text(`•  ${p.name}: ${p.stock === 0 ? 'AGOTADO' : `${p.stock} unidades`}`));
  }
  doc.end();
}

async function salesPdf(res, range) {
  const d = await salesData(range);
  const s = d.summary;
  const doc = startPdf(res, `ventas-${d.from}_${d.to}.pdf`, 'Reporte de ventas', `Periodo: ${d.from} a ${d.to}  ·  Generado: ${d.generated}`);
  kpis(doc, [
    ['Ingresos', lib.money(s.revenue)], ['Pedidos', String(s.orders)], ['Cajas vendidas', s.units.toLocaleString('en-US')], ['Ticket promedio', lib.money(s.aov)],
    ['Descuentos', lib.money(s.discount)], ['Envío cobrado', lib.money(s.shipping)], ['Impuesto cobrado', lib.money(s.tax)], ['Clientes nuevos', String(s.newCustomers)],
  ]);
  doc.font('Helvetica').fontSize(8.5).fillColor('#6A6E75')
    .text(`Cuenta pedidos pagados, enviados y entregados. En el periodo además hubo ${s.pending} pendiente(s) de pago y ${s.cancelled} cancelado(s).`, 40);

  heading(doc, 'Ventas por producto');
  if (d.products.length) {
    table(doc, [{ label: 'Producto', width: 300 }, { label: 'Cajas', width: 100, align: 'right' }, { label: 'Ingresos', width: 132, align: 'right' }],
      d.products.map((p) => [p.name, p.units, lib.money(p.revenue)]));
  } else doc.font('Helvetica').fontSize(10).fillColor('#6A6E75').text('Sin ventas en este periodo.');

  heading(doc, 'Por método de pago y canal');
  table(doc, [{ label: 'Método de pago', width: 300 }, { label: 'Pedidos', width: 100, align: 'right' }, { label: 'Ingresos', width: 132, align: 'right' }],
    d.payments.map((p) => [paymentName(p.method), p.orders, lib.money(p.revenue)]));
  doc.moveDown(0.5);
  table(doc, [{ label: 'Canal', width: 300 }, { label: 'Pedidos', width: 100, align: 'right' }, { label: 'Ingresos', width: 132, align: 'right' }],
    d.channels.map((c) => [channelName(c.source), c.orders, lib.money(c.revenue)]));

  heading(doc, 'Ventas por día');
  table(doc, [{ label: 'Día', width: 200 }, { label: 'Pedidos', width: 100, align: 'right' }, { label: 'Cajas', width: 100, align: 'right' }, { label: 'Ingresos', width: 132, align: 'right' }],
    d.daily.map((r) => [new Date(r.day).toISOString().slice(0, 10), r.orders, r.units, lib.money(r.revenue)]),
    { totalRow: ['TOTAL', s.orders, s.units, lib.money(s.revenue)] });
  doc.end();
}

module.exports = { parseRange, inventoryXlsx, inventoryPdf, salesXlsx, salesPdf, ordersXlsx };
