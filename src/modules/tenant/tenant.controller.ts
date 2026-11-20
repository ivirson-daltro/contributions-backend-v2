import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { CurrentTenant } from "../../common/tenant/current-tenant.decorator";
import { TenantRequestContext } from "../../common/tenant/tenant-context";
import { RequirePermissions } from "../../common/authorization/require-permissions.decorator";
import {
  CancelRequestDto,
  TenantSettingsDto,
  TenantUpdateDto,
} from "./tenant.dto";
import { TenantService } from "./tenant.service";

@ApiTags("tenant")
@Controller("tenant")
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Get()
  @ApiBearerAuth()
  @RequirePermissions("tenant-settings:write")
  @ApiOperation({ summary: "Retorna os dados principais da igreja" })
  getTenant(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant?: TenantRequestContext,
  ) {
    return this.tenantService.getTenantSummary(user, tenant?.tenantId);
  }

  @Put()
  @ApiBearerAuth()
  @RequirePermissions("tenant-settings:write")
  @ApiOperation({ summary: "Atualiza dados básicos da igreja" })
  updateTenant(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Body() payload: TenantUpdateDto,
  ) {
    return this.tenantService.updateTenant(user, tenant.tenantId!, payload);
  }

  @Get("settings")
  @ApiBearerAuth()
  @RequirePermissions("tenant-settings:write")
  @ApiOperation({ summary: "Retorna as configurações da igreja" })
  getSettings(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
  ) {
    return this.tenantService.getSettings(user, tenant.tenantId!);
  }

  @Put("settings")
  @ApiBearerAuth()
  @RequirePermissions("tenant-settings:write")
  @ApiOperation({ summary: "Atualiza as configurações da igreja" })
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Body() payload: TenantSettingsDto,
  ) {
    return this.tenantService.updateSettings(user, tenant.tenantId!, payload);
  }

  @Post("export")
  @ApiBearerAuth()
  @RequirePermissions("data:export")
  @ApiOperation({ summary: "Cria job de exportação da igreja" })
  exportTenant(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
  ) {
    return this.tenantService.createExportJob(user, tenant.tenantId!);
  }

  @Get("export/:jobId")
  @ApiBearerAuth()
  @RequirePermissions("data:export")
  @ApiOperation({ summary: "Consulta o status da exportação" })
  getExportJob(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Param("jobId") jobId: string,
  ) {
    return this.tenantService.getExportJob(user, tenant.tenantId!, jobId);
  }

  @Post("cancel-request")
  @ApiBearerAuth()
  @RequirePermissions("tenant-settings:write")
  @ApiOperation({ summary: "Registra pedido de cancelamento da igreja" })
  cancelRequest(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Body() payload: CancelRequestDto,
  ) {
    return this.tenantService.cancelRequest(user, tenant.tenantId!, payload);
  }
}
