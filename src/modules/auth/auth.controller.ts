import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { OptionalAuth } from "../../common/auth/optional-auth.decorator";
import { Public } from "../../common/auth/public.decorator";
import {
  SkipMfa,
  TenantOptional,
} from "../../common/tenant/tenant-optional.decorator";
import { AcceptInvitationDto } from "./auth.dto";
import { AuthService } from "./auth.service";

@ApiTags("auth")
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get("me")
  @TenantOptional()
  @SkipMfa()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Retorna o usuário e suas associações",
    description:
      "Cada associação informa se exige MFA e se a sessão atual satisfez esse requisito. X-Tenant-Id é opcional; quando informado, também retorna permissões e configurações do tenant.",
  })
  @ApiHeader({
    name: "x-tenant-id",
    required: false,
    description:
      "Seleciona uma associação para incluir permissões efetivas e os dados do tenant.",
  })
  @ApiOkResponse({
    description:
      "Sem X-Tenant-Id, retorna MFA em cada associação. Com X-Tenant-Id, acrescenta permissões, configurações e o estado MFA do tenant selecionado.",
    schema: {
      type: "object",
      example: {
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          email: "usuario@example.com",
          displayName: "Usuário",
        },
        memberships: [
          {
            tenantId: "00000000-0000-4000-8000-000000000002",
            slug: "igreja-exemplo",
            name: "Igreja Exemplo",
            status: "ACTIVE",
            roles: ["TREASURER"],
            mfa: { required: true, satisfied: false },
          },
        ],
      },
    },
  })
  getMe(
    @CurrentUser() user: AuthenticatedUser,
    @Headers("x-tenant-id") tenantId?: string,
  ) {
    return this.authService.getMe(user, tenantId);
  }

  @Get("public/invitations/:token")
  @Public()
  @ApiOperation({ summary: "Consulta a prévia de um convite" })
  getInvitationPreview(@Param("token") token: string) {
    return this.authService.getInvitationPreview(token);
  }

  @Post("public/invitations/:token/accept")
  @OptionalAuth()
  @TenantOptional()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Aceita um convite e ativa a associação" })
  @ApiBody({ type: AcceptInvitationDto })
  acceptInvitation(
    @Param("token") token: string,
    @Body() body: AcceptInvitationDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.authService.acceptInvitation(token, body, user);
  }
}
