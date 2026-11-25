import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { sql } from "kysely";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import { AuthenticatedUser } from "../../common/auth/authenticated-user";
import { TenantTransactions } from "../../common/database/database.module";
import { renderReport, reportHeader, reportLayout, reportSignatures, reportSummary } from "../../common/pdf/report-layout";
import { contributionsReportSignaturesConfig } from "../../common/pdf/report-signatures-config";
import { ContributionReportQueryDto } from "./contributions.dto";
import { LogoService } from "../settings/logo.service";

interface ReportHeader {
  name: string;
  document: string | null;
  timezone: string;
  display_name: string | null;
  logo?: string | null;
}

export interface ReportRow {
  occurred_on: string;
  member_name: string | null;
  type_description: string;
  method_id: string;
  method_description: string;
  kind: string;
  category: string;
  amount: string;
}

const kindNames: Record<string, string> = {
  PIX: "Pix", CASH: "Dinheiro", CARD: "Cartão",
  TRANSFER: "Transferência", CHECK: "Cheque", OTHER: "Outros",
};
const categoryNames: Record<string, string> = {
  TITHE: "Dízimos", OFFERING: "Ofertas", CONSTRUCTION_OFFERING: "Oferta de construção",
  MISSIONS: "Missões", INCOME: "Rendimentos", OTHER: "Outros",
};

function cents(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function money(value: bigint): string {
  const whole = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${whole},${(value % 100n).toString().padStart(2, "0")}`;
}

function dateLabel(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

export function reportDocument(
  header: ReportHeader,
  issuer: string,
  query: ContributionReportQueryDto,
  rows: ReportRow[],
  generatedAt: Date,
): TDocumentDefinitions {
  const groups = new Map<string, { name: string; rows: ReportRow[]; total: bigint }>();
  const kinds = new Map<string, bigint>();
  const categories = new Map<string, bigint>();
  let total = 0n;
  for (const row of rows) {
    const value = cents(row.amount);
    total += value;
    kinds.set(row.kind, (kinds.get(row.kind) ?? 0n) + value);
    categories.set(row.category, (categories.get(row.category) ?? 0n) + value);
    let group = groups.get(row.method_id);
    if (!group) {
      group = { name: row.method_description, rows: [], total: 0n };
      groups.set(row.method_id, group);
    }
    group.rows.push(row);
    group.total += value;
  }

  const content: Content[] = reportHeader(
    header, "Relatório de contribuições",
    `${dateLabel(query.from)} a ${dateLabel(query.to)}`, issuer, generatedAt,
  );

  if (!rows.length) {
    content.push({ text: "Sem contribuições no período", margin: [0, 8, 0, 12] });
  } else {
    const body: TableCell[][] = [[
      { text: "Data", bold: true }, { text: "Membro", bold: true },
      { text: "Tipo", bold: true }, { text: "Pagamento", bold: true },
      { text: "Valor", bold: true, alignment: "right" },
    ]];
    const separators = new Set<number>([1]);
    for (const group of groups.values()) {
      separators.add(body.length);
      body.push([
        { text: group.name, bold: true, fillColor: "#eeeeee", colSpan: 5 },
        {}, {}, {}, {},
      ]);
      separators.add(body.length);
      for (const row of group.rows) {
        body.push([
          dateLabel(row.occurred_on), row.member_name ?? "Não informado",
          row.type_description, kindNames[row.kind] ?? row.kind,
          { text: money(cents(row.amount)), alignment: "right" },
        ]);
      }
      separators.add(body.length);
      body.push([
        { text: "Subtotal", bold: true, colSpan: 4 }, {}, {}, {},
        { text: money(group.total), bold: true, alignment: "right" },
      ]);
      separators.add(body.length);
    }
    content.push({
      table: { headerRows: 1, widths: [55, "*", "*", 75, 75], body },
      layout: {
        hLineWidth: (index) => separators.has(index) ? 0.6 : 0,
        vLineWidth: () => 0,
        paddingLeft: () => 4,
        paddingRight: () => 4,
        paddingTop: () => 3,
        paddingBottom: () => 3,
      },
    });
  }
  const destinations = new Set(["CONSTRUCTION_OFFERING", "MISSIONS"]);
  const categoryEntries = [...categories].map(([category, value]) => ({
    category, label: categoryNames[category] ?? category, value: money(value),
  }));
  content.push(
    {
      table: {
        widths: ["*", "auto"],
        body: [[
          { text: "Total geral", bold: true, fontSize: 11 },
          { text: money(total), bold: true, fontSize: 11, alignment: "right", noWrap: true },
        ]],
      },
      layout: {
        hLineWidth: () => 0.8,
        vLineWidth: () => 0,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 4,
        paddingBottom: () => 4,
      },
      margin: [0, 10, 0, 10],
    },
    reportSummary([
      { title: "ENTRADAS", entries: [...kinds].map(([kind, value]) => ({
        label: kindNames[kind] ?? kind, value: money(value),
      })) },
      { title: "CONTRIBUIÇÕES", entries: categoryEntries.filter(({ category }) => !destinations.has(category)) },
      { title: "DESTINAÇÃO", entries: categoryEntries.filter(({ category }) => destinations.has(category)) },
    ]),
  );
  content.push(...reportSignatures(contributionsReportSignaturesConfig.rows));
  return reportLayout(content);
}

@Injectable()
export class ContributionsReportService {
  constructor(private readonly transactions: TenantTransactions, private readonly logos: LogoService) {}

  async generate(tenantId: string, user: AuthenticatedUser, query: ContributionReportQueryDto): Promise<Buffer> {
    const { header, rows } = await this.transactions.withTenantTx(
      { tenantId, userId: user.userId },
      async (trx) => {
        const headers = await sql<ReportHeader>`
          select t.name, t.document, t.timezone, up.display_name
            from tenants t
            left join user_profiles up on up.user_id = ${user.userId}::uuid
           where t.id = ${tenantId}::uuid
        `.execute(trx);
        const header = headers.rows[0];
        if (!header) throw new InternalServerErrorException({ code: "INTERNAL" });
        const result = await sql<ReportRow>`
          select to_char(c.occurred_on, 'YYYY-MM-DD') as occurred_on,
                 m.name as member_name, ct.description as type_description,
                 pm.id as method_id, pm.description as method_description,
                 coalesce(c.kind_snapshot, pm.kind, 'OTHER') as kind, c.category_snapshot as category,
                 c.amount::text as amount
            from contributions c
            join contribution_types ct on ct.tenant_id = c.tenant_id and ct.id = c.contribution_type_id
            join payment_methods pm on pm.tenant_id = c.tenant_id and pm.id = c.payment_method_id
            left join members m on m.tenant_id = c.tenant_id and m.id = c.member_id
           where c.tenant_id = ${tenantId}::uuid and c.status = 'ACTIVE'
             and c.occurred_on >= ${query.from}::date and c.occurred_on <= ${query.to}::date
           order by pm.description, pm.id, c.occurred_on, c.id
        `.execute(trx);
        return { header, rows: result.rows };
      },
    );
    const logo = await this.logos.getForReport(tenantId, user.userId);
    const definition = reportDocument({ ...header, logo }, header.display_name || user.email || user.userId, query, rows, new Date());
    return renderReport(definition);
  }
}
