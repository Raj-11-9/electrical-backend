import { test } from "node:test";
import assert from "node:assert/strict";
import { publicProductSelect, publicSettings } from "../src/public-content";

test("public settings omit secrets, malformed reviews and invalid contact numbers", () => {
  const result = publicSettings({
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
  assert.deepEqual(result, {
    heroTitle: "Approved title",
    reviews: [{ name: "Approved customer", quote: "Approved review" }],
  });
  assert.deepEqual(publicSettings(null), {});
});

test("public product selection does not expose dealer prices or internal asset IDs", () => {
  const fields = Object.keys(publicProductSelect);
  assert.equal(fields.includes("wholesalePrice"), false);
  assert.equal(fields.includes("dealerPrices"), false);
  assert.equal(
    "cloudinaryPublicId" in publicProductSelect.images.select,
    false,
  );
  assert.equal(publicProductSelect.sellingPrice, true);
});
