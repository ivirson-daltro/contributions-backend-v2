import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Post, Put, Query, StreamableFile } from "@nestjs/common";
import {
  ApiBearerAuth, ApiBody, ApiConflictResponse, ApiHeader, ApiOkResponse,
  ApiOperation, ApiProduces, ApiQuery, ApiTags,
} from "@nestjs/swagger";
import type { SchemaObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { RequirePermissions } from "../../common/authorization/require-permissions.decorator";
import { CurrentTenant } from "../../common/tenant/current-tenant.decorator";
import { TenantRequestContext } from "../../common/tenant/tenant-context";
import { CreateMemberDto, CreateMemberQueryDto, MemberQueryDto, UpdateMemberDto } from "./members.dto";
import { MembersService } from "./members.service";
import { ContributorReportQueryDto, ContributorYearQueryDto } from "./contributors.dto";
import { ContributorsService } from "./contributors.service";

const memberProperties: Record<string, SchemaObject> = {
  name: { type: "string", maxLength: 120 },
  memberTypeId: { type: "string", format: "uuid" },
  status: { type: "string", enum: ["ACTIVE", "INACTIVE", "TRANSFERRED", "DECEASED"] },
  phone: { type: "string", nullable: true },
  email: { type: "string", format: "email", nullable: true },
  gender: { type: "string", nullable: true },
  birthDate: { type: "string", format: "date", nullable: true },
  entryDate: { type: "string", format: "date", nullable: true },
  baptismDate: { type: "string", format: "date", nullable: true },
  zipCode: { type: "string", nullable: true },
  street: { type: "string", nullable: true },
  number: { type: "string", nullable: true },
  complement: { type: "string", nullable: true },
  neighborhood: { type: "string", nullable: true },
  city: { type: "string", nullable: true },
  state: { type: "string", nullable: true },
  consent: { type: "boolean" },
};

@ApiTags("members")
@ApiBearerAuth()
@ApiHeader({ name: "x-tenant-id", required: true })
@Controller("members")
export class MembersController {
  constructor(private readonly service: MembersService, private readonly contributors: ContributorsService) {}

  @Get("contributors/year/report")
  @RequirePermissions("contributors-report:read")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Gera PDF anual de membros contribuintes" })
  @ApiQuery({ name: "year", required: true, description: "Ano com quatro dígitos." })
  @ApiQuery({ name: "q", required: false, description: "Busca parcial pelo nome." })
  @ApiQuery({ name: "sort", required: false, enum: ["name", "type"] })
  @ApiQuery({ name: "order", required: false, enum: ["asc", "desc"] })
  @ApiProduces("application/pdf")
  @ApiOkResponse({ description: "PDF anual.", schema: { type: "string", format: "binary" } })
  async contributorsReport(
    @CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext,
    @Query() query: ContributorReportQueryDto,
  ): Promise<StreamableFile> {
    const pdf = await this.contributors.report(tenant.tenantId!, user, query);
    return new StreamableFile(pdf, {
      type: "application/pdf",
      disposition: `attachment; filename="contribuintes-${query.year}.pdf"`,
    });
  }

  @Get("contributors/year")
  @RequirePermissions("contributors-report:read")
  @ApiOperation({ summary: "Lista membros contribuintes por ano e mês" })
  @ApiQuery({ name: "year", required: true, description: "Ano com quatro dígitos." })
  @ApiQuery({ name: "q", required: false, description: "Busca parcial pelo nome." })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "pageSize", required: false, type: Number, description: "De 1 a 100; padrão 20." })
  @ApiQuery({ name: "sort", required: false, enum: ["name", "type"] })
  @ApiQuery({ name: "order", required: false, enum: ["asc", "desc"] })
  @ApiOkResponse({ schema: { example: {
    data: [{
      id: "00000000-0000-4000-8000-000000000001", name: "Ana",
      memberType: { id: "00000000-0000-4000-8000-000000000002", description: "Membro" },
      months: [true, false, false, false, false, false, false, false, false, false, false, true],
    }],
    meta: { page: 1, pageSize: 20, total: 1 },
  } } })
  contributorsYear(
    @CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext,
    @Query() query: ContributorYearQueryDto,
  ) {
    return this.contributors.list(tenant.tenantId!, user.userId, query);
  }

  @Get()
  @RequirePermissions("members:read-list")
  @ApiOperation({ summary: "Lista membros", description: "Por padrão retorna membros ativos, ordenados por nome." })
  @ApiQuery({ name: "q", required: false, type: String })
  @ApiQuery({ name: "memberTypeId", required: false, type: String })
  @ApiQuery({ name: "status", required: false, enum: ["ACTIVE", "INACTIVE", "TRANSFERRED", "DECEASED", "ALL"] })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "pageSize", required: false, type: Number })
  @ApiQuery({ name: "sort", required: false, enum: ["name", "type", "createdAt"] })
  @ApiQuery({ name: "order", required: false, enum: ["asc", "desc"] })
  @ApiOkResponse({ description: "Lista paginada com nome, tipo, situação e telefone." })
  list(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext, @Query() query: MemberQueryDto) {
    return this.service.list(tenant.tenantId!, user.userId, query, tenant.permissions.includes("members:read-detail"));
  }

  @Get(":id")
  @RequirePermissions("members:read-detail")
  @ApiOperation({ summary: "Consulta os dados de um membro" })
  get(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.get(tenant.tenantId!, user.userId, id);
  }

  @Post()
  @RequirePermissions("members:manage")
  @ApiOperation({ summary: "Cadastra um membro", description: "Tesoureiro pode informar apenas nome e tipo. Secretaria e administrador podem informar todos os campos." })
  @ApiQuery({ name: "force", required: false, enum: ["true", "false"], description: "Permite cadastrar após confirmação de possível duplicidade." })
  @ApiBody({ schema: { type: "object", required: ["name", "memberTypeId"], additionalProperties: false, properties: memberProperties } })
  @ApiConflictResponse({ description: "Possível duplicidade; confirme com force=true." })
  create(
    @CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext,
    @Body() payload: CreateMemberDto, @Query() query: CreateMemberQueryDto,
  ) {
    return this.service.create(tenant, user.userId, payload, query.force === "true");
  }

  @Put(":id")
  @RequirePermissions("members:manage")
  @ApiOperation({ summary: "Atualiza um membro", description: "Campos omitidos são preservados. Tesoureiro só pode alterar nome e tipo dos membros que criou." })
  @ApiBody({ schema: { type: "object", minProperties: 1, additionalProperties: false, properties: memberProperties } })
  update(
    @CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext,
    @Param("id", ParseUUIDPipe) id: string, @Body() payload: UpdateMemberDto,
  ) {
    return this.service.update(tenant, user.userId, id, payload);
  }

  @Delete(":id")
  @RequirePermissions("members:manage")
  @ApiOperation({ summary: "Exclui um membro logicamente", description: "Tesoureiro só pode excluir membros que criou; membros com acesso ativo não podem ser excluídos." })
  @ApiConflictResponse({ description: "O membro possui acesso ativo." })
  delete(
    @CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.delete(tenant, user.userId, id);
  }
}

@ApiTags("members")
@ApiBearerAuth()
@ApiHeader({ name: "x-tenant-id", required: true })
@Controller("catalogs")
export class MemberTypesController {
  constructor(private readonly service: MembersService) {}

  @Get("member-types")
  @RequirePermissions("catalogs:read")
  @ApiOperation({ summary: "Lista tipos de membro ativos para o formulário" })
  list(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: TenantRequestContext) {
    return this.service.listTypes(tenant.tenantId!, user.userId);
  }
}
