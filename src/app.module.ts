import { WhatsAppController, WhatsAppService } from "./whatsapp";
import { CommerceController, CommerceService } from "./commerce";
import {
  Module,
  Controller,
  Get,
  ServiceUnavailableException,
  Inject,
  Header,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PrismaService } from "./prisma.service";
import { CatalogueService } from "./catalogue.service";
import { AdminController, AdminService } from "./admin";
@Controller()
class PublicController {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(CatalogueService) private readonly catalogue: CatalogueService,
  ) {}
  @Get("health") async health() {
    if (!(await this.db.checkConnection()))
      throw new ServiceUnavailableException({
        status: "degraded",
        database: "unavailable",
        catalogue: this.db.previewEnabled ? "snapshot" : "unavailable",
      });
    return { status: "ok", database: "connected" };
  }
  @Get("status") async status() {
    const connected = await this.db.checkConnection();
    return {
      status: connected ? "ok" : "degraded",
      database: connected ? "connected" : "unavailable",
      catalogue: connected
        ? "postgresql"
        : this.db.previewEnabled
          ? "snapshot"
          : "unavailable",
      readOnly: !connected,
      catalogueReadOnly: !connected,
    };
  }
  @Get("catalogue")
  @Header("Cache-Control", "public, max-age=15")
  catalogueData() {
    return this.catalogue.read();
  }
  @Get("categories") async categories() {
    const data = await this.catalogue.read();
    return data.collections;
  }
  @Get("home") async home() {
    const data = await this.catalogue.read();
    return { ...data, products: data.products.slice(0, 12) };
  }
}
@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }])],
  controllers: [PublicController, CommerceController, AdminController, WhatsAppController],
  providers: [
    PrismaService,
    CatalogueService,
    CommerceService,
    WhatsAppService,
    AdminService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
