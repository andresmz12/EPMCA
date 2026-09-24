// Structured data (schema.org JSON-LD) and sitemap helpers.

function organization(siteUrl, settings) {
  const contact = { '@type': 'ContactPoint', contactType: 'customer service', areaServed: 'US', availableLanguage: ['English', 'Spanish'] };
  if (settings.support_email) contact.email = settings.support_email;
  if (settings.support_phone) contact.telephone = settings.support_phone;
  return {
    '@context': 'https://schema.org', '@type': 'Organization',
    name: settings.store_name, url: siteUrl, logo: `${siteUrl}/logo.png`, contactPoint: contact,
  };
}

function homeLd({ siteUrl, settings, t, money }) {
  const faq = [1, 2, 3, 4].map((n) => ({
    '@type': 'Question',
    name: t(`faq_${n}_q`),
    acceptedAnswer: { '@type': 'Answer', text: t(`faq_${n}_a`, { flat: money(settings.shipping_flat_cents), min: money(settings.free_shipping_min_cents) }) },
  }));
  return [
    organization(siteUrl, settings),
    { '@context': 'https://schema.org', '@type': 'WebSite', name: settings.store_name, url: siteUrl },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq },
  ];
}

function productLd({ siteUrl, settings, product, images, pt, url }) {
  const offer = {
    '@type': 'Offer', url, priceCurrency: 'USD', price: (product.price_cents / 100).toFixed(2),
    availability: product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    itemCondition: 'https://schema.org/NewCondition',
    shippingDetails: {
      '@type': 'OfferShippingDetails',
      shippingRate: { '@type': 'MonetaryAmount', value: (Number(settings.shipping_flat_cents || 0) / 100).toFixed(2), currency: 'USD' },
      shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'US' },
    },
  };
  const item = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: pt(product, 'name'), description: pt(product, 'description') || pt(product, 'short_desc'),
    sku: product.slug, brand: { '@type': 'Brand', name: settings.store_name },
    image: images.length ? images.map((id) => `${siteUrl}/img/${id}`) : [`${siteUrl}/logo.png`],
    offers: offer,
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
  const urls = pages.flatMap(({ path, lastmod }) => ['en', 'es'].map((l) => {
    const loc = `${siteUrl}${path}${l === 'es' ? '?lang=es' : ''}`;
    return `<url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}`
      + `<xhtml:link rel="alternate" hreflang="en" href="${xml(siteUrl + path)}"/>`
      + `<xhtml:link rel="alternate" hreflang="es" href="${xml(`${siteUrl}${path}?lang=es`)}"/>`
      + `<xhtml:link rel="alternate" hreflang="x-default" href="${xml(siteUrl + path)}"/></url>`;
  }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
}

module.exports = { homeLd, productLd, sitemap };
