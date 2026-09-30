// Size-specific product copy for the standard cardboard boxes (EN + ES), so 22
// box pages don't all carry the same paragraph.
const USE = {
  double: {
    en: ['books, tools and small heavy items', 'kitchenware, shoes and everyday moving', 'clothing, toys and bulky loads', 'bedding, lamps and large, bulky items'],
    es: ['libros, herramientas y artículos pequeños y pesados', 'utensilios de cocina, zapatos y mudanzas de uso diario', 'ropa, juguetes y cargas voluminosas', 'ropa de cama, lámparas y artículos grandes y voluminosos'],
  },
  single: {
    en: ['light items like clothing, toys and linens', 'light to medium everyday items', 'clothing, toys and lighter bulky items', 'bedding, pillows and other large, light items'],
    es: ['artículos livianos como ropa, juguetes y blancos', 'artículos cotidianos livianos a medianos', 'ropa, juguetes y artículos voluminosos livianos', 'ropa de cama, almohadas y otros artículos grandes y livianos'],
  },
};

function boxCopy({ dimensions, wall, hasTiers }) {
  const d = (String(dimensions).match(/\d+(\.\d+)?/g) || []).map(Number);
  if (d.length < 3 || !USE[wall]) return null;
  const cuft = (d[0] * d[1] * d[2]) / 1728;
  const n = cuft.toFixed(1);
  const i = cuft < 2 ? 0 : cuft < 5 ? 1 : cuft < 10 ? 2 : 3;
  const en = USE[wall].en[i], es = USE[wall].es[i];
  const tEn = hasTiers ? ' Volume pricing from 50 boxes — the more you order, the less you pay per box.' : '';
  const tEs = hasTiers ? ' Precio de mayoreo desde 50 cajas: mientras más compras, menos pagas por caja.' : '';
  if (wall === 'double') {
    return {
      short_desc: `Double wall, 275 lb test · ${n} cu ft · ideal for ${en}.`,
      short_desc_es: `Doble pared, prueba de 275 lb · ${n} pies³ · ideal para ${es}.`,
      description: `Double-wall corrugated cardboard box, ${dimensions} (${n} cubic feet), with a 275 lb bursting test. Two layers of fluting make it much stiffer than a standard single-wall moving box, so it holds its shape when stacked and loaded with heavy items. Ideal for ${en}.\n\nShips flat. Assembles in seconds with packing tape.${tEn}`,
      description_es: `Caja de cartón corrugado de doble pared, ${dimensions} (${n} pies cúbicos), con prueba de estallido de 275 lb. Las dos capas de onda la hacen mucho más rígida que una caja de mudanza normal: no se deforma al apilarla ni con peso adentro. Ideal para ${es}.\n\nSe envía plana. Se arma en segundos con cinta de embalaje.${tEs}`,
    };
  }
  return {
    short_desc: `Single wall · ${n} cu ft · ideal for ${en}.`,
    short_desc_es: `Pared sencilla · ${n} pies³ · ideal para ${es}.`,
    description: `Single-wall corrugated cardboard box, ${dimensions} (${n} cubic feet) — our lightest, most economical option. Ideal for ${en}. For heavy or fragile loads, choose the double-wall version.\n\nShips flat. Assembles in seconds with packing tape.${tEn}`,
    description_es: `Caja de cartón corrugado de pared sencilla, ${dimensions} (${n} pies cúbicos): nuestra opción más ligera y económica. Ideal para ${es}. Para cargas pesadas o frágiles elige la versión de doble pared.\n\nSe envía plana. Se arma en segundos con cinta de embalaje.${tEs}`,
  };
}

module.exports = { boxCopy };
