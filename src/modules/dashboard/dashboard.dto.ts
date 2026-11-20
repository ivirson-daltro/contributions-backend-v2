import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const dashboardSeriesQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2200).optional(),
  })
  .strict();

export class DashboardSeriesQueryDto extends createZodDto(
  dashboardSeriesQuerySchema,
) {}
