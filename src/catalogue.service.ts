import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from './prisma.service';
import { publicCatalogue } from './public-content';

@Injectable()
export class CatalogueService {
  private readonly snapshot = JSON.parse(readFileSync(resolve(process.cwd(), 'catalogue/srv.json'), 'utf8'));
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async read() {
    try {
    if (await this.db.checkConnection()) {
      const record = await this.db.catalogueSnapshot.findUnique({ where: { id: 'srv' } });
      const settings = await this.db.siteSettings.findUnique({ where: { id: 'main' } });
      if (record) {
        const payload =
          typeof record.payload === "object" &&
          record.payload !== null &&
          !Array.isArray(record.payload)
            ? { ...record.payload }
            : {};
        const source = payload as {
          products?: Array<Record<string, unknown>>;
          collections?: Array<Record<string, unknown>>;
        };
        const [products, categories] = await Promise.all([
          this.db.product.findMany({
            where: { published: true, archived: false },
            include: {
              category: true,
              images: { orderBy: { sortOrder: "asc" } },
              variants: { include: { inventory: true } },
            },
          }),
          this.db.category.findMany({
            include: {
              products: {
                where: { published: true, archived: false },
                select: { id: true, sourceId: true },
              },
            },
          }),
        ]);
        const originalProducts = new Map((source.products || []).map(p => [String(p.id), p]));
        const additionalProducts = products.map((product) => ({
          ...(originalProducts.get(product.sourceId || "") || {}),
          id: product.sourceId || product.id,
          name: product.name,
          slug: product.slug,
          sku: product.sku,
          sellingPrice: product.sellingPrice.toString(),
          category: {
            name: product.category.name,
            slug: product.category.slug,
          },
          collectionSlugs: product.sourceCollectionSlugs,
          description: product.description,
          descriptionHtml: undefined,
          createdAt: product.createdAt.toISOString(),
          updatedAt: product.updatedAt.toISOString(),
          images: product.images.map((image) => ({
            id: image.id,
            url: image.url,
            alt: image.alt,
          })),
          variants: product.variants.map((variant) => ({
            id: variant.id,
            sku: variant.sku,
            name: variant.name,
            price: variant.sellingPrice.toString(),
            mrp: null,
            available:
              variant.inventory !== null ?
              variant.inventory.quantity > variant.inventory.reserved : variant.sourceAvailable === true,
            options: variant.attributes,
            image: product.images[0]?.url ?? null,
            grams: 0,
            taxable: true,
          })),
        }));
        const collectionBySlug = new Map(
          (source.collections || []).map((collection) => [
            String(collection.slug),
            collection,
          ]),
        );
        for (const category of categories) {
          const existing = collectionBySlug.get(category.slug);
          const productIds = [
            ...new Set([
              ...((existing?.productIds as string[] | undefined) || []),
              ...category.products.map(
                (product) => product.sourceId || product.id,
              ),
            ]),
          ];
          collectionBySlug.set(category.slug, {
            ...existing,
            id: category.id,
            name: category.name,
            slug: category.slug,
            productIds,
          });
        }
        source.products = additionalProducts;
        const visibleIds = new Set(additionalProducts.map(p => p.id));
        for (const collection of collectionBySlug.values()) {
          collection.productIds = ((collection.productIds as string[] | undefined) || []).filter(id => visibleIds.has(id));
        }
        source.collections = [...collectionBySlug.values()];
        return publicCatalogue(payload, settings?.content, 'postgresql');
      }
    }
    } catch { this.db.invalidateConnection(); }
    if (this.db.previewEnabled) return publicCatalogue(this.snapshot, this.snapshot.settings, 'snapshot');
    throw new ServiceUnavailableException('Catalogue is temporarily unavailable');
  }
}
