export interface MappedDatabaseError {
  status: number;
  code: string;
  detail: string;
}

interface DatabaseErrorLike {
  code?: unknown;
  message?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

function errorChain(error: unknown): DatabaseErrorLike[] {
  const chain: DatabaseErrorLike[] = [];
  let current: unknown = error;
  while (
    current &&
    typeof current === "object" &&
    !chain.includes(current as DatabaseErrorLike)
  ) {
    chain.push(current as DatabaseErrorLike);
    current = (current as DatabaseErrorLike).cause;
  }
  return chain;
}

export function mapDatabaseError(
  error: unknown,
): MappedDatabaseError | undefined {
  for (const candidate of errorChain(error)) {
    const code = typeof candidate.code === "string" ? candidate.code : "";
    const message =
      typeof candidate.message === "string" ? candidate.message : "";
    const constraint =
      typeof candidate.constraint === "string" ? candidate.constraint : "";

    if (code === "P0001") {
      const mappings: Array<[string, number, string]> = [
        ["MONTH_CLOSED:", 409, "MONTH_CLOSED"],
        ["MEMBER_REQUIRED:", 422, "MEMBER_REQUIRED"],
        ["CASH_ON_HAND_REQUIRED:", 422, "CASH_ON_HAND_REQUIRED"],
        ["LAST_TENANT_ADMIN:", 409, "LAST_TENANT_ADMIN"],
        ["LAST_PLATFORM_ADMIN:", 409, "LAST_PLATFORM_ADMIN"],
        ["PLATFORM_FORBIDDEN:", 403, "FORBIDDEN"],
        ["TENANT_HAS_ADMIN:", 409, "TENANT_HAS_ADMIN"],
        ["REASON_REQUIRED:", 422, "REASON_REQUIRED"],
        ["TENANT_CANCELLED:", 409, "TENANT_CANCELLED_IRREVERSIBLE"],
        ["INVITATION_NOT_FOUND", 404, "NOT_FOUND"],
        ["INVITATION_ALREADY_USED", 410, "INVITATION_EXPIRED"],
        ["INVITATION_REVOKED", 410, "INVITATION_EXPIRED"],
        ["INVITATION_EXPIRED", 410, "INVITATION_EXPIRED"],
        ["INVITATION_EMAIL_MISMATCH:", 403, "INVITATION_EMAIL_MISMATCH"],
        ["TENANT_UNAVAILABLE:", 423, "TENANT_SUSPENDED"],
        ["DELETE_FORBIDDEN:", 500, "INTERNAL"],
        ["AUDIT_IMMUTABLE:", 500, "INTERNAL"],
      ];
      const match = mappings.find(([prefix]) => message.startsWith(prefix));
      if (match) {
        return { status: match[1], code: match[2], detail: message };
      }
    }

    if (code === "23505") {
      if (constraint.endsWith("_desc_uk")) {
        return {
          status: 409,
          code: "DUPLICATE_DESCRIPTION",
          detail: "Descrição já cadastrada.",
        };
      }
      if (constraint === "fee_rules_name_uk") {
        return {
          status: 409,
          code: "DUPLICATE_NAME",
          detail: "Já existe uma regra com este nome.",
        };
      }
      if (constraint === "monthly_balances_period_uk") {
        return {
          status: 409,
          code: "DUPLICATE_PERIOD",
          detail: "Já existe um saldo para este período.",
        };
      }
      if (constraint === "payments_one_active") {
        return {
          status: 409,
          code: "ALREADY_PAID",
          detail: "Esta ocorrência já foi paga.",
        };
      }
      if (constraint.includes("slug")) {
        return {
          status: 409,
          code: "SLUG_TAKEN",
          detail: "Este identificador já está em uso.",
        };
      }
    }

    if (code === "23503") {
      return {
        status: 422,
        code: "INVALID_REFERENCE",
        detail: "Uma das referências informadas não existe.",
      };
    }
  }
  return undefined;
}
