import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Request, Response } from "express";
import { mapDatabaseError } from "./db-error-mapper";

interface ProblemResponse {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  errors?: unknown;
  requestId: string;
}

const TITLES: Record<number, string> = {
  400: "Requisição inválida",
  401: "Não autenticado",
  403: "Acesso negado",
  404: "Não encontrado",
  409: "Conflito",
  410: "Convite expirado",
  422: "Regra de negócio violada",
  423: "Recurso indisponível",
  429: "Limite de requisições excedido",
  500: "Erro interno",
  503: "Serviço indisponível",
};

function defaultCode(status: number): string {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "INTERNAL";
  return "VALIDATION_ERROR";
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { requestId?: string }>();
    const response = http.getResponse<Response>();
    const requestId = request.requestId ?? randomUUID();
    const mapped = mapDatabaseError(exception);

    let status = mapped?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
    let code = mapped?.code ?? "INTERNAL";
    let detail = mapped?.detail ?? "Ocorreu um erro inesperado.";
    let errors: unknown;

    if (!mapped && exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        detail = body;
      } else if (body && typeof body === "object") {
        const payload = body as Record<string, unknown>;
        if (typeof payload.code === "string") code = payload.code;
        else code = defaultCode(status);
        if (typeof payload.detail === "string") detail = payload.detail;
        else if (typeof payload.message === "string") detail = payload.message;
        else if (Array.isArray(payload.message)) {
          detail = "Um ou mais campos são inválidos.";
          errors = payload.message;
        }
        if (Array.isArray(payload.errors)) errors = payload.errors;
      }
    } else if (!mapped && exception instanceof Error) {
      console.error({ requestId, error: exception.message });
    }

    const problem: ProblemResponse = {
      type: `https://api.ibg/errors/${code.toLowerCase()}`,
      title: TITLES[status] ?? "Erro",
      status,
      code,
      detail,
      ...(errors ? { errors } : {}),
      requestId,
    };

    response.status(status).type("application/problem+json").json(problem);
  }
}
