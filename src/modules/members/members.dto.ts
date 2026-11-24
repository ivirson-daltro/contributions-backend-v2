import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const uuid = z.string().uuid();
const date = z.string().date();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const status = z.enum(["ACTIVE", "INACTIVE", "TRANSFERRED", "DECEASED"]);
const positiveInteger = z.string().regex(/^[1-9]\d*$/);

const memberFields = {
  name: z.string().trim().min(1).max(120),
  memberTypeId: uuid,
  status: status.optional(),
  phone: optionalText(40),
  email: z.string().trim().email().max(254).nullable().optional(),
  gender: optionalText(40),
  birthDate: date.nullable().optional(),
  entryDate: date.nullable().optional(),
  baptismDate: date.nullable().optional(),
  zipCode: optionalText(20),
  street: optionalText(200),
  number: optionalText(30),
  complement: optionalText(120),
  neighborhood: optionalText(120),
  city: optionalText(120),
  state: optionalText(40),
  consent: z.boolean().optional(),
};

export const createMemberSchema = z.object(memberFields).strict();
export const updateMemberSchema = z.object(memberFields).partial().strict()
  .refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo.");
export const memberQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  memberTypeId: uuid.optional(),
  status: z.union([status, z.literal("ALL")]).optional(),
  page: positiveInteger.optional(),
  pageSize: positiveInteger.optional(),
  sort: z.enum(["name", "type", "createdAt"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
}).strict();
export const createMemberQuerySchema = z.object({
  force: z.enum(["true", "false"]).optional(),
}).strict();

export class CreateMemberDto extends createZodDto(createMemberSchema) {}
export class UpdateMemberDto extends createZodDto(updateMemberSchema) {}
export class MemberQueryDto extends createZodDto(memberQuerySchema) {}
export class CreateMemberQueryDto extends createZodDto(createMemberQuerySchema) {}
