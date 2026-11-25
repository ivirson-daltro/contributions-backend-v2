import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { RequirePermissions } from "../../common/authorization/require-permissions.decorator";
import { CurrentTenant } from "../../common/tenant/current-tenant.decorator";
import { TenantRequestContext } from "../../common/tenant/tenant-context";
import { CatalogDto, CatalogQueryDto, FeeRulesDto } from "./catalogs.dto";
import { CatalogsService } from "./catalogs.service";

@ApiTags("settings")
@ApiBearerAuth()
@ApiHeader({ name: "x-tenant-id", required: true })
@Controller("settings")
export class CatalogsController {
  constructor(private readonly service: CatalogsService) {}

  @Get("catalogs/:catalog")
  @RequirePermissions("catalogs:read")
  @ApiOperation({ summary: "Lista itens ativos e inativos de um catálogo" })
  list(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext, @Param("catalog") catalog: string) {
    return this.service.list(tenant.tenantId!, user.userId, catalog);
  }

  @Post("catalogs/:catalog")
  @RequirePermissions("catalogs:write")
  @ApiBody({ type: CatalogDto })
  create(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext, @Param("catalog") catalog: string, @Body() body: CatalogDto) {
    return this.service.create(tenant.tenantId!, user.userId, catalog, body);
  }

  @Put("catalogs/:catalog/:id")
  @RequirePermissions("catalogs:write")
  @ApiBody({ type: CatalogDto })
  @ApiQuery({ name: "confirm", required: false, enum: ["true", "false"] })
  update(
    @CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext,
    @Param("catalog") catalog: string, @Param("id", ParseUUIDPipe) id: string, @Body() body: CatalogDto, @Query() query: CatalogQueryDto,
  ) {
    return this.service.update(tenant.tenantId!, user.userId, catalog, id, body, query.confirm === "true");
  }

  @Delete("catalogs/:catalog/:id")
  @RequirePermissions("catalogs:write")
  delete(
    @CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext,
    @Param("catalog") catalog: string, @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.delete(tenant.tenantId!, user.userId, catalog, id);
  }

  @Get("fees")
  @RequirePermissions("tenant-settings:write")
  @ApiOperation({ summary: "Lista regras de taxas associativas" })
  listFees(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext) {
    return this.service.listFees(tenant.tenantId!, user.userId);
  }

  @Put("fees")
  @RequirePermissions("tenant-settings:write")
  @ApiBody({ type: FeeRulesDto })
  @ApiOperation({ summary: "Substitui as regras de taxas associativas" })
  updateFees(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext, @Body() body: FeeRulesDto) {
    return this.service.updateFees(tenant.tenantId!, user.userId, body);
  }
}
