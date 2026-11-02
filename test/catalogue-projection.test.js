"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const public_content_1 = require("../src/public-content");
(0, node_test_1.test)('public catalogue strips raw records, wholesale prices and private settings at every projected level', () => {
    const payload = { sourceUrl: 'https://srvelectricals.com', importedAt: '2026-10-29', sourceHash: 'hash', privateToken: 'secret', products: [{ id: '1', name: 'Product', slug: 'product', sku: 'SKU', sellingPrice: '10', wholesalePrice: '1', sourceData: { private: 'secret' }, category: { name: 'Category', slug: 'category' }, collectionSlugs: [], images: [{ url: 'https://example.com/a.png', alt: 'Product', cloudinarySecret: 'secret' }], variants: [{ id: '2', name: 'Option', sku: 'SKU', price: '10', available: true, wholesalePrice: '1', options: {} }] }], pages: [], collections: [] };
    const result = (0, public_content_1.publicCatalogue)(payload, { brand: 'SRV', smtpPassword: 'secret' }, 'snapshot');
    const serialised = JSON.stringify(result);
    for (const forbidden of ['wholesalePrice', 'sourceData', 'privateToken', 'smtpPassword', 'cloudinarySecret'])
        strict_1.default.equal(serialised.includes(forbidden), false);
    strict_1.default.equal(result.storage, 'snapshot');
    strict_1.default.equal(result.readOnly, true);
    strict_1.default.equal(result.products.length, 1);
});
