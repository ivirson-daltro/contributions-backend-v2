import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const year = z.string().regex(/^\d{4}$/).refine((value) => Number(value) >= 1 && Number(value) <= 9998);
const filters = {
  year,
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["name", "type"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
};

export const contributorYearQuerySchema = z.object({
  ...filters,
  page: z.string().regex(/^[1-9]\d*$/).optional(),
  pageSize: z.string().regex(/^[1-9]\d*$/).optional(),
}).strict();

export const contributorReportQuerySchema = z.object(filters).strict();

export class ContributorYearQueryDto extends createZodDto(contributorYearQuerySchema) {}
export class ContributorReportQueryDto extends createZodDto(contributorReportQuerySchema) {}
