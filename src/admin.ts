import { hash, compare } from "bcryptjs";
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  NotFoundException,
  Inject,
  Injectable,
  Post,
  Body,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtService } from "@nestjs/jwt";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { PrismaService } from "./prisma.service";

type Input = Record<string, unknown>;

function object(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Invalid request");
  return value as Input;
}

function onlyKeys(input: Input, allowed: string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new BadRequestException("Unexpected request field");
}

function requiredText(value: unknown, label: string, maxLength: number) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maxLength
  )
    throw new BadRequestException(`Enter a valid ${label}`);
  return value.trim();
}

function slugFor(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `item-${randomUUID().slice(0, 8)}`
  );
}

function sameSecret(left: string, right: string) {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}

@Injectable()
export class AdminService {
  private readonly jwt = new JwtService();

  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  private credentials() {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    const secret = process.env.JWT_SECRET || "";
    if (
      !email ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.endsWith("@example.com") ||
      !password ||
      password.length < 12 ||
      password.length > 200 ||
      /replace|change_me/i.test(password) ||
      secret.length < 32 ||
      /replace|change_me/i.test(secret)
    )
      throw new ServiceUnavailableException(
        "Configure ADMIN_EMAIL, a 12-character ADMIN_PASSWORD, and a strong JWT_SECRET in the backend environment.",
      );
    return { email, password, secret };
  }

  async login(value: unknown) {
    const input = object(value);
    onlyKeys(input, ["email", "password"]);
    const email =
      typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const password =
      typeof input.password === "string" && input.password.length <= 200
        ? input.password
        : "";
    const configured = this.credentials();
    let subject = configured.email;
    if (email === configured.email) {
      if (!sameSecret(password, configured.password))
        throw new UnauthorizedException("Admin ID or password is incorrect");
    } else {
      await this.requireDatabase();
      const user = await this.db.user.findUnique({ where: { email }, include: { admin: true } });
      if (!user || user.role !== "ADMIN" || !user.admin || !(await compare(password, user.passwordHash)))
        throw new UnauthorizedException("Admin ID or password is incorrect");
      subject = user.id;
    }

    return {
      token: await this.jwt.signAsync(
        { sub: subject, role: "ADMIN", purpose: "admin" },
        {
          secret: configured.secret,
          algorithm: "HS256",
          issuer: "srv",
          audience: "admin",
          expiresIn: "1h",
        },
      ),
    };
  }

  async authorize(request: { headers?: { authorization?: string } }) {
    const header = request.headers?.authorization || "";
    const match = /^Bearer ([^\s]+)$/.exec(header);
    if (!match) throw new UnauthorizedException("Sign in to manage store data");
    const configured = this.credentials();
    try {
      const payload = await this.jwt.verifyAsync(match[1], {
        secret: configured.secret,
        algorithms: ["HS256"],
        issuer: "srv",
        audience: "admin",
      });
      if (
        payload.purpose !== "admin" ||
        payload.role !== "ADMIN" ||
        typeof payload.sub !== "string"
      )
        throw new Error("Invalid administrator session");
      if (payload.sub !== configured.email) {
        await this.requireDatabase();
        const user = await this.db.user.findUnique({ where: { id: payload.sub }, include: { admin: true } });
        if (!user || user.role !== "ADMIN" || !user.admin) throw new Error("Invalid administrator session");
      }
    } catch {
      throw new UnauthorizedException(
        "Your administrator session expired. Sign in again.",
      );
    }
  }

