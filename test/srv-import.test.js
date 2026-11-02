"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const import_srv_1 = require("../scripts/import-srv");
(0, node_test_1.test)("SRV import is idempotent and preserves supplier data without invented tax or inventory", async () => {
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
    const tables = new Map(names.map((n) => [n, new Map()]));
    const tx = Object.fromEntries(names.map((name) => [
        name,
        {
            upsert: async (args) => {
                const key = JSON.stringify(args.where), table = tables.get(name);
                const value = table.has(key)
                    ? { ...table.get(key), ...args.update }
                    : { id: name + "-" + table.size, ...args.create };
                table.set(key, value);
                return value;
            },
        },
    ]));
    const client = {
        $transaction: async (fn) => fn(tx),
    };
    await (0, import_srv_1.importSrv)(client);
    const first = Object.fromEntries([...tables].map(([n, t]) => [n, t.size]));
    await (0, import_srv_1.importSrv)(client);
    strict_1.default.deepEqual(Object.fromEntries([...tables].map(([n, t]) => [n, t.size])), first);
    const source = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.resolve)(process.cwd(), "catalogue/srv.json"), "utf8"));
    strict_1.default.equal(first.product, source.products.length);
    strict_1.default.equal(first.productVariant, source.products.reduce((n, p) => n + p.variants.length, 0));
    for (const row of tables.get("product").values()) {
        strict_1.default.equal(row.gstRate, null);
        strict_1.default.equal(row.minimumOrderQuantity, null);
        const original = source.products.find((p) => p.id === row.sourceId);
        strict_1.default.equal(row.sourceSku, original.sku);
        strict_1.default.equal(row.sellingPrice, original.sellingPrice);
    }
    strict_1.default.equal(first.catalogueSnapshot, 1);
    strict_1.default.equal(first.catalogueImport, 1);
});
(0, node_test_1.test)("renderable source HTML is stripped of executable elements and event handlers", () => {
    const source = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.resolve)(process.cwd(), "catalogue/srv.json"), "utf8"));
    for (const html of [
        ...source.products.map((p) => p.descriptionHtml),
        ...source.pages.map((p) => p.html),
    ]) {
        strict_1.default.doesNotMatch(html, /<(?:script|iframe|form|object|embed)\b/i);
        strict_1.default.doesNotMatch(html, /\son\w+\s*=/i);
        strict_1.default.doesNotMatch(html, /(?:href|src)="javascript:/i);
    }
});
