export function publicSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of [
    "brand",
    "heroTitle",
    "heroDescription",
    "announcement",
    "businessEmail",
    "businessPhone",
    "businessAddress",
    "businessHours",
  ]) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  if (
    typeof source.whatsappNumber === "string" &&
    /^\d{7,15}$/.test(source.whatsappNumber)
  ) {
    result.whatsappNumber = source.whatsappNumber;
  }
  for (const key of ["brands", "certifications"]) {
    if (Array.isArray(source[key]))
      result[key] = source[key].filter((v) => typeof v === "string");
  }
  if (Array.isArray(source.reviews)) {
    result.reviews = source.reviews
      .filter((v): v is { name: string; quote: string } =>
        Boolean(
          v &&
            typeof v === "object" &&
            typeof v.name === "string" &&
            typeof v.quote === "string",
        ),
      )
      .map(({ name, quote }) => ({ name, quote }));
  }
  return result;
}

// Restricted pricing and internal asset identifiers must never reach the public storefront.
export const publicProductSelect = {
  id: true,
  name: true,
  slug: true,
  sku: true,
  sellingPrice: true,
  category: { select: { name: true } },
  images: {
    select: { url: true, alt: true },
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

type JsonRecord = Record<string, unknown>;
function object(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function pick(value: unknown, keys: string[]): JsonRecord { const source=object(value); return Object.fromEntries(keys.filter(key=>key in source).map(key=>[key,source[key]])); }
function items(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
/** Only the public catalogue contract leaves the API. Raw source JSON and future private pricing do not. */
export function publicCatalogue(payload: unknown, settings: unknown, storage: 'snapshot'|'postgresql') {
  const source=object(payload);
  return {
    ...pick(source,['sourceUrl','sourceHash','importedAt']), storage, readOnly: true,
    settings: publicSettings(settings),
    collections: items(source.collections).map(c=>pick(c,['id','name','slug','productIds','image','sourceUrl'])),
    pages: items(source.pages).map(p=>pick(p,['slug','title','html','sourceUrl'])),
    products: items(source.products).map(value=>{
      const product=object(value);
      return {
        ...pick(product,['id','name','slug','sku','sellingPrice','category','collectionSlugs','descriptionHtml','description','sourceUrl','vendor','createdAt','updatedAt']),
        images: items(product.images).map(i=>pick(i,['id','url','alt'])),
        variants: items(product.variants).map(v=>pick(v,['id','sku','name','price','mrp','available','options','image','grams','taxable'])),
      };
    }),
  };
}
