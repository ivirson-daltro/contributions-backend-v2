import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const catalogSchema = z.object({
  description: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
  category: z.enum(["TITHE", "OFFERING", "CONSTRUCTION_OFFERING", "MISSIONS", "INCOME", "OTHER"]).optional(),
  kind: z.enum(["CASH", "PIX", "CARD", "TRANSFER", "CHECK", "OTHER"]).optional(),
  requiresMember: z.boolean().optional(),
  countsForFees: z.boolean().optional(),
  countsAsContributor: z.boolean().optional(),
}).strict();
export const catalogQuerySchema = z.object({ confirm: z.enum(["true", "false"]).optional() }).strict();
export const feeRulesSchema = z.object({
  rules: z.array(z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    percent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/),
    rounding: z.enum(["HALF_UP_2", "LEGACY_CENTS_09"]),
    active: z.boolean(),
    sortOrder: z.number().int().min(-32768).max(32767),
  }).strict()).max(100),
}).strict().refine((value) => {
  const ids = value.rules.flatMap((rule) => rule.id ? [rule.id] : []);
  return new Set(ids).size === ids.length && new Set(value.rules.map((rule) => rule.name)).size === value.rules.length;
}, { message: "Regras e nomes devem ser únicos." });

export class CatalogDto extends createZodDto(catalogSchema) {}
export class CatalogQueryDto extends createZodDto(catalogQuerySchema) {}
export class FeeRulesDto extends createZodDto(feeRulesSchema) {}
