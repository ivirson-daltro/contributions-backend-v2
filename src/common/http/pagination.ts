import { BadRequestException } from "@nestjs/common";

export interface PaginationParams {
  page: number;
  pageSize: number;
  offset: number;
  sort?: string;
  order: "asc" | "desc";
}

export interface PageMeta<TTotals = Record<string, unknown>> {
  page: number;
  pageSize: number;
  total: number;
  totals?: TTotals;
}

export function parsePagination(
  query: Record<string, unknown>,
  allowedSorts: readonly string[] = [],
): PaginationParams {
  const page = parseInteger(query.page, 1, "page");
  const pageSize = parseInteger(query.pageSize, 20, "pageSize");
  if (page < 1 || pageSize < 1 || pageSize > 100) {
    throw new BadRequestException({
      code: "VALIDATION_ERROR",
      detail: "page deve ser positivo e pageSize deve estar entre 1 e 100.",
    });
  }

  const sort = typeof query.sort === "string" ? query.sort : undefined;
  if (sort && !allowedSorts.includes(sort)) {
    throw new BadRequestException({
      code: "VALIDATION_ERROR",
      detail: "Campo de ordenação inválido.",
    });
  }

  const order = query.order === undefined ? "desc" : query.order;
  if (order !== "asc" && order !== "desc") {
    throw new BadRequestException({
      code: "VALIDATION_ERROR",
      detail: "order deve ser asc ou desc.",
    });
  }

  return { page, pageSize, offset: (page - 1) * pageSize, sort, order };
}

export function pageResponse<T, TTotals = Record<string, unknown>>(
  data: T[],
  total: number,
  pagination: PaginationParams,
  totals?: TTotals,
): { data: T[]; meta: PageMeta<TTotals> } {
  return {
    data,
    meta: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      ...(totals === undefined ? {} : { totals }),
    },
  };
}

function parseInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestException({
      code: "VALIDATION_ERROR",
      detail: `${field} deve ser um inteiro válido.`,
    });
  }
  return parsed;
}
