import { queueWhatsAppOrder } from "./whatsapp";
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Post,
  Body,
  Req,
  Inject,
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
  NotFoundException,
  Header,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtService } from "@nestjs/jwt";
import { Prisma, PrismaClient } from "@prisma/client";
import { hash, compare } from "bcryptjs";
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { PrismaService } from "./prisma.service";
const fail = (message: string): never => {
  throw new BadRequestException(message);
};
function indianPhone(value: unknown): string {
  const phone = typeof value === "string" ? value.trim() : "";
  if (/^[0-9]{10}$/.test(phone)) return "+91" + phone;
  if (/^\+91[0-9]{10}$/.test(phone)) return phone;
  return fail("Enter exactly 10 digits for your India (+91) mobile number.");
}
function text(
  value: unknown,
  name: string,
  max = 200,
  required = true,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (required && !value.trim())
  )
    return fail("Invalid " + name);
  return value.trim();
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("Invalid request");
  return value as Record<string, any>;
}
function money(value: Prisma.Decimal | string | number) {
  const n = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(n) || n < 0) return fail("Invalid price");
  return n;
}
function signature(value: string, secret: string, provided: string) {
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  return timingSafeEqual(
    Buffer.from(
      createHmac("sha256", secret).update(value).digest("hex"),
      "hex",
    ),
    Buffer.from(provided, "hex"),
  );
}
function email(value: unknown) {
  const result = text(value, "email", 150).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    return fail("Enter a valid email");
  return result;
}
function lines(value: unknown): { variantId: string; quantity: number }[] {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    return fail("Choose 1â€“100 product variants");
  const merged = new Map<string, number>();
  for (const row of value) {
    const item = object(row),
      id = text(item.variantId, "variant", 100);
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 10000
    )
      return fail("Quantity must be 1â€“10,000");
    merged.set(id, (merged.get(id) || 0) + item.quantity);
  }
  return [...merged].map(([variantId, quantity]) => {
    if (quantity > 10000) return fail("Quantity exceeds limit");
    return { variantId, quantity };
  });
}
@Injectable()
export class CommerceService {
  private readonly jwt = new JwtService();
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
  secret() {
    const s = process.env.JWT_SECRET || "";
    if (s.length < 32 || /replace|change_me/i.test(s))
      throw new ServiceUnavailableException(
        "Configure a strong JWT_SECRET before enabling accounts or checkout",
      );
    return s;
  }
  async ready() {
    if (!(await this.db.checkConnection()))
      throw new ServiceUnavailableException(
        "PostgreSQL is not connected. Your cart is safe; ordering is temporarily unavailable.",
      );
  }
  config() {
    return {
      cod: process.env.ENABLE_COD === "true",
      razorpay:
        !!process.env.RAZORPAY_KEY_ID &&
        !!process.env.RAZORPAY_KEY_SECRET &&
        !!process.env.RAZORPAY_WEBHOOK_SECRET,
      shipping: process.env.CHECKOUT_SHIPPING_PAISE,
      taxMode: process.env.CHECKOUT_TAX_MODE,
    };
  }
  async user(req: any, required = false): Promise<string | undefined> {
    const auth = req.headers?.authorization;
    if (!auth) {
      if (required) throw new UnauthorizedException("Sign in to continue");
      return;
    }
    try {
      const data = await this.jwt.verifyAsync(auth.replace(/^Bearer /, ""), {
        secret: this.secret(),
        algorithms: ["HS256"],
        issuer: "srv",
        audience: "customer",
      });
      if (data.purpose !== "session" || typeof data.sub !== "string")
        throw Error();
      return data.sub;
    } catch {
      throw new UnauthorizedException(
        "Your session has expired. Sign in again.",
      );
    }
  }
  async auth(input: unknown, register: boolean) {
    await this.ready();
    const data = object(input),
      address = email(data.email),
      password =
        typeof data.password === "string"
          ? data.password
          : fail("Invalid password");
    if (Buffer.byteLength(password) > 72 || password.length < 8)
      return fail("Use at least 8 characters and no more than 72 bytes");
    this.secret();
    let user;
    if (register) {
      const name = text(data.name, "name", 100),
        phone = indianPhone(data.phone);

      const passwordHash = await hash(password, 12);
      try {
        user = await this.db.user.create({
          data: {
            email: address,
            passwordHash,
            role: "CUSTOMER",
            customer: { create: { email: address, name, phone } },
          },
        });
      } catch (e) {
        if ((e as any).code === "P2002")
          throw new ConflictException(
            "Unable to create account with these details",
          );
        throw e;
      }
    } else {
      user = await this.db.user.findUnique({ where: { email: address } });
      const valid = await compare(
        password,
        user?.passwordHash ||
          "$2b$12$C6UzMDM.H6dfI/f/IKcEe.3j8TChT1hRFh7YQ2vK3A4N8aA9bB5tW",
      );
      if (!user || !valid || user.role !== "CUSTOMER")
        throw new UnauthorizedException("Email or password is incorrect");
    }
    return {
      token: await this.jwt.signAsync(
        { sub: user.id, purpose: "session" },
        {
          secret: this.secret(),
          algorithm: "HS256",
          issuer: "srv",
          audience: "customer",
          expiresIn: "1h",
        },
      ),
      email: user.email,
    };
  }
  async me(req: any) {
    await this.ready();
    const id = await this.user(req, true);
    const user = await this.db.user.findUnique({
      where: { id },
      select: {
        email: true,
        addresses: true,
        customer: { select: { name: true, phone: true } },
      },
    });
    if (!user) throw new UnauthorizedException();
    const orders = await this.db.order.findMany({
      where: { userId: id },
      orderBy: { createdAt: "desc" },
      include: { payments: true, shipments: true, items: true },
    });
    return { ...user, orders: orders.map((o) => this.summary(o)) };
  }
  async saveAddress(input: unknown, req: any) {
    await this.ready();
    const userId = await this.user(req, true);
    if (!userId) throw new UnauthorizedException();
    const d = object(input);
    const data = {
      fullName: text(d.fullName, "name", 100), phone: indianPhone(d.phone),
      line1: text(d.line1, "street address", 250), line2: text(d.line2 || "", "address line 2", 250, false),
      city: text(d.city, "city", 100), state: text(d.state, "state", 100), pinCode: text(d.pinCode, "PIN", 6), country: "IN",
    };
    if (!/^\d{6}$/.test(data.pinCode)) return fail("PIN code must have six digits");
    if (d.id) {
      const updated = await this.db.address.updateMany({ where: { id: text(d.id, "address id", 100), userId }, data });
      if (!updated.count) throw new NotFoundException("Address not found");
      return this.db.address.findFirst({ where: { id: d.id, userId } });
    }
    const existing = await this.db.address.findFirst({ where: { userId, ...data } });
    return existing || this.db.address.create({ data: { ...data, userId } });
  }
  async quote(
    input: unknown,
    tx: Prisma.TransactionClient | PrismaClient = this.db,
  ) {
    const selected = lines(object(input).items),
      config = this.config();
    if (
      config.shipping === undefined ||
      !/^\d+$/.test(config.shipping) ||
      !["INCLUSIVE", "EXCLUSIVE"].includes(config.taxMode || "")
    )
      throw new ServiceUnavailableException(
        "Shipping and product tax treatment must be configured before checkout",
      );
    const variants = await tx.productVariant.findMany({
      where: { OR: selected.map((i) => ({ sourceId: i.variantId })) },
      include: { product: true, inventory: true },
    });
    const result = selected.map((item) => {
      const v = variants.find((v) => v.sourceId === item.variantId);
      if (!v || !v.product.published || v.product.archived)
        return fail("A selected product is no longer available");
      if (v.product.gstRate === null || !v.inventory)
        throw new ConflictException(
          v.product.name +
            ": confirmed stock and GST must be configured before online ordering",
        );
      if (item.quantity < (v.product.minimumOrderQuantity || 1))
        return fail(
          v.product.name +
            ": minimum quantity is " +
            v.product.minimumOrderQuantity,
        );
      if (v.inventory.quantity - v.inventory.reserved < item.quantity)
        throw new ConflictException(
          v.product.name + ": insufficient confirmed stock",
        );
      const listed = money(v.sellingPrice) * item.quantity,
        rate = Number(v.product.gstRate);
      if (rate < 0 || rate > 100) return fail("Invalid GST configuration");
      const gst =
          config.taxMode === "INCLUSIVE"
            ? Math.round((listed * rate) / (100 + rate))
            : Math.round((listed * rate) / 100),
        subtotal = config.taxMode === "INCLUSIVE" ? listed - gst : listed;
      return {
        variantId: v.id,
        sourceId: v.sourceId,
        name: v.product.name,
        variant: v.name,
        sku: v.sourceSku || v.sku,
        quantity: item.quantity,
        unitPrice: money(v.sellingPrice),
        gstRate: rate,
        gst,
        subtotal,
        total: subtotal + gst,
      };
    });
    const subtotal = result.reduce((a, i) => a + i.subtotal, 0),
      gst = result.reduce((a, i) => a + i.gst, 0),
      shipping = Number(config.shipping),
      total = subtotal + gst + shipping;
    if (!Number.isSafeInteger(total) || total < 1 || total > 100000000)
      return fail("Order total is outside supported limits");
    return {
      items: result,
      subtotal,
      gst,
      shipping,
      total,
      currency: "INR",
      methods: [
        ...(config.cod ? ["COD"] : []),
        ...(config.razorpay ? ["RAZORPAY"] : []),
      ],
    };
  }
  trackToken(id: string) {
    return this.jwt.sign(
      { sub: id, purpose: "tracking" },
      {
        secret: this.secret(),
        algorithm: "HS256",
        issuer: "srv",
        audience: "tracking",
        expiresIn: "90d",
      },
    );
  }
  summary(o: any) {
    return {
      number: o.number,
      status: o.status,
      total: o.total,
      subtotal: o.subtotal,
      gst: o.gst,
      shipping: o.shipping,
      discount: o.discount,
      deliveryAddress: o.deliveryAddress,
      customer: o.customerSnapshot,
      updatedAt: o.updatedAt,
      currency: o.currency,
      createdAt: o.createdAt,
      items: o.items.map((i: any) => ({
        name: i.name,
        sku: i.sku,
        quantity: i.quantity,
        total: i.total,
        variant: i.variantSnapshot,
      })),
      payments: o.payments.map((p: any) => ({
        method: p.method,
        status: p.status,
      })),
      shipments: o.shipments.map((s: any) => ({
        carrier: s.carrier,
        trackingNumber: s.trackingNumber,
        shippedAt: s.shippedAt,
        deliveredAt: s.deliveredAt,
      })),
      trackingToken: this.trackToken(o.id),
    };
  }
  async create(input: unknown, req: any) {
    await this.ready();
    this.secret();
    const d = object(input),
      userId = await this.user(req),
      key = text(d.idempotencyKey, "request identifier", 100);
    if (!/^[a-f0-9-]{36}$/i.test(key))
      return fail("Invalid checkout request identifier");
    const customer = object(d.customer),
      address = object(d.address);
    const contact = {
      name: text(customer.name, "name", 100),
      email: email(customer.email),
      phone: indianPhone(customer.phone),
    };

    const delivery = {
      line1: text(address.line1, "street address", 250),
      line2: text(address.line2 || "", "address line 2", 250, false),
      city: text(address.city, "city", 100),
      state: text(address.state, "state", 100),
      pinCode: text(address.pinCode, "PIN", 6),
      country: "IN",
    };
    if (!/^\d{6}$/.test(delivery.pinCode))
      return fail("PIN code must have six digits");
    const method = text(d.method, "payment method", 20);
    if (!["COD", "RAZORPAY"].includes(method))
      return fail("Invalid payment method");
    let order;
    try {
      order = await this.db.$transaction(
        async (tx) => {
          const previous = await tx.order.findUnique({
            where: { idempotencyKey: key },
            include: { items: true, payments: true, shipments: true },
          });
          if (previous) {
            if (
              previous.userId !== (userId || null) ||
              (previous.customerSnapshot as any).email !== contact.email ||
              !previous.payments[0].method.startsWith(method)
            )
              throw new ConflictException(
                "Checkout request does not match the saved order",
              );
            return previous;
          }
          const quote = await this.quote(d, tx);
          if (!quote.methods.includes(method))
            throw new ServiceUnavailableException(
              "This payment method is not configured",
            );
          for (const item of quote.items) {
            const updated = await tx.$queryRaw<
              { id: string }[]
            >`UPDATE "Inventory" SET reserved=reserved+${item.quantity},version=version+1,"updatedAt"=NOW() WHERE "variantId"=${item.variantId} AND quantity-reserved>=${item.quantity} RETURNING id`;
            if (!updated.length)
              throw new ConflictException(
                "Stock changed. Please review your cart.",
              );
          }
          const account = userId
            ? await tx.customer.findUnique({ where: { userId } })
            : null;
          const buyer =
            account || (await tx.customer.create({ data: contact }));
          const created = await tx.order.create({
            data: {
              number:
                "SRV-" +
                Date.now().toString(36).toUpperCase() +
                "-" +
                randomBytes(4).toString("hex").toUpperCase(),
              idempotencyKey: key,
              userId,
              customerId: buyer.id,
              customerSnapshot: contact,
              deliveryAddress: delivery,
              companyName: text(d.companyName || "", "company", 150, false),
              gstin: text(d.gstin || "", "GSTIN", 15, false),
              notes: text(d.notes || "", "notes", 2000, false),
              subtotal: quote.subtotal / 100,
              gst: quote.gst / 100,
              shipping: quote.shipping / 100,
              discount: 0,
              total: quote.total / 100,
              items: {
                create: quote.items.map((i) => ({
                  variantId: i.variantId,
                  name: i.name,
                  sku: i.sku,
                  variantSnapshot: { name: i.variant },
                  quantity: i.quantity,
                  unitPrice: i.unitPrice / 100,
                  gstRate: i.gstRate,
                  gstAmount: i.gst / 100,
                  total: i.total / 100,
                })),
              },
              payments: { create: { method, amount: quote.total / 100 } },
            },
            include: { items: true, payments: true, shipments: true },
          });
          await queueWhatsAppOrder(tx, created);
          return created;
        },
        { isolationLevel: "Serializable" },
      );
    } catch (e) {
      if (["P2002", "P2034"].includes((e as any).code))
        throw new ConflictException(
          "Order submission is already processing or stock changed. Retry with the same request.",
        );
      throw e;
    }
    const result: any = { order: this.summary(order) };
    if (method === "RAZORPAY") {
      const payment = order.payments[0];
      if (payment.method === "COD")
        return fail("This request identifier belongs to another checkout");
      if (payment.status === "PAID") return result;
      let providerOrderId = payment.providerOrderId;
      if (!providerOrderId) {
        const claimed = await this.db.payment.updateMany({
          where: {
            id: payment.id,
            method: "RAZORPAY",
            providerOrderId: null,
            status: "PENDING",
          },
          data: { method: "RAZORPAY_CREATING" },
        });
        if (!claimed.count)
          throw new ConflictException(
            "Payment setup is processing. Your order is saved; retry shortly.",
          );
        try {
          const remote = await this.provider("orders", {
            amount: money(order.total),
            currency: "INR",
            receipt: order.number,
          });
          providerOrderId = remote.id;
          await this.db.payment.update({
            where: { id: payment.id },
            data: { providerOrderId, method: "RAZORPAY" },
          });
        } catch {
          await this.db.payment.update({
            where: { id: payment.id },
            data: { method: "RAZORPAY" },
          });
          throw new ServiceUnavailableException(
            "Order saved; payment setup could not complete. Retry with the same checkout.",
          );
        }
      }
      result.razorpay = {
        key: process.env.RAZORPAY_KEY_ID,
        order_id: providerOrderId,
        amount: money(order.total),
        currency: "INR",
      };
    }
    return result;
  }
  async provider(path: string, data?: unknown) {
    const response = await fetch("https://api.razorpay.com/v1/" + path, {
      method: data ? "POST" : "GET",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            process.env.RAZORPAY_KEY_ID + ":" + process.env.RAZORPAY_KEY_SECRET,
          ).toString("base64"),
        "Content-Type": "application/json",
      },
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new ServiceUnavailableException("Payment provider unavailable");
    return response.json() as Promise<any>;
  }
  async captured(paymentId: string, providerOrderId: string) {
    const payment = await this.db.payment.findUnique({
      where: { providerOrderId },
      include: { order: true },
    });
    if (!payment) throw new NotFoundException("Payment not found");
    const remote = await this.provider(
      "payments/" + encodeURIComponent(paymentId),
    );
    if (
      remote.order_id !== providerOrderId ||
      remote.currency !== "INR" ||
      remote.amount !== money(payment.amount) ||
      remote.status !== "captured"
    )
      throw new ConflictException(
        "Payment is not captured yet. Check tracking again shortly.",
      );
    await this.db.payment.update({
      where: { id: payment.id },
      data: {
        providerPaymentId: paymentId,
        status: "PAID",
        verifiedAt: new Date(),
      },
    });
    return { verified: true };
  }
  async verify(input: unknown) {
    await this.ready();
    const d = object(input),
      orderId = text(d.razorpay_order_id, "payment order", 100),
      paymentId = text(d.razorpay_payment_id, "payment reference", 100),
      sig = text(d.razorpay_signature, "signature", 128);
    if (
      !process.env.RAZORPAY_KEY_SECRET ||
      !signature(
        orderId + "|" + paymentId,
        process.env.RAZORPAY_KEY_SECRET,
        sig,
      )
    )
      throw new UnauthorizedException("Invalid payment signature");
    return this.captured(paymentId, orderId);
  }
  async webhook(req: any) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (
      !secret ||
      !req.rawBody ||
      !signature(
        req.rawBody.toString("utf8"),
        secret,
        req.headers["x-razorpay-signature"] || "",
      )
    )
      throw new UnauthorizedException("Invalid webhook signature");
    const body = object(req.body);
    if (body.event !== "payment.captured") return { ignored: true };
    const p = body.payload?.payment?.entity;
    if (!p?.id || !p?.order_id) return fail("Invalid payment event");
    await this.captured(p.id, p.order_id);
    return { received: true };
  }
  async track(input: unknown) {
    await this.ready();
    const d = object(input);
    let token;
    try {
      token = await this.jwt.verifyAsync(text(d.token, "tracking code", 2000), {
        secret: this.secret(),
        algorithms: ["HS256"],
        issuer: "srv",
        audience: "tracking",
      });
    } catch {
      throw new NotFoundException(
        "Order not found. Check your order number and tracking code.",
      );
    }
    if (token.purpose !== "tracking") throw new NotFoundException();
    const o = await this.db.order.findFirst({
      where: { id: token.sub, number: text(d.number, "order number", 100) },
      include: { items: true, payments: true, shipments: true },
    });
    if (!o) throw new NotFoundException("Order not found");
    return this.summary(o);
  }
}
@Controller("commerce")
export class CommerceController {
  constructor(
    @Inject(CommerceService) private readonly service: CommerceService,
  ) {}
  @Post("register") @Throttle({ default: { limit: 5, ttl: 60000 } }) register(
    @Body() d: unknown,
  ) {
    return this.service.auth(d, true);
  }
  @Post("login") @Throttle({ default: { limit: 10, ttl: 60000 } }) login(
    @Body() d: unknown,
  ) {
    return this.service.auth(d, false);
  }
  @Get("me") me(@Req() r: any) {
    return this.service.me(r);
  }
  @Post("addresses") address(@Body() d: unknown, @Req() r: any) { return this.service.saveAddress(d, r); }
  @Post("quote") async quote(@Body() d: unknown) {
    await this.service.ready();
    return this.service.quote(d);
  }
  @Post("orders") @Throttle({ default: { limit: 10, ttl: 60000 } }) order(
    @Body() d: unknown,
    @Req() r: any,
  ) {
    return this.service.create(d, r);
  }
  @Post("track") @Throttle({ default: { limit: 15, ttl: 60000 } }) track(
    @Body() d: unknown,
  ) {
    return this.service.track(d);
  }
  @Post("payments/verify") verify(@Body() d: unknown) {
    return this.service.verify(d);
  }
  @Post("payments/webhook") webhook(@Req() r: any) {
    return this.service.webhook(r);
  }
}
