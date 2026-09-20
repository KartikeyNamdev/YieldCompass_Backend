import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { resolve } from "path";
import { createPool, runMigrations } from "@yc/shared/dist/db";
import { AppModule } from "./app.module";

async function bootstrap() {
  const migrator = createPool();
  await runMigrations(migrator, process.env.MIGRATIONS_DIR ?? resolve(__dirname, "../../../migrations"));
  await migrator.end();

  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(",") ?? true });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4000), "0.0.0.0");
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
