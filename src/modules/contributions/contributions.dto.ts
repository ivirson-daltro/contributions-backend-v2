import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const uuid = z.string().uuid();
const date = z.string().date();
const positiveInteger = z.string().regex(/^[1-9]\d*$/);

export const contributionQuerySchema = z
  .object({
    memberId: uuid.optional(),
    typeId: uuid.optional(),
    methodId: uuid.optional(),
    q: z.string().trim().max(120).optional(),
    from: date.optional(),
    to: date.optional(),
    status: z.enum(["ACTIVE", "VOIDED", "ALL"]).optional(),
    page: positiveInteger.optional(),
    pageSize: positiveInteger.optional(),
    sort: z.enum(["date", "amount", "member"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "A data inicial deve ser anterior ou igual à data final.",
  });

export const contributionReportQuerySchema = z
  .object({ from: date, to: date })
  .strict()
  .refine((value) => value.from <= value.to, {
    message: "A data inicial deve ser anterior ou igual à data final.",
  })
  .refine((value) => {
    const days = (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000;
    return days <= 365;
  }, { message: "O período não pode ultrapassar 366 dias." });

export const createContributionSchema = z
  .object({
    contributionTypeId: uuid,
    paymentMethodId: uuid,
    memberId: uuid.nullable().optional(),
    amount: z
      .string()
      .regex(/^\d{1,12}(\.\d{1,2})?$/)
      .refine((value) => /[1-9]/.test(value), "O valor deve ser positivo."),
    occurredOn: date,
    observation: z.string().trim().max(2000).nullable().optional(),
    attachmentIds: z.array(uuid).max(0).optional(),
  })
  .strict();

export const updateContributionSchema = z
  .object({
    contributionTypeId: uuid.optional(),
    paymentMethodId: uuid.optional(),
    memberId: uuid.nullable().optional(),
    amount: z
      .string()
      .regex(/^\d{1,12}(\.\d{1,2})?$/)
      .refine((value) => /[1-9]/.test(value), "O valor deve ser positivo.")
      .optional(),
    occurredOn: date.optional(),
    observation: z.string().trim().max(2000).nullable().optional(),
    version: z.number().int().positive(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 1, {
    message: "Pelo menos um campo deve ser atualizado além da versão.",
  });

export const deleteContributionSchema = z
  .object({
    voidReason: z.string().trim().max(2000).optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const optionsQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    page: positiveInteger.optional(),
    pageSize: positiveInteger.optional(),
  })
  .strict();

export const memberLookupQuerySchema = z
  .object({ q: z.string().trim().max(120).optional() })
  .strict();

export class ContributionQueryDto extends createZodDto(contributionQuerySchema) {}
export class ContributionReportQueryDto extends createZodDto(contributionReportQuerySchema) {}
export class CreateContributionDto extends createZodDto(createContributionSchema) {}
export class UpdateContributionDto extends createZodDto(updateContributionSchema) {}
export class DeleteContributionDto extends createZodDto(deleteContributionSchema) {}
export class OptionsQueryDto extends createZodDto(optionsQuerySchema) {}
export class MemberLookupQueryDto extends createZodDto(memberLookupQuerySchema) {}
