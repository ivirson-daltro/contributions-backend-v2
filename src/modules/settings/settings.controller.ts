import { Body, Controller, DefaultValuePipe, Get, Header, ParseBoolPipe, ParseEnumPipe, Put, Query, StreamableFile, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { RequirePermissions } from "../../common/authorization/require-permissions.decorator";
import { CurrentTenant } from "../../common/tenant/current-tenant.decorator";
import { TenantRequestContext } from "../../common/tenant/tenant-context";
import { TenantSettingsDto, TenantUpdateDto } from "../tenant/tenant.dto";
import { SettingsService } from "./settings.service";
import { LogoService, LogoTheme } from "./logo.service";

@ApiTags("settings")
@ApiBearerAuth()
@ApiHeader({ name: "x-tenant-id", required: true })
@Controller("tenant")
export class SettingsController {
  constructor(private readonly service: SettingsService, private readonly logo: LogoService) {}

  @Get("logo")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Obtém a logo privada da igreja" })
  @ApiQuery({ name: "theme", required: false, enum: LogoTheme })
  @ApiQuery({ name: "fallback", required: false, type: Boolean })
  async getLogo(
    @CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext,
    @Query("theme", new DefaultValuePipe(LogoTheme.Light), new ParseEnumPipe(LogoTheme)) theme: LogoTheme,
    @Query("fallback", new DefaultValuePipe(true), new ParseBoolPipe()) fallback: boolean,
  ) {
    const logo = await this.logo.get(tenant.tenantId!, user.userId, theme, fallback);
    return new StreamableFile(logo.data, { type: logo.contentType });
  }

  @Put("logo")
  @RequirePermissions("tenant-settings:write")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 2_097_152, files: 1 } }))
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } } })
  @ApiOperation({ summary: "Atualiza a logo da igreja" })
  @ApiQuery({ name: "theme", required: false, enum: LogoTheme })
  uploadLogo(
    @CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext,
    @UploadedFile() file: { buffer: Buffer; size: number; mimetype: string } | undefined,
    @Query("theme", new DefaultValuePipe(LogoTheme.Light), new ParseEnumPipe(LogoTheme)) theme: LogoTheme,
  ) {
    return this.logo.upload(tenant.tenantId!, user.userId, theme, file);
  }

  @Get()
  @RequirePermissions("tenant-settings:write")
  @ApiOperation({ summary: "Consulta dados da igreja" })
  getTenant(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext) {
    return this.service.getTenant(tenant.tenantId!, user.userId);
  }

  @Put()
  @RequirePermissions("tenant-settings:write")
  @ApiOperation({ summary: "Atualiza dados da igreja" })
  @ApiBody({ schema: { type: "object", properties: {
    name: { type: "string", minLength: 2, maxLength: 120 },
    document: { type: "string", maxLength: 50, nullable: true },
    timezone: { type: "string", example: "America/Sao_Paulo" },
  }, additionalProperties: false } })
  updateTenant(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext, @Body() body: TenantUpdateDto) {
    return this.service.updateTenant(tenant.tenantId!, user.userId, body);
  }

  @Get("settings")
  @RequirePermissions("tenant-settings:write")
  @ApiOperation({ summary: "Consulta preferências da igreja" })
  getPreferences(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext) {
    return this.service.getPreferences(tenant.tenantId!, user.userId);
  }

  @Put("settings")
  @RequirePermissions("tenant-settings:write")
  @ApiOperation({ summary: "Atualiza preferências da igreja" })
  @ApiBody({ schema: { type: "object", additionalProperties: false, properties: {
    weekStartsOn: { type: "integer", minimum: 0, maximum: 6 },
    allowFutureDates: { type: "boolean" },
    payableWindowDays: { type: "integer", minimum: 0, maximum: 60 },
    payableAlertDays: { type: "integer", minimum: 0, maximum: 30 },
    attachmentMaxMb: { type: "integer", minimum: 1, maximum: 25 },
    attachmentMaxFiles: { type: "integer", minimum: 1, maximum: 20 },
    requireMfaRoles: { type: "array", items: { type: "string", enum: ["TENANT_ADMIN", "TREASURER"] } },
    cascadeReopen: { type: "boolean" },
  } } })
  updatePreferences(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext, @Body() body: TenantSettingsDto) {
    return this.service.updatePreferences(tenant.tenantId!, user.userId, body);
  }
}
