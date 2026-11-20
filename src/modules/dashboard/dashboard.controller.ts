import { Controller, Get, Query } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { CurrentTenant } from "../../common/tenant/current-tenant.decorator";
import { TenantRequestContext } from "../../common/tenant/tenant-context";
import { RequirePermissions } from "../../common/authorization/require-permissions.decorator";
import { DashboardSeriesQueryDto } from "./dashboard.dto";
import { DashboardService } from "./dashboard.service";

@ApiTags("dashboard")
@ApiBearerAuth()
@ApiHeader({
  name: "x-tenant-id",
  required: true,
  description: "Identificador do tenant selecionado.",
})
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("summary")
  @RequirePermissions("dashboard:read")
  @ApiOperation({ summary: "Retorna os indicadores da visão geral" })
  @ApiOkResponse({
    description:
      "Indicadores do período atual. Valores monetários são strings decimais; saldo final e acumulado podem ser null enquanto o saldo em mãos não for informado. As listas de contas exigem payables:read e são null sem essa permissão.",
    schema: {
      type: "object",
      example: {
        period: {
          year: 2026,
          month: 11,
          today: "2026-11-19",
          weekStart: "2026-11-16",
          weekStartsOn: 1,
        },
        income: {
          week: "0.00",
          previousWeek: "0.00",
          month: "0.00",
          weekCount: 0,
          previousWeekCount: 0,
          monthCount: 0,
        },
        expense: {
          week: "0.00",
          month: "0.00",
          year: "0.00",
          weekCount: 0,
          monthCount: 0,
          yearCount: 0,
        },
        balance: {
          month: "0.00",
          opening: null,
          openingDefined: false,
          cashOnHand: null,
          final: null,
          accumulated: null,
        },
        byKind: { week: {}, previousWeek: {}, month: {} },
        members: { active: 0, contributorsMonth: 0 },
        constructionOffering: { total: "0.00", count: 0 },
        payables: {
          overdueCount: 1,
          next7DaysCount: 1,
          next7DaysAmount: "199.90",
          overdue: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              payableId: "00000000-0000-4000-8000-000000000002",
              description: "Energia elétrica",
              dueDate: "2026-11-18",
              expectedAmount: "1240.00",
            },
          ],
          next7Days: [
            {
              id: "00000000-0000-4000-8000-000000000003",
              payableId: "00000000-0000-4000-8000-000000000004",
              description: "Internet",
              dueDate: "2026-11-24",
              expectedAmount: "199.90",
            },
          ],
        },
      },
    },
  })
  getSummary(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
  ) {
    return this.dashboardService.getSummary(
      tenant.tenantId!,
      user.userId,
      tenant.permissions.includes("payables:read"),
    );
  }

  @Get("series")
  @RequirePermissions("dashboard:read")
  @ApiOperation({ summary: "Retorna as séries mensais do ano e do anterior" })
  @ApiQuery({
    name: "year",
    required: false,
    type: Number,
    description:
      "Ano da série (2000–2200). Se omitido, usa o ano atual no fuso do tenant.",
  })
  @ApiOkResponse({
    description:
      "Arrays de 12 posições, uma por mês (janeiro–dezembro). Valores monetários são strings decimais; byKind discrimina meios e NON_PIX.",
    schema: {
      type: "object",
      example: {
        year: 2026,
        income: {
          current: Array(12).fill("0.00"),
          previous: Array(12).fill("0.00"),
          byKind: {
            PIX: {
              current: Array(12).fill("0.00"),
              previous: Array(12).fill("0.00"),
            },
            NON_PIX: {
              current: Array(12).fill("0.00"),
              previous: Array(12).fill("0.00"),
            },
          },
        },
        expense: {
          current: Array(12).fill("0.00"),
          previous: Array(12).fill("0.00"),
        },
      },
    },
  })
  getSeries(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Query() query: DashboardSeriesQueryDto,
  ) {
    return this.dashboardService.getSeries(
      tenant.tenantId!,
      user.userId,
      query.year,
    );
  }
}
