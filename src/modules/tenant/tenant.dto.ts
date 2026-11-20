import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const tenantUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    document: z.string().trim().max(50).optional().nullable(),
    timezone: z.string().trim().min(3).max(80).optional(),
  })
  .strict();

export const tenantSettingsSchema = z
  .object({
    weekStartsOn: z.number().int().min(0).max(6).optional(),
    allowFutureDates: z.boolean().optional(),
    payableWindowDays: z.number().int().min(0).max(60).optional(),
    payableAlertDays: z.number().int().min(0).max(30).optional(),
    attachmentMaxMb: z.number().int().min(1).max(25).optional(),
    attachmentMaxFiles: z.number().int().min(1).max(20).optional(),
    requireMfaRoles: z.array(z.enum(["TENANT_ADMIN", "TREASURER"])).optional(),
    cascadeReopen: z.boolean().optional(),
  })
  .strict();

export const cancelRequestSchema = z
  .object({
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export class TenantUpdateDto extends createZodDto(tenantUpdateSchema) {}
export class TenantSettingsDto extends createZodDto(tenantSettingsSchema) {}
export class CancelRequestDto extends createZodDto(cancelRequestSchema) {}
