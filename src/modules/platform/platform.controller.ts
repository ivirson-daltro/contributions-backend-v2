import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import {
  SkipMfa,
  TenantOptional,
} from "../../common/tenant/tenant-optional.decorator";
import { CreateTenantDto, IssueAdminInvitationDto } from "./platform.dto";
import { PlatformService } from "./platform.service";

@ApiTags("platform")
@Controller("platform")
export class PlatformController {
  constructor(private readonly platformService: PlatformService) {}

  @Get("tenants")
  @ApiBearerAuth()
  @TenantOptional()
  @SkipMfa()
  @ApiOperation({ summary: "Lista igrejas da plataforma" })
  listTenants(@CurrentUser() user: AuthenticatedUser) {
    return this.platformService.listTenants(user);
  }

  @Post("tenants")
  @ApiBearerAuth()
  @TenantOptional()
  @SkipMfa()
  @ApiOperation({
    summary: "Cria uma igreja e emite o primeiro convite de TENANT_ADMIN",
  })
  createTenant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() payload: CreateTenantDto,
  ) {
    return this.platformService.createTenant(user, payload);
  }

  @Post("tenants/:id/admin-invitations")
  @ApiBearerAuth()
  @TenantOptional()
  @SkipMfa()
  @ApiOperation({
    summary:
      "Emite novo convite de TENANT_ADMIN para igreja sem administrador ativo",
  })
  @ApiBody({ type: IssueAdminInvitationDto })
  issueAdminInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") tenantId: string,
    @Body() payload: IssueAdminInvitationDto,
  ) {
    return this.platformService.issueAdminInvitation(user, tenantId, payload);
  }

  @Get("public/tenants/by-slug/:slug")
  @Public()
  @ApiOperation({ summary: "Resolve uma igreja pelo slug" })
  getTenantBySlug(@Param("slug") slug: string) {
    return this.platformService.findTenantBySlug(slug);
  }
}
