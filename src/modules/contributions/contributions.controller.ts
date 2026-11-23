import { Body, Controller, Get, Header, Headers, Post, Query, StreamableFile } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { RequirePermissions } from "../../common/authorization/require-permissions.decorator";
import { CurrentTenant } from "../../common/tenant/current-tenant.decorator";
import { TenantRequestContext } from "../../common/tenant/tenant-context";
import {
  ContributionQueryDto,
  ContributionReportQueryDto,
  CreateContributionDto,
  MemberLookupQueryDto,
  OptionsQueryDto,
} from "./contributions.dto";
import { ContributionsService } from "./contributions.service";
import { ContributionsReportService } from "./contributions-report.service";

@ApiTags("contributions")
@ApiBearerAuth()
@ApiHeader({ name: "x-tenant-id", required: true })
@Controller()
export class ContributionsController {
  constructor(
    private readonly service: ContributionsService,
    private readonly reports: ContributionsReportService,
  ) {}

  @Get("contributions/report")
  @RequirePermissions("contributions-report:generate")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Gera PDF de contribuições por meio de pagamento",
    description: "Exige contributions-report:generate e, quando configurado para o perfil, autenticação com MFA.",
  })
  @ApiQuery({ name: "from", required: true, type: String, description: "Data inicial inclusiva (AAAA-MM-DD)." })
  @ApiQuery({ name: "to", required: true, type: String, description: "Data final inclusiva (AAAA-MM-DD). Período máximo de 366 dias." })
  @ApiProduces("application/pdf")
  @ApiOkResponse({ description: "PDF gerado diretamente.", schema: { type: "string", format: "binary" } })
  @ApiBadRequestResponse({ description: "Datas inválidas, ausentes ou intervalo superior a 366 dias." })
  @ApiForbiddenResponse({ description: "Sem permissão para gerar o relatório ou MFA necessário." })
  async report(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Query() query: ContributionReportQueryDto,
  ): Promise<StreamableFile> {
    const pdf = await this.reports.generate(tenant.tenantId!, user, query);
    return new StreamableFile(pdf, {
      type: "application/pdf",
      disposition: `attachment; filename="contribuicoes-${query.from}-a-${query.to}.pdf"`,
    });
  }

  @Get("contributions")
  @RequirePermissions("contributions:read")
  @ApiOperation({
    summary: "Lista contribuições e totais de todo o filtro",
    description: "Sem from e to, retorna o mês vigente no fuso do tenant. Ao informar qualquer uma das datas, aplica apenas os limites informados.",
  })
  @ApiQuery({ name: "q", required: false, type: String, description: "Busca parcial pelo nome do membro." })
  @ApiQuery({ name: "memberId", required: false, type: String })
  @ApiQuery({ name: "typeId", required: false, type: String })
  @ApiQuery({ name: "methodId", required: false, type: String })
  @ApiQuery({ name: "from", required: false, type: String, description: "Data inicial inclusiva (AAAA-MM-DD)." })
  @ApiQuery({ name: "to", required: false, type: String, description: "Data final inclusiva (AAAA-MM-DD)." })
  @ApiQuery({ name: "status", required: false, enum: ["ACTIVE", "VOIDED", "ALL"], description: "Padrão: ACTIVE." })
  @ApiQuery({ name: "page", required: false, type: Number, description: "Página; padrão 1." })
  @ApiQuery({ name: "pageSize", required: false, type: Number, description: "Tamanho da página entre 1 e 100; padrão 20." })
  @ApiQuery({ name: "sort", required: false, enum: ["date", "amount", "member"], description: "Padrão: date." })
  @ApiQuery({ name: "order", required: false, enum: ["asc", "desc"], description: "Padrão: desc." })
  @ApiOkResponse({
    description: "Totais consideram somente lançamentos ACTIVE, sobre todo o filtro.",
    schema: { example: {
      data: [{
        id: "00000000-0000-4000-8000-000000000001",
        occurredOn: "2026-11-12", amount: "850.00",
        member: { id: "00000000-0000-4000-8000-000000000002", name: "Ana" },
        type: { id: "00000000-0000-4000-8000-000000000003", description: "Dízimo", category: "TITHE" },
        method: { id: "00000000-0000-4000-8000-000000000004", description: "Pix", kind: "PIX" },
        observation: null, status: "ACTIVE", attachmentsCount: 0, version: 1,
      }],
      meta: { page: 1, pageSize: 20, total: 1, totals: { amount: "850.00", count: 1 } },
    } },
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Query() query: ContributionQueryDto,
  ) {
    return this.service.list(tenant.tenantId!, user.userId, query);
  }

  @Post("contributions")
  @RequirePermissions("contributions:write")
  @ApiOperation({
    summary: "Registra uma contribuição sem anexos",
    description: "Envie Idempotency-Key para permitir repetição segura. Anexos ainda não são suportados.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({
    schema: {
      type: "object",
      required: ["contributionTypeId", "paymentMethodId", "amount", "occurredOn"],
      additionalProperties: false,
      properties: {
        contributionTypeId: { type: "string", format: "uuid" },
        paymentMethodId: { type: "string", format: "uuid" },
        memberId: { type: "string", format: "uuid", nullable: true },
        amount: { type: "string", example: "850.00", description: "Valor decimal positivo, com até duas casas." },
        occurredOn: { type: "string", format: "date", example: "2026-11-12" },
        observation: { type: "string", nullable: true, maxLength: 2000 },
        attachmentIds: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 0, description: "Somente lista vazia é aceita nesta etapa." },
      },
    },
  })
  @ApiCreatedResponse({
    description: "Contribuição criada ou resposta original de uma requisição repetida.",
    schema: { example: {
      id: "00000000-0000-4000-8000-000000000001",
      occurredOn: "2026-11-12", amount: "850.00",
      member: { id: "00000000-0000-4000-8000-000000000002", name: "Ana" },
      type: { id: "00000000-0000-4000-8000-000000000003", description: "Dízimo", category: "TITHE" },
      method: { id: "00000000-0000-4000-8000-000000000004", description: "Pix", kind: "PIX" },
      observation: null, status: "ACTIVE", attachmentsCount: 0, version: 1,
    } },
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Headers("idempotency-key") key: string | undefined,
    @Body() payload: CreateContributionDto,
  ) {
    return this.service.create(tenant.tenantId!, user.userId, key, payload);
  }

  @Get("catalogs/contribution-types")
  @RequirePermissions("catalogs:read")
  @ApiOperation({ summary: "Lista tipos ativos para o formulário" })
  @ApiQuery({ name: "q", required: false, type: String })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "pageSize", required: false, type: Number })
  @ApiOkResponse({ schema: { example: {
    data: [{ id: "00000000-0000-4000-8000-000000000001", description: "Dízimo", category: "TITHE", requiresMember: true, countsForFees: true, countsAsContributor: true }],
    meta: { page: 1, pageSize: 20, total: 1 },
  } } })
  listTypes(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Query() query: OptionsQueryDto,
  ) {
    return this.service.listTypes(tenant.tenantId!, user.userId, query);
  }

  @Get("catalogs/payment-methods")
  @RequirePermissions("catalogs:read")
  @ApiOperation({ summary: "Lista meios de pagamento ativos para o formulário" })
  @ApiQuery({ name: "q", required: false, type: String })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "pageSize", required: false, type: Number })
  @ApiOkResponse({ schema: { example: {
    data: [{ id: "00000000-0000-4000-8000-000000000001", description: "Pix", kind: "PIX" }],
    meta: { page: 1, pageSize: 20, total: 1 },
  } } })
  listMethods(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Query() query: OptionsQueryDto,
  ) {
    return this.service.listMethods(tenant.tenantId!, user.userId, query);
  }

  @Get("members/lookup")
  @RequirePermissions("members:read-list")
  @ApiOperation({ summary: "Busca membros ativos para o formulário" })
  @ApiQuery({ name: "q", required: false, type: String })
  @ApiOkResponse({ schema: { example: [{
    id: "00000000-0000-4000-8000-000000000001",
    name: "Ana",
    memberType: { id: "00000000-0000-4000-8000-000000000002", description: "Membro" },
  }] } })
  lookupMembers(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: TenantRequestContext,
    @Query() query: MemberLookupQueryDto,
  ) {
    return this.service.lookupMembers(tenant.tenantId!, user.userId, query.q);
  }
}
