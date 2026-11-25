import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { Kysely, sql } from "kysely";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { Database, TenantTransactions } from "../../common/database/database.module";
import { pageResponse, parsePagination } from "../../common/http/pagination";
import { renderReport, reportHeader, reportLayout } from "../../common/pdf/report-layout";
import { ContributorReportQueryDto, ContributorYearQueryDto } from "./contributors.dto";
import { LogoService } from "../settings/logo.service";

interface ContributorRow {
  id: string;
  name: string;
  type_id: string;
  type_description: string;
  contributed_months: number[];
}

export interface Contributor {
  id: string;
  name: string;
  memberType: { id: string; description: string };
  months: boolean[];
}

interface Header {
  name: string;
  document: string | null;
  timezone: string;
  display_name: string | null;
  logo?: string | null;
}

const monthLabels = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
// Helvetica at 9 pt with lineHeight 1, as used in the text cells below.
const textLineHeight = 8.325;
const badgeHeight = 15;

interface TextCell {
  text: string;
  font: "Helvetica";
  fontSize: 9;
  lineHeight: 1;
  margin?: [number, number, number, number];
  positions?: { pageNumber: number; top: number }[];
}

interface ContributorCells {
  name: TextCell;
  type: TextCell;
  badges: { columns: Content[]; margin?: [number, number, number, number] };
}

function contributorCells(rows: Contributor[], offsets?: number[][]): ContributorCells[] {
  return rows.map((row, index) => {
    const textCell = (text: string, column: number): TextCell => ({
      text, font: "Helvetica", fontSize: 9, lineHeight: 1,
      margin: [0, offsets?.[index]?.[column] ?? 0, 0, 0],
    });
    return {
      name: textCell(row.name, 0),
      type: textCell(row.memberType.description, 1),
      badges: {
        columns: row.months.flatMap((present, month) => present ? [monthBadge(monthLabels[month])] : []),
        margin: [0, offsets?.[index]?.[2] ?? 0, 0, 0],
      },
    };
  });
}

