import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  readonly previewEnabled = process.env.ALLOW_CATALOGUE_SNAPSHOT === 'true' && process.env.NODE_ENV !== 'production';
  private available = false;
  private lastCheck = 0;
  async onModuleInit() {
    if (this.previewEnabled) { this.lastCheck=Date.now(); return; }
    try { await this.$connect(); this.available = true; }
    catch { if (!this.previewEnabled) throw new Error('PostgreSQL is unavailable. Check DATABASE_URL and start the database.'); }
    this.lastCheck = Date.now();
  }
  async checkConnection(force = false): Promise<boolean> {
    if (this.previewEnabled) return false;
    if (!force && Date.now() - this.lastCheck < 10000) return this.available;
    this.lastCheck = Date.now();
    try { await this.$queryRaw`SELECT 1`; this.available = true; }
    catch { this.available = false; }
    return this.available;
  }
  invalidateConnection() { this.available=false; this.lastCheck=0; }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
