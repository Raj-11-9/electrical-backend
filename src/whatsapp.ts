import { Controller, Get, Post, Req, Inject, Injectable, UnauthorizedException, ServiceUnavailableException, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PrismaService } from "./prisma.service";

export function validWhatsAppSignature(raw: Buffer, header: string, secret: string) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(header)) return false;
  return timingSafeEqual(Buffer.from(header.slice(7), "hex"), createHmac("sha256", secret).update(raw).digest());
}
export function confirmationNumber(message: any) {
  const payload = message?.type === "button" ? message.button?.payload : message?.type === "interactive" ? message.interactive?.button_reply?.id : undefined;
  return typeof payload === "string" && /^confirm:SRV-[A-Z0-9-]+$/.test(payload) ? payload.slice(8) : null;
}
@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  onModuleInit() { this.timer = setInterval(() => void this.flush(), 10000); this.timer.unref(); }
  onModuleDestroy() { clearInterval(this.timer); }
  private configured() { return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_OWNER_NUMBER && process.env.WHATSAPP_ORDER_TEMPLATE && process.env.WHATSAPP_API_VERSION); }
  async flush() {
    if (this.running || !this.configured()) return;
    this.running = true;
    try {
      // Reclaim work after process failure. Provider delivery can be at least once.
      await this.db.notification.updateMany({ where: { channel: "WHATSAPP", status: "PROCESSING", lockedAt: { lt: new Date(Date.now() - 120000) } }, data: { status: "PENDING", lockedAt: null } });
      const jobs = await this.db.notification.findMany({ where: { channel: "WHATSAPP", status: "PENDING", nextAttemptAt: { lte: new Date() } }, take: 10, orderBy: { createdAt: "asc" } });
      for (const job of jobs) {
        const claim = await this.db.notification.updateMany({ where: { id: job.id, status: "PENDING" }, data: { status: "PROCESSING", lockedAt: new Date(), attempts: { increment: 1 } } });
        if (!claim.count) continue;
        try {
          const response = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
            method: "POST", headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(job.payload), signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw Error("WhatsApp provider rejected notification (" + response.status + ")");
          const result = await response.json() as any;
          if (!result.messages?.[0]?.id) throw Error("WhatsApp did not return a message identifier");
          await this.db.notification.update({ where: { id: job.id }, data: { status: "SENT", lockedAt: null, providerMessageId: result.messages[0].id, lastError: null } });
        } catch (error) {
          await this.db.notification.update({ where: { id: job.id }, data: { status: "PENDING", lockedAt: null, lastError: (error as Error).message.slice(0, 300), nextAttemptAt: new Date(Date.now() + Math.min(3600000, 10000 * 2 ** Math.min(job.attempts, 9))) } });
        }
      }
    } catch { console.error("WhatsApp queue unavailable; retrying on next interval."); }
    finally { this.running = false; }
  }
  async receive(req: any) {
    if (!req.rawBody || !validWhatsAppSignature(req.rawBody, req.headers["x-hub-signature-256"] || "", process.env.WHATSAPP_APP_SECRET || "")) throw new UnauthorizedException("Invalid WhatsApp signature");
    for (const entry of req.body?.entry || []) for (const change of entry.changes || []) {
      const value = change.value;
      if (value?.metadata?.phone_number_id !== process.env.WHATSAPP_PHONE_NUMBER_ID) continue;
      for (const message of value.messages || []) {
        if (!process.env.WHATSAPP_OWNER_NUMBER || message.from !== process.env.WHATSAPP_OWNER_NUMBER) continue;
        const number = confirmationNumber(message);
        if (!number || !message.context?.id) continue;
        const notification = await this.db.notification.findFirst({ where: { channel: "WHATSAPP", recipient: message.from, providerMessageId: message.context.id, order: { number } } });
        if (!notification) continue;
        // Repeated webhook deliveries cannot move a later stage backwards or mark payments paid.
        await this.db.order.updateMany({ where: { id: notification.orderId, status: "PENDING" }, data: { status: "CONFIRMED" } });
      }
    }
    return { received: true };
  }
}
export async function queueWhatsAppOrder(tx: any, order: any) {
  const recipient = process.env.WHATSAPP_OWNER_NUMBER;
  const template = process.env.WHATSAPP_ORDER_TEMPLATE;
  if (!recipient || !template) return;
  const contact = order.customerSnapshot as any, address = order.deliveryAddress as any;
  const details = [contact.name, contact.phone, address.line1, address.line2, address.city, address.state, address.pinCode, ...order.items.map((i: any) => `${i.name} x ${i.quantity}`)].filter(Boolean).join(", ").replace(/\s+/g, " ").slice(0, 800);
  await tx.notification.upsert({ where: { dedupeKey: "whatsapp-order:" + order.id }, update: {}, create: {
    orderId: order.id, channel: "WHATSAPP", recipient, template, dedupeKey: "whatsapp-order:" + order.id,
    payload: { messaging_product: "whatsapp", to: recipient, type: "template", template: { name: template, language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en" }, components: [
      { type: "body", parameters: [order.number, details, `INR ${Number(order.total).toFixed(2)}`].map(text => ({ type: "text", text })) },
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "confirm:" + order.number }] },
    ] } },
  } });
}
@Controller("commerce/whatsapp")
export class WhatsAppController {
  constructor(@Inject(WhatsAppService) private readonly service: WhatsAppService) {}
  @Get("webhook") verify(@Req() req: any) {
    const secret = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!secret) throw new ServiceUnavailableException("WhatsApp not configured");
    if (req.query["hub.mode"] !== "subscribe" || req.query["hub.verify_token"] !== secret) throw new UnauthorizedException();
    return String(req.query["hub.challenge"] || "");
  }
  @Post("webhook") receive(@Req() req: any) { return this.service.receive(req); }
}
