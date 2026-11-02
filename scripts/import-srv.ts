import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

type Variant = {
  id: string;
  sku: string | null;
  name: string;
  price: string;
  mrp: string | null;
  available: boolean;
  options: Record<string, string>;
};
type SourceProduct = {
  id: string;
  name: string;
  slug: string;
  sku: string | null;
  sellingPrice: string;
  category: { name: string; slug: string };
  collectionSlugs: string[];
  description: string;
  sourceUrl: string;
  sourceData: Prisma.InputJsonValue;
  images: { id: string; url: string; alt: string }[];
  variants: Variant[];
  createdAt: string;
  specificationTables: string[][][];
};
type Snapshot = {
  sourceUrl: string;
  sourceHash: string;
  importedAt: string;
  settings: Prisma.InputJsonObject;
  collections: { id: string; slug: string; name: string }[];
  products: SourceProduct[];
};

export async function importSrv(db: PrismaClient) {
  const raw = JSON.parse(
    readFileSync(resolve(process.cwd(), "catalogue/srv.json"), "utf8"),
  );
  const snapshot = raw as Snapshot;
  if (
    snapshot.sourceUrl !== "https://srvelectricals.com" ||
    !snapshot.products.length
  )
    throw new Error("Invalid SRV catalogue");
  await db.$transaction(
    async (tx) => {
      const categoryIds = new Map<string, string>();
      for (const c of [
        ...snapshot.collections,
        {
          id: "uncategorised",
          slug: "electrical-equipment",
          name: "Uncategorised electrical equipment",
        },
      ]) {
        const category = await tx.category.upsert({
          where: { slug: c.slug },
          create: { name: c.name, slug: c.slug },
          update: {},
        });
        categoryIds.set(c.slug, category.id);
      }
      for (const p of snapshot.products) {
        // Internal keys are distinct from supplier SKUs, which can be missing or duplicated.
        const values = {
          name: p.name,
          slug: p.slug,
          sourceId: p.id,
          sourceSku: p.sku,
          sourceUrl: p.sourceUrl,
          sourceData: p.sourceData,
          sourceCollectionSlugs: p.collectionSlugs,
          categoryId: categoryIds.get(p.category.slug)!,
          description: p.description,
          sellingPrice: p.sellingPrice,
          mrp: p.variants[0]?.mrp || null,
          gstRate: null,
          minimumOrderQuantity: null,
          published: true,
          featured: p.collectionSlugs.includes("featured-products"),
        };
        const product = await tx.product.upsert({
          where: { sourceId: p.id },
          create: {
            ...values,
            sku: "SRV-P-" + p.id,
            createdAt: new Date(p.createdAt),
          },
          update: values,
        });
        for (const [index, rows] of p.specificationTables.entries()) {
          const key = "source-table-" + (index + 1);
          await tx.productSpecification.upsert({
            where: { productId_key: { productId: product.id, key } },
            create: { productId: product.id, key, value: JSON.stringify(rows) },
            update: { value: JSON.stringify(rows) },
          });
        }
        for (const [i, image] of p.images.entries()) {
          const values = {
            productId: product.id,
            url: image.url,
            alt: image.alt,
            sortOrder: i,
          };
          await tx.productImage.upsert({
            where: { sourceAssetId: image.id },
            create: { ...values, sourceAssetId: image.id },
            update: values,
          });
        }
        for (const v of p.variants) {
          const values = {
            productId: product.id,
            sourceId: v.id,
            sourceSku: v.sku,
            sourceAvailable: v.available,
            name: v.name,
            attributes: v.options,
            sellingPrice: v.price,
          };
          await tx.productVariant.upsert({
            where: { sourceId: v.id },
            create: { ...values, sku: "SRV-V-" + v.id },
            update: values,
          });
          // Public availability is not an inventory count. Do not manufacture Inventory rows.
        }
      }
      await tx.siteSettings.upsert({
        where: { id: "main" },
        create: { id: "main", content: snapshot.settings },
        update: { content: snapshot.settings },
      });
      await tx.catalogueSnapshot.upsert({
        where: { id: "srv" },
        create: {
          id: "srv",
          sourceUrl: snapshot.sourceUrl,
          sourceHash: snapshot.sourceHash,
          importedAt: new Date(snapshot.importedAt),
          payload: raw,
        },
        update: {
          sourceHash: snapshot.sourceHash,
          importedAt: new Date(snapshot.importedAt),
          payload: raw,
        },
      });
      await tx.catalogueImport.upsert({
        where: { sourceHash: snapshot.sourceHash },
        create: {
          sourceName: snapshot.sourceUrl,
          sourceHash: snapshot.sourceHash,
          approvalReference:
            "User instruction: use SRV website data and logo, 2026-10-29",
          status: "IMPORTED",
          validationErrors: [],
        },
        update: {},
      });
    },
    { timeout: 120000 },
  );
  console.log(
    `Imported SRV catalogue: ${snapshot.products.length} products; supplier SKUs preserved; GST and inventory counts remain unknown.`,
  );
}

if (require.main === module) {
  const db = new PrismaClient();
  importSrv(db)
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
