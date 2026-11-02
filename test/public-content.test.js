"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const public_content_1 = require("../src/public-content");
(0, node_test_1.test)("public settings omit secrets, malformed reviews and invalid contact numbers", () => {
    const result = (0, public_content_1.publicSettings)({
        heroTitle: "Approved title",
        smtpPassword: "private",
        jwtSecret: "private",
        whatsappNumber: "javascript:invalid",
        reviews: [
            { name: "Approved customer", quote: "Approved review", email: "private" },
            null,
            {},
        ],
    });
    strict_1.default.deepEqual(result, {
        heroTitle: "Approved title",
        reviews: [{ name: "Approved customer", quote: "Approved review" }],
    });
    strict_1.default.deepEqual((0, public_content_1.publicSettings)(null), {});
});
(0, node_test_1.test)("public product selection does not expose dealer prices or internal asset IDs", () => {
    const fields = Object.keys(public_content_1.publicProductSelect);
    strict_1.default.equal(fields.includes("wholesalePrice"), false);
    strict_1.default.equal(fields.includes("dealerPrices"), false);
    strict_1.default.equal("cloudinaryPublicId" in public_content_1.publicProductSelect.images.select, false);
    strict_1.default.equal(public_content_1.publicProductSelect.sellingPrice, true);
});
