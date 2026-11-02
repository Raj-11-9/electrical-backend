import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { importSrv } from "../scripts/import-srv";

test("SRV import is idempotent and preserves supplier data without invented tax or inventory", async () => {
  const names = [
    "category",
    "product",
    "productImage",
    "productVariant",
    "productSpecification",
    "siteSettings",
    "catalogueSnapshot",
    "catalogueImport",
  ];
  const tables = new Map(
    names.map((n) => [n, new Map<string, Record<string, unknown>>()]),
  );
  const tx = Object.fromEntries(
    names.map((name) => [
      name,
      {
        upsert: async (args: {
          where: Record<string, unknown>;
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const key = JSON.stringify(args.where),
            table = tables.get(name)!;
          const value = table.has(key)
            ? { ...table.get(key), ...args.update }
            : { id: name + "-" + table.size, ...args.create };
          table.set(key, value);
          return value;
        },
      },
    ]),
  );
  const client = {
    $transaction: async (fn: (transaction: typeof tx) => Promise<void>) =>
      fn(tx),
  } as unknown as PrismaClient;
  await importSrv(client);
  const first = Object.fromEntries([...tables].map(([n, t]) => [n, t.size]));
  await importSrv(client);
  assert.deepEqual(
    Object.fromEntries([...tables].map(([n, t]) => [n, t.size])),
    first,
  );
  const source = JSON.parse(
    readFileSync(resolve(process.cwd(), "catalogue/srv.json"), "utf8"),
  );
  assert.equal(first.product, source.products.length);
  assert.equal(
    first.productVariant,
    source.products.reduce(
      (n: number, p: { variants: unknown[] }) => n + p.variants.length,
      0,
    ),
  );
  for (const row of tables.get("product")!.values()) {
    assert.equal(row.gstRate, null);
    assert.equal(row.minimumOrderQuantity, null);
    const original = source.products.find(
      (p: { id: string }) => p.id === row.sourceId,
    );
    assert.equal(row.sourceSku, original.sku);
    assert.equal(row.sellingPrice, original.sellingPrice);
  }
  assert.equal(first.catalogueSnapshot, 1);
  assert.equal(first.catalogueImport, 1);
});

test("renderable source HTML is stripped of executable elements and event handlers", () => {
  const source = JSON.parse(
    readFileSync(resolve(process.cwd(), "catalogue/srv.json"), "utf8"),
  );
  for (const html of [
    ...source.products.map(
      (p: { descriptionHtml: string }) => p.descriptionHtml,
    ),
    ...source.pages.map((p: { html: string }) => p.html),
  ]) {
    assert.doesNotMatch(html, /<(?:script|iframe|form|object|embed)\b/i);
    assert.doesNotMatch(html, /\son\w+\s*=/i);
    assert.doesNotMatch(html, /(?:href|src)="javascript:/i);
  }
});
