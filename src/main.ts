import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app.module";
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks(["SIGINT", "SIGTERM"]);
  app.use(helmet());
  app.use((req: any, res: any, next: () => void) => {
    if (req.url.startsWith("/api/commerce"))
      res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.setGlobalPrefix("api");
  app.enableCors({
    origin: (
      process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:3001"
    ).split(","),
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(
    Number(process.env.PORT || 4000),
    process.env.HOST || "127.0.0.1",
  );
}
bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
