// Structured data (schema.org JSON-LD), sitemap, Google Merchant feed and llms.txt helpers.
const lib = require('./lib');

function organization(siteUrl, settings) {
  const contact = { '@type': 'ContactPoint', contactType: 'customer service', areaServed: 'US', availableLanguage: ['English', 'Spanish'] };
  if (settings.support_email) contact.email = settings.support_email;
  if (settings.support_phone) contact.telephone = settings.support_phone;
  const org = {
    '@context': 'https://schema.org', '@type': 'Organization', '@id': `${siteUrl}/#organization`,
    name: settings.store_name, url: siteUrl, logo: `${siteUrl}/logo.png`, contactPoint: contact,
  };
  if (settings.business_address) org.address = { '@type': 'PostalAddress', streetAddress: settings.business_address, addressCountry: 'US' };
  return org;
}

function homeLd({ siteUrl, settings, t, money }) {
  const faq = [1, 2, 3, 4].map((n) => ({
    '@type': 'Question',
    name: t(`faq_${n}_q`),
    acceptedAnswer: { '@type': 'Answer', text: t(`faq_${n}_a`, { flat: money(settings.shipping_flat_cents), min: money(settings.free_shipping_min_cents) }) },
  }));
  return [
    organization(siteUrl, settings),
    { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${siteUrl}/#website`, name: settings.store_name, url: siteUrl, inLanguage: ['en', 'es'], publisher: { '@id': `${siteUrl}/#organization` } },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq },
  ];
}

function productLd({ siteUrl, settings, product, images, pt, url }) {
  const price = (c) => (c / 100).toFixed(2);
  const validUntil = `${new Date().getUTCFullYear() + 1}-12-31`;
  const availability = product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
  const base = {
    '@type': 'Offer', url, priceCurrency: 'USD', price: price(product.price_cents), priceValidUntil: validUntil,
    availability, itemCondition: 'https://schema.org/NewCondition',
    seller: { '@id': `${siteUrl}/#organization` },
    shippingDetails: {
      '@type': 'OfferShippingDetails',
      shippingRate: { '@type': 'MonetaryAmount', value: price(Number(settings.shipping_flat_cents || 0)), currency: 'USD' },
      shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
    },
  };
  // Volume ("wholesale") tiers become extra offers with a minimum quantity.
  const tiers = lib.wholesaleTiers(product);
  let offers = base;
  if (tiers.length) {
    const tierOffers = tiers.map((t) => ({
      '@type': 'Offer', url, priceCurrency: 'USD', price: price(t.cents), priceValidUntil: validUntil, availability,
      itemCondition: 'https://schema.org/NewCondition',
      eligibleQuantity: { '@type': 'QuantitativeValue', minValue: t.qty, unitText: 'unit' },
    }));
    const all = [product.price_cents, ...tiers.map((t) => t.cents)];
    offers = {
      '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: price(Math.min(...all)), highPrice: price(Math.max(...all)),
      offerCount: tierOffers.length + 1, availability, offers: [base, ...tierOffers],
    };
  }
  const item = {
    '@context': 'https://schema.org', '@type': 'Product', '@id': `${url}#product`,
    name: pt(product, 'name'), description: pt(product, 'description') || pt(product, 'short_desc') || pt(product, 'name'),
    sku: product.slug, url, brand: { '@type': 'Brand', name: settings.store_name },
    image: images.length ? images.map((id) => `${siteUrl}/img/${id}`) : [`${siteUrl}/logo.png`],
    category: product.category === 'supply' ? 'Packing Supplies' : 'Cardboard Boxes',
    offers,
  };
  if (product.dimensions) item.size = product.dimensions;
  const crumbs = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: settings.store_name, item: siteUrl },
      { '@type': 'ListItem', position: 2, name: pt(product, 'name'), item: url },
    ],
  };
  return [item, crumbs];
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Every page is listed in English and Spanish, each pointing at both versions.
function sitemap(siteUrl, pages) {
  const urls = pages.flatMap(({ path, lastmod, image }) => ['en', 'es'].map((l) => {
    const loc = `${siteUrl}${path}${l === 'es' ? '?lang=es' : ''}`;
    return `<url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}`
      + `<xhtml:link rel="alternate" hreflang="en" href="${xml(siteUrl + path)}"/>`
      + `<xhtml:link rel="alternate" hreflang="es" href="${xml(`${siteUrl}${path}?lang=es`)}"/>`
      + `<xhtml:link rel="alternate" hreflang="x-default" href="${xml(siteUrl + path)}"/>`
      + (image ? `<image:image><image:loc>${xml(`${siteUrl}/img/${image.id}`)}</image:loc><image:title>${xml(image.title)}</image:title></image:image>` : '')
      + '</url>';
  }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.join('\n')}\n</urlset>\n`;
}

// Google Merchant Center RSS 2.0 feed. Products without a photo are left out
// (Merchant Center rejects items with no image).
function googleFeed({ siteUrl, settings, products, lang }) {
  const pt = (p, f) => (lang === 'es' && p[f + '_es']) || p[f];
  const suffix = lang === 'es' ? '?lang=es' : '';
  const ship = `${(Number(settings.shipping_flat_cents || 0) / 100).toFixed(2)} USD`;
  const tag = (name, v) => (v ? `<g:${name}>${xml(v)}</g:${name}>` : '');
  const items = products.filter((p) => p.image_id).map((p) => {
    const name = pt(p, 'name');
    const desc = pt(p, 'description') || pt(p, 'short_desc') || name;
    return '<item>'
      + tag('id', p.slug) + `<title>${xml(name.slice(0, 150))}</title>`
      + `<description>${xml(desc.slice(0, 5000))}</description>`
      + `<link>${xml(`${siteUrl}/products/${p.slug}${suffix}`)}</link>`
      + tag('image_link', `${siteUrl}/img/${p.image_id}`)
      + tag('availability', p.stock > 0 ? 'in_stock' : 'out_of_stock')
      + tag('price', `${(p.price_cents / 100).toFixed(2)} USD`)
      + tag('condition', 'new') + tag('brand', settings.store_name) + tag('identifier_exists', 'no')
      + tag('size', p.dimensions)
      + tag('product_type', p.category === 'supply' ? 'Packing Supplies' : `Cardboard Boxes${p.wall_type === 'single' ? ' > Single Wall' : ' > Double Wall'}`)
      + `<g:shipping><g:country>US</g:country><g:service>Standard</g:service><g:price>${ship}</g:price></g:shipping>`
      + '</item>';
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>`
    + `<title>${xml(settings.store_name)}</title><link>${xml(siteUrl)}</link><description>${xml(settings.store_name)} product feed</description>\n${items.join('\n')}\n</channel></rss>\n`;
}

// Plain-text site summary for AI assistants (llms.txt convention).
function llmsTxt({ siteUrl, settings, products }) {
  const lines = [
    `# ${settings.store_name}`,
    '',
    `> Online store for double wall and single wall cardboard boxes and packing supplies. Retail and volume (wholesale) pricing, shipped to any address in the USA. English and Spanish.`,
    '',
    '## Key pages',
    `- [Home / catalog](${siteUrl}/)`,
    `- [Contact](${siteUrl}/contact)`,
    `- [Terms](${siteUrl}/terms)`,
    `- [Privacy](${siteUrl}/privacy)`,
    `- [Sitemap](${siteUrl}/sitemap.xml)`,
    '',
    '## Products',
    ...products.map((p) => `- [${p.name}](${siteUrl}/products/${p.slug}): ${lib.money(p.price_cents)} each`),
    '',
  ];
  if (settings.support_email) lines.push(`Contact: ${settings.support_email}${settings.support_phone ? ` · ${settings.support_phone}` : ''}`, '');
  return lines.join('\n');
}

module.exports = { homeLd, productLd, sitemap, googleFeed, llmsTxt };
