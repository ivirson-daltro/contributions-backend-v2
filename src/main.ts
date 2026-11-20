import "dotenv/config";
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { ZodValidationPipe } from "nestjs-zod";
import { AppModule } from "./app.module";
import { TenantContext } from "./common/tenant/tenant-context";
import { environment } from "./config/env";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const tenantContext = app.get(TenantContext);
  app.use((request: Request, response: Response, next: NextFunction) => {
    const suppliedId = request.header("x-request-id")?.trim();
    const requestId =
      suppliedId && suppliedId.length <= 128 ? suppliedId : randomUUID();
    response.setHeader("X-Request-Id", requestId);
    (request as Request & { requestId?: string }).requestId = requestId;
    tenantContext.run(requestId, next);
  });
  app.use(helmet());
  app.enableCors({
    origin: environment.CORS_ORIGINS.split(",").map((origin) => origin.trim()),
  });
  app.setGlobalPrefix("v1", {
    exclude: [
      { path: "health", method: RequestMethod.GET },
      { path: "health/ready", method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(new ZodValidationPipe());

  if (environment.NODE_ENV !== "production") {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("Sistema de Gestao IBG")
        .setDescription("API do Sistema de Gestao IBG v2")
        .setVersion("1.0")
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup("docs", app, document);
  }

  await app.listen(environment.PORT);
}

void bootstrap();
