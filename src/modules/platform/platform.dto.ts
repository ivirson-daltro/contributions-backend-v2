import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const tenantSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]{1,40}$/)
  .refine(
    (value) =>
      !["www", "api", "app", "admin", "platform", "auth", "static"].includes(
        value,
      ),
    {
      message: "slug reservado",
    },
  );

export const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: tenantSlugSchema,
  document: z.string().trim().max(50).optional().nullable(),
  timezone: z.string().trim().min(3).max(80).optional(),
  adminEmail: z.string().trim().email(),
  adminName: z.string().trim().min(2).max(120).optional(),
  expiresAt: z.string().datetime().optional(),
});

export class CreateTenantDto extends createZodDto(createTenantSchema) {}

const issueAdminInvitationSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(2).max(120),
});

export class IssueAdminInvitationDto extends createZodDto(
  issueAdminInvitationSchema,
) {}

export type CreateTenantResult = {
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: string;
    trial_ends_at: Date | null;
    timezone: string;
  };
  invite: {
    token: string;
    expiresAt: Date;
    email: string;
    roles: string[];
  };
};