function monthBadge(label: string): Content {
  return {
    width: 25,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="25" height="15"><rect width="23" height="15" rx="4" fill="#17365d"/><text x="11.5" y="10.5" text-anchor="middle" fill="#ffffff" font-family="Helvetica" font-size="8">${label}</text></svg>`,
  };
}

function contributor(row: ContributorRow): Contributor {
  const months = new Set(row.contributed_months);
  return {
    id: row.id,
    name: row.name,
    memberType: { id: row.type_id, description: row.type_description },
    months: monthLabels.map((_, index) => months.has(index + 1)),
  };
}

function buildContributorsDocument(header: Header, issuer: string, year: string, rows: ContributorCells[], generatedAt: Date): TDocumentDefinitions {
  const content: Content[] = reportHeader(header, "Relatório de membros contribuintes", year, issuer, generatedAt);
  if (!rows.length) {
    content.push({ text: "Nenhum contribuinte no período." });
  } else {
    const body: TableCell[][] = [[
      { text: "Nome", bold: true }, { text: "Tipo", bold: true }, { text: "Meses", bold: true },
    ]];
    for (const row of rows) body.push([row.name, row.type, row.badges]);
    content.push({
      table: { headerRows: 1, dontBreakRows: true, widths: ["*", 75, 300], body },
      layout: "lightHorizontalLines",
    });
  }
  return reportLayout(content);
}

export async function contributorsDocument(
  header: Header, issuer: string, year: string, rows: Contributor[], generatedAt: Date,
): Promise<TDocumentDefinitions> {
  if (!rows.length) return buildContributorsDocument(header, issuer, year, [], generatedAt);
  const measured = contributorCells(rows);
  // pdfmake does not vertically align cells, so measure wrapped lines before the final layout.
  await renderReport(buildContributorsDocument(header, issuer, year, measured, generatedAt));
  const offsets = measured.map(({ name, type, badges }) => {
    if ((!name.positions?.length && name.text.trim()) || (!type.positions?.length && type.text.trim())) {
      throw new InternalServerErrorException("Não foi possível medir as linhas do relatório de contribuintes.");
    }
    const heights = [(name.positions?.length ?? 0) * textLineHeight, (type.positions?.length ?? 0) * textLineHeight, badges.columns.length ? badgeHeight : 0];
    const rowHeight = Math.max(...heights);
    return heights.map((height) => (rowHeight - height) / 2);
  });
  return buildContributorsDocument(header, issuer, year, contributorCells(rows, offsets), generatedAt);
}

@Injectable()
export class ContributorsService {
  constructor(private readonly transactions: TenantTransactions, private readonly logos: LogoService) {}

  list(tenantId: string, userId: string, query: ContributorYearQueryDto) {
    const pagination = parsePagination({ ...query, order: query.order ?? "asc" }, ["name", "type"]);
    return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
      const filtered = this.filtered(tenantId, query);
      const ordering = this.ordering(query);
      const result = await sql<ContributorRow & { total: string }>`
        with filtered as (${filtered}),
        paged as (
          select * from filtered order by ${ordering}
           limit ${pagination.pageSize} offset ${pagination.offset}
        )
        select paged.*, totals.total
          from (select count(*)::text as total from filtered) totals
          left join paged on true
         order by ${ordering}
      `.execute(trx);
      const total = result.rows[0]?.total;
      if (total === undefined) throw new InternalServerErrorException({ code: "INTERNAL" });
      return pageResponse(result.rows.filter((row) => row.id !== null).map(contributor), Number(total), pagination);
    });
  }

  async report(tenantId: string, user: AuthenticatedUser, query: ContributorReportQueryDto): Promise<Buffer> {
    const { header, rows } = await this.transactions.withTenantTx({ tenantId, userId: user.userId }, async (trx) => {
      const headers = await sql<Header>`
        select t.name, t.document, t.timezone, up.display_name
          from tenants t left join user_profiles up on up.user_id = ${user.userId}::uuid
         where t.id = ${tenantId}::uuid
      `.execute(trx);
      const header = headers.rows[0];
      if (!header) throw new InternalServerErrorException({ code: "INTERNAL" });
      const rows = await this.findAll(trx, tenantId, query);
      return { header, rows };
    });
    const logo = await this.logos.getForReport(tenantId, user.userId);
    return renderReport(await contributorsDocument({ ...header, logo }, header.display_name || user.email || user.userId, query.year, rows, new Date()));
  }

  private async findAll(trx: Kysely<Database>, tenantId: string, query: ContributorReportQueryDto): Promise<Contributor[]> {
    const result = await sql<ContributorRow>`
      with filtered as (${this.filtered(tenantId, query)})
      select * from filtered order by ${this.ordering(query)}
    `.execute(trx);
    return result.rows.map(contributor);
  }

  private filtered(tenantId: string, query: ContributorReportQueryDto) {
    const start = `${query.year}-01-01`;
    const end = `${String(Number(query.year) + 1).padStart(4, "0")}-01-01`;
    const search = query.q || null;
    return sql`
      select m.id, m.name, mt.id as type_id, mt.description as type_description,
             array_agg(distinct extract(month from c.occurred_on)::int) as contributed_months
        from contributions c
        join members m on m.tenant_id = c.tenant_id and m.id = c.member_id
        join member_types mt on mt.tenant_id = m.tenant_id and mt.id = m.member_type_id
        join contribution_types ct on ct.tenant_id = c.tenant_id and ct.id = c.contribution_type_id
       where c.tenant_id = ${tenantId}::uuid and c.status = 'ACTIVE'
         and m.deleted_at is null and ct.counts_as_contributor
         and c.occurred_on >= ${start}::date and c.occurred_on < ${end}::date
         and (${search}::text is null or app_norm(m.name) like '%' || app_norm(${search}::text) || '%')
       group by m.id, m.name, mt.id, mt.description
    `;
  }

  private ordering(query: ContributorReportQueryDto) {
    const column = query.sort === "type" ? "type_description" : "name";
    const direction = query.order === "desc" ? "desc" : "asc";
    return sql.raw(`${column} ${direction}, id ${direction}`);
  }
}