  async createAccount(value: unknown) {
    await this.requireDatabase();
    const input = object(value);
    onlyKeys(input, ["email", "password"]);
    const email = requiredText(input.email, "admin ID", 150).toLowerCase();
    if (!/^[a-z0-9@._+\-]{3,150}$/.test(email))
      throw new BadRequestException("Use 3â€“150 letters, numbers, dots, underscores, +, @ or hyphens for the admin ID");
    const password = input.password;
    if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password, "utf8") > 72)
      throw new BadRequestException("Password must have at least 12 characters and at most 72 bytes");
    if (email === this.credentials().email)
      throw new ConflictException("This admin ID already exists");
    try {
      return await this.db.user.create({
        data: { email, passwordHash: await hash(password, 12), role: "ADMIN", admin: { create: {} } },
        select: { id: true, email: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ConflictException("This admin ID already exists");
      throw error;
    }
  }

  async createCategory(value: unknown) {
    await this.requireDatabase();
    const input = object(value);
    onlyKeys(input, ["name"]);
    const name = requiredText(input.name, "product group name", 100);
    try {
      return await this.db.category.create({
        data: { name, slug: slugFor(name) },
        select: { id: true, name: true, slug: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "A product group with that name already exists",
        );
      throw error;
    }
  }

  async createProduct(value: unknown) {
    await this.requireDatabase();
    const input = object(value);
    onlyKeys(input, [
      "name",
      "sku",
      "categoryId",
      "sellingPrice",
      "description",
      "imageUrl",
      "quantity",
    ]);
    const name = requiredText(input.name, "product name", 160);
    const sku = requiredText(input.sku, "SKU", 80);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(sku))
      throw new BadRequestException(
        "SKU may contain letters, numbers, dots, dashes, underscores and slashes",
      );
    const categoryId = requiredText(input.categoryId, "product group", 100);
    const priceValue =
      typeof input.sellingPrice === "string" ||
      typeof input.sellingPrice === "number"
        ? String(input.sellingPrice).trim()
        : "";
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(priceValue))
      throw new BadRequestException("Enter a valid price with up to 2 decimals");
    const price = new Prisma.Decimal(priceValue);
    if (price.lte(0))
      throw new BadRequestException("Price must be greater than zero");
    const description =
      input.description === undefined
        ? ""
        : typeof input.description === "string" &&
            input.description.trim().length <= 10000
          ? input.description.trim()
          : (() => {
              throw new BadRequestException("Enter a valid description");
            })();
    const quantity =
      input.quantity === undefined ? 0 : Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000)
      throw new BadRequestException("Stock must be a whole number from 0 to 1,000,000");

    let imageUrl: string | undefined;
    if (input.imageUrl !== undefined && input.imageUrl !== "") {
      imageUrl = requiredText(input.imageUrl, "image URL", 2000);
      try {
        const parsed = new URL(imageUrl);
        if (!["http:", "https:"].includes(parsed.protocol))
          throw new Error("Unsupported protocol");
      } catch {
        throw new BadRequestException("Enter a valid HTTP or HTTPS image URL");
      }
    }

    const category = await this.db.category.findUnique({
      where: { id: categoryId },
      select: { id: true, name: true, slug: true },
    });
    if (!category) throw new BadRequestException("Choose a valid product group");

    const slug = slugFor(name);
    try {
      return await this.db.product.create({
        data: {
          name,
          slug,
          sku,
          categoryId: category.id,
          description,
          sellingPrice: price,
          published: true,
          sourceCollectionSlugs: [category.slug],
          ...(imageUrl
            ? {
                images: {
                  create: [{ url: imageUrl, alt: name, sortOrder: 0 }],
                },
              }
            : {}),
          variants: {
            create: {
              sku: `${sku}-STD`,
              name: "Standard",
              attributes: {},
              sellingPrice: price,
              inventory: { create: { quantity } },
            },
          },
        },
        select: { id: true, name: true, slug: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "That product name or SKU is already in use",
        );
      throw error;
    }
  }

  async products() {
    await this.requireDatabase();
    const products = await this.db.product.findMany({
      where: { archived: false }, orderBy: { createdAt: "desc" },
      include: { category: true, images: { orderBy: { sortOrder: "asc" } }, variants: { include: { inventory: true } } },
    });
    return products.map(p => ({
      id: p.id, name: p.name, slug: p.slug, sku: p.sku, published: p.published,
      description: p.description, categoryId: p.categoryId,
      sellingPrice: p.sellingPrice.toString(), category: { name: p.category.name, slug: p.category.slug },
      collectionSlugs: p.sourceCollectionSlugs, createdAt: p.createdAt.toISOString(),
      images: p.images.map(i => ({ url: i.url, alt: i.alt })),
      variants: p.variants.map(v => ({ id: v.id, sku: v.sku, name: v.name, price: v.sellingPrice.toString(), available: v.inventory ? v.inventory.quantity > v.inventory.reserved : v.sourceAvailable === true })),
    }));
  }

  async updateProduct(id: string, value: unknown) {
    await this.requireDatabase();
    const input = object(value);
    onlyKeys(input, ["name", "sku", "sellingPrice", "description", "published"]);
    const data: Prisma.ProductUpdateManyMutationInput = {};
    if (input.name !== undefined) data.name = requiredText(input.name, "product name", 160);
    if (input.sku !== undefined) {
      const sku = requiredText(input.sku, "SKU", 80);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(sku)) throw new BadRequestException("Enter a valid SKU");
      data.sku = sku;
    }
    if (input.sellingPrice !== undefined) {
      const price = String(input.sellingPrice);
      if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0) throw new BadRequestException("Enter a price greater than zero with at most 2 decimals");
      data.sellingPrice = new Prisma.Decimal(price);
    }
    if (input.description !== undefined) {
      if (typeof input.description !== "string" || input.description.length > 10000) throw new BadRequestException("Enter a valid description");
      data.description = input.description;
    }
    if (input.published !== undefined) {
      if (typeof input.published !== "boolean") throw new BadRequestException("Choose active or inactive");
      data.published = input.published;
    }
    if (!Object.keys(data).length) throw new BadRequestException("No changes supplied");
    try {
      const result = await this.db.product.updateMany({ where: { id, archived: false }, data });
      if (!result.count) throw new NotFoundException("Product not found");
      return { saved: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException("That SKU is already in use");
      throw error;
    }
  }

  async deleteProduct(id: string) {
    await this.requireDatabase();
    const result = await this.db.product.updateMany({ where: { id, archived: false }, data: { archived: true, published: false } });
    if (!result.count) throw new NotFoundException("Product not found");
    return { deleted: true };
  }

  async inventory() {
    await this.requireDatabase();
    return this.db.productVariant.findMany({
      where: { product: { archived: false } },
      orderBy: [{ product: { name: "asc" } }, { sku: "asc" }],
      select: {
        id: true, sku: true, name: true, attributes: true, sellingPrice: true,
        inventory: { select: { quantity: true, reserved: true, version: true } },
        product: { select: { id: true, name: true, sku: true, description: true, published: true, gstRate: true, category: { select: { name: true, slug: true } }, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true, alt: true } } } },
      },
    });
  }
  async saveInventory(value: unknown) {
    await this.requireDatabase();
    const input = object(value);
    onlyKeys(input, ["variantId", "quantity", "gstRate", "expectedVersion", "sellingPrice"]);
    const variantId = requiredText(input.variantId, "variant", 100);
    const quantity = Number(input.quantity), rateText = String(input.gstRate ?? "");
    const gstRate = Number(rateText);
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000) throw new BadRequestException("Enter confirmed stock from 0 to 1000000.");
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(rateText) || !Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100) throw new BadRequestException("Enter a confirmed GST rate between 0 and 100.");
    const expectedVersion = input.expectedVersion;
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0)) throw new BadRequestException("Refresh inventory before saving");
    let sellingPrice: Prisma.Decimal | undefined;
    if (input.sellingPrice !== undefined) {
      const price = String(input.sellingPrice);
      if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0) throw new BadRequestException("Enter a positive variant price with at most 2 decimals");
      sellingPrice = new Prisma.Decimal(price);
    }
    await this.db.$transaction(async tx => {
      const variant = await tx.productVariant.findUnique({ where: { id: variantId }, select: { productId: true, product: { select: { archived: true } }, inventory: { select: { reserved: true, version: true } } } });
      if (!variant || variant.product.archived) throw new BadRequestException("Product variant not found.");
      if ((variant.inventory?.version ?? null) !== expectedVersion) throw new ConflictException("Stock changed since you opened this form. Refresh inventory and try again.");
      if (variant.inventory) {
        const result = await tx.inventory.updateMany({ where: { variantId, version: Number(expectedVersion), reserved: { lte: quantity } }, data: { quantity, version: { increment: 1 } } });
        if (!result.count) throw new ConflictException("Confirmed stock cannot be below reserved order quantities. Refresh and retry.");
      } else await tx.inventory.create({ data: { variantId, quantity } });
      if (sellingPrice !== undefined) await tx.productVariant.update({ where: { id: variantId }, data: { sellingPrice } });
      await tx.product.update({ where: { id: variant.productId }, data: { gstRate } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { saved: true };
  }

  async updateOrder(id: string, value: unknown) {
    await this.requireDatabase();
    const input = object(value);
    onlyKeys(input, ["action", "carrier", "trackingNumber", "trackingUrl", "status"]);
    if (input.action !== "confirm" && input.action !== "tracking") throw new BadRequestException("Choose a valid order action");
    return this.db.$transaction(async tx => {
      const order = await tx.order.findUnique({ where: { id }, include: { payments: true, shipments: true, items: true } });
      if (!order) throw new NotFoundException("Order not found");
      if (input.action === "confirm") {
        if (order.status === "CONFIRMED") return { saved: true };
        if (order.status !== "PENDING") throw new ConflictException("Only pending orders can be confirmed");
        const paid = order.payments.filter(p => p.status === "PAID").reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
        const cod = order.payments.some(p => p.method === "COD" && p.status === "PENDING" && p.amount.gte(order.total));
        if (!cod && paid.lt(order.total)) throw new ConflictException("Online payment must be verified before confirming this order");
        const result = await tx.order.updateMany({ where: { id, status: "PENDING" }, data: { status: "CONFIRMED" } });
        if (!result.count) throw new ConflictException("Order changed. Refresh and try again");
        return { saved: true };
      }
      if (order.status !== "CONFIRMED" && order.status !== "SHIPPED") throw new ConflictException("Confirm the order before adding tracking. Completed or cancelled orders cannot be changed");
      const carrier = requiredText(input.carrier, "courier name", 100);
      const trackingNumber = requiredText(input.trackingNumber, "tracking number", 150);
      const status = input.status;
      if (status !== "SHIPPED" && status !== "DELIVERED") throw new BadRequestException("Choose shipped or delivered");
      if (status === "DELIVERED" && order.status !== "SHIPPED") throw new ConflictException("Mark the order shipped before marking it delivered");
      const trackingUrl = typeof input.trackingUrl === "string" ? input.trackingUrl.trim() : "";
      if (input.trackingUrl !== undefined && typeof input.trackingUrl !== "string") throw new BadRequestException("Enter a valid tracking URL");
      if (trackingUrl) {
        try { const url = new URL(trackingUrl); if (url.protocol !== "https:" || url.username || url.password || trackingUrl.length > 2000) throw Error(); }
        catch { throw new BadRequestException("Enter an HTTPS courier tracking URL"); }
      }
      // Fulfil the order reservation once, when it first leaves the warehouse.
      if (order.status === "CONFIRMED" && status === "SHIPPED") {
        for (const item of order.items) {
          const stock = await tx.inventory.updateMany({
            where: { variantId: item.variantId, quantity: { gte: item.quantity }, reserved: { gte: item.quantity } },
            data: { quantity: { decrement: item.quantity }, reserved: { decrement: item.quantity }, version: { increment: 1 } },
          });
          if (!stock.count) throw new ConflictException("Reserved stock is missing for this order. Review inventory before shipping");
        }
      }
      const result = await tx.order.updateMany({ where: { id, status: order.status }, data: { status } });
      if (!result.count) throw new ConflictException("Order changed. Refresh and try again");
      const shipment = order.shipments[0];
      const data = { carrier, trackingNumber, trackingUrl: trackingUrl || null, shippedAt: shipment?.shippedAt || new Date(), deliveredAt: status === "DELIVERED" ? new Date() : null };
      if (shipment) await tx.shipment.update({ where: { id: shipment.id }, data });
      else await tx.shipment.create({ data: { ...data, orderId: id } });
      return { saved: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async listOrders() {
    await this.requireDatabase();
    return this.db.order.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
      select: {
        id: true, number: true, status: true, createdAt: true,
        customerSnapshot: true, deliveryAddress: true, total: true, currency: true,
        items: { select: { name: true, sku: true, quantity: true } },
        payments: { select: { method: true, status: true, amount: true } },
        shipments: { select: { carrier: true, trackingNumber: true, trackingUrl: true, shippedAt: true, deliveredAt: true } },
      },
    });
  }

  private async requireDatabase() {
    if (!(await this.db.checkConnection()))
      throw new ServiceUnavailableException(
        "The store database is unavailable. Your changes were not saved.",
      );
  }
}

@Controller("admin")
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly service: AdminService,
  ) {}

  @Post("login")
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  login(@Body() body: unknown) {
    return this.service.login(body);
  }

  @Get("session")
  async session(@Req() request: { headers?: { authorization?: string } }) {
    await this.service.authorize(request);
    return { authenticated: true };
  }

  @Post("accounts")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async createAccount(@Body() body: unknown, @Req() request: { headers?: { authorization?: string } }) {
    await this.service.authorize(request);
    return this.service.createAccount(body);
  }

  @Get("inventory")
  async inventory(@Req() request: { headers?: { authorization?: string } }) {
    await this.service.authorize(request);
    return this.service.inventory();
  }
  @Post("inventory")
  async saveInventory(@Body() body: unknown, @Req() request: { headers?: { authorization?: string } }) {
    await this.service.authorize(request);
    return this.service.saveInventory(body);
  }

  @Patch("orders/:id")
  async updateOrder(@Param("id") id: string, @Body() body: unknown, @Req() request: { headers?: { authorization?: string } }) {
    await this.service.authorize(request);
    return this.service.updateOrder(id, body);
  }

  @Get("orders")
  async orders(@Req() request: { headers?: { authorization?: string } }) {
    await this.service.authorize(request);
    return this.service.listOrders();
  }

  @Post("categories")
  async createCategory(
    @Body() body: unknown,
    @Req() request: { headers?: { authorization?: string } },
  ) {
    await this.service.authorize(request);
    return this.service.createCategory(body);
  }

  @Get("products")
  async products(@Req() request: { headers?: { authorization?: string } }) {
    await this.service.authorize(request);
    return this.service.products();
  }

  @Patch("products/:id")
  async updateProduct(@Param("id") id: string, @Body() body: unknown, @Req() request: { headers?: { authorization?: string } }) {
    await this.service.authorize(request);
    return this.service.updateProduct(id, body);
  }

  @Delete("products/:id")
  async deleteProduct(@Param("id") id: string, @Req() request: { headers?: { authorization?: string } }) {
    await this.service.authorize(request);
    return this.service.deleteProduct(id);
  }

  @Post("products")
  async createProduct(
    @Body() body: unknown,
    @Req() request: { headers?: { authorization?: string } },
  ) {
    await this.service.authorize(request);
    return this.service.createProduct(body);
  }
}
