const assert = require("node:assert/strict");
const { createHmac, randomBytes } = require("node:crypto");
const { CommerceService } = require("../dist/commerce");

const originalEnv = { ...process.env };
const variant = {
  id: "variant-db-id",
  sourceId: "qa-v",
  sku: "QA-V",
  sourceSku: null,
  name: "QA variant",
  sellingPrice: 100,
  product: {
    name: "QA product",
    published: true,
    archived: false,
    gstRate: 18,
    minimumOrderQuantity: 1,
  },
  inventory: { quantity: 10, reserved: 0 },
};
const state = { order: null, payment: null, ordersCreated: 0, reserves: 0 };
const tx = {
  order: {
    findUnique: async () => state.order,
    create: async ({ data }) => {
      state.ordersCreated++;
      state.payment = {
        id: "payment-db-id",
        method: data.payments.create.method,
        amount: data.payments.create.amount,
        status: "PENDING",
        providerOrderId: null,
        providerPaymentId: null,
      };
      state.order = {
        id: "order-db-id",
        number: data.number,
        idempotencyKey: data.idempotencyKey,
        userId: data.userId || null,
        customerSnapshot: data.customerSnapshot,
        status: "PENDING",
        total: data.total,
        currency: "INR",
        createdAt: new Date(),
        items: data.items.create.map((item) => ({
          ...item,
          variantSnapshot: { name: "QA variant" },
        })),
        payments: [state.payment],
        shipments: [],
      };
      return state.order;
    },
  },
  productVariant: { findMany: async () => [variant] },
  $queryRaw: async () => {
    variant.inventory.reserved++;
    state.reserves++;
    return [{ id: "inventory-db-id" }];
  },
  customer: { create: async () => ({ id: "customer-db-id" }) },
};
const db = {
  checkConnection: async () => true,
  $transaction: async (work) => work(tx),
  payment: {
    findUnique: async ({ where }) =>
      state.payment?.providerOrderId === where.providerOrderId
        ? { ...state.payment, order: state.order }
        : null,
    updateMany: async ({ where, data }) => {
      if (
        state.payment?.id !== where.id ||
        state.payment.method !== where.method ||
        state.payment.providerOrderId !== where.providerOrderId ||
        state.payment.status !== where.status
      )
        return { count: 0 };
      Object.assign(state.payment, data);
      return { count: 1 };
    },
    update: async ({ where, data }) => {
      assert.equal(state.payment.id, where.id);
      Object.assign(state.payment, data);
      return state.payment;
    },
  },
};
const service = new CommerceService(db);
const key = "123e4567-e89b-12d3-a456-426614174000";
const input = {
  idempotencyKey: key,
  method: "RAZORPAY",
  items: [{ variantId: "qa-v", quantity: 2 }],
  customer: {
    name: "QA customer",
    email: "qa@example.test",
    phone: "9999999999",
  },
  address: {
    line1: "QA address",
    city: "QA city",
    state: "Punjab",
    pinCode: "151505",
  },
};
const hmac = (body, secret) =>
  createHmac("sha256", secret).update(body).digest("hex");

(async () => {
  try {
    process.env.JWT_SECRET = randomBytes(48).toString("hex");
    process.env.ENABLE_COD = "true";
    process.env.CHECKOUT_SHIPPING_PAISE = "5000";
    process.env.CHECKOUT_TAX_MODE = "INCLUSIVE";
    process.env.RAZORPAY_KEY_ID = "rzp_test_id";
    process.env.RAZORPAY_KEY_SECRET = "test_key_secret";
    delete process.env.RAZORPAY_WEBHOOK_SECRET;

    const unavailableQuote = await service.quote(input, tx);
    assert.deepEqual(unavailableQuote.methods, ["COD"]);
    process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";
    process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";

    const quote = await service.quote(input, tx);
    assert.equal(quote.items[0].subtotal, 16949);
    assert.equal(quote.items[0].gst, 3051);
    assert.equal(quote.items[0].total, 20000);
    assert.equal(quote.subtotal, 16949);
    assert.equal(quote.gst, 3051);
    assert.equal(quote.shipping, 5000);
    assert.equal(quote.total, 25000);
    assert.deepEqual(quote.methods, ["COD", "RAZORPAY"]);
    console.log("PASS inclusive quote and enabled payment methods");

    let remoteOrderCreates = 0;
    let remotePaymentFetches = 0;
    service.provider = async (path, data) => {
      if (path === "orders") {
        remoteOrderCreates++;
        assert.equal(data.amount, 25000);
        assert.equal(data.currency, "INR");
        return { id: "order_test_qa" };
      }
      if (path === "payments/pay_test_qa") {
        remotePaymentFetches++;
        return {
          order_id: "order_test_qa",
          amount: 25000,
          currency: "INR",
          status: "captured",
        };
      }
      throw Error("Unexpected payment provider request");
    };

    const created = await service.create(input, { headers: {} });
    assert.equal(created.order.total, 250);
    assert.equal(created.razorpay.order_id, "order_test_qa");
    assert.equal(created.razorpay.amount, 25000);
    assert.equal(state.ordersCreated, 1);
    assert.equal(state.reserves, 1);
    assert.equal(remoteOrderCreates, 1);
    console.log("PASS Razorpay order creation and stock reservation");

    const resumed = await service.create(input, { headers: {} });
    assert.equal(resumed.order.number, created.order.number);
    assert.equal(resumed.razorpay.order_id, "order_test_qa");
    assert.equal(state.ordersCreated, 1);
    assert.equal(state.reserves, 1);
    assert.equal(remoteOrderCreates, 1);
    console.log("PASS retry resumes the same order without another charge order");

    await assert.rejects(
      service.verify({
        razorpay_order_id: "order_test_qa",
        razorpay_payment_id: "pay_test_qa",
        razorpay_signature: "0".repeat(64),
      }),
    );
    assert.equal(state.payment.status, "PENDING");
    console.log("PASS invalid payment signature cannot mark an order paid");

    const verifyInput = {
      razorpay_order_id: "order_test_qa",
      razorpay_payment_id: "pay_test_qa",
    };
    const verified = await service.verify({
      ...verifyInput,
      razorpay_signature: hmac(
        "order_test_qa|pay_test_qa",
        process.env.RAZORPAY_KEY_SECRET,
      ),
    });
    assert.deepEqual(verified, { verified: true });
    assert.equal(state.payment.status, "PAID");
    assert.equal(state.payment.providerPaymentId, "pay_test_qa");
    console.log("PASS signature and captured-payment verification");

    const webhookBody = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_test_qa", order_id: "order_test_qa" },
        },
      },
    });
    const webhook = await service.webhook({
      rawBody: Buffer.from(webhookBody),
      headers: { "x-razorpay-signature": hmac(webhookBody, process.env.RAZORPAY_WEBHOOK_SECRET) },
      body: JSON.parse(webhookBody),
    });
    assert.deepEqual(webhook, { received: true });
    assert.equal(state.ordersCreated, 1);
    assert.equal(state.reserves, 1);
    assert.equal(remotePaymentFetches, 2);
    await assert.rejects(
      service.webhook({
        rawBody: Buffer.from(webhookBody),
        headers: { "x-razorpay-signature": "0".repeat(64) },
        body: JSON.parse(webhookBody),
      }),
    );
    console.log("PASS signed webhook validates captured payment idempotently");
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
