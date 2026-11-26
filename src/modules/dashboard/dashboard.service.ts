import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { sql } from "kysely";
import { AuditService } from "../../common/audit/audit.service";
import { TenantTransactions } from "../../common/database/database.module";

type JsonAmounts = Record<string, string | number>;

export interface DashboardPayable {
  id: string;
  payableId: string;
  description: string | null;
  dueDate: string;
  expectedAmount: string | null;
}

interface DashboardSummaryRow {
  year: number;
  month: number;
  today: string;
  week_start: string;
  week_starts_on: number;
  income_week: string | number;
  income_previous_week: string | number;
  income_month: string | number;
  income_week_count: string | number;
  income_previous_week_count: string | number;
  income_month_count: string | number;
  expense_week: string | number;
  expense_month: string | number;
  expense_year: string | number;
  expense_week_count: string | number;
  expense_month_count: string | number;
  expense_year_count: string | number;
  kinds_week: JsonAmounts;
  kinds_previous_week: JsonAmounts;
  kinds_month: JsonAmounts;
  opening_balance: string | number | null;
  opening_defined: boolean;
  cash_on_hand: string | number | null;
  month_balance: string | number;
  final_balance: string | number | null;
  accumulated: string | number | null;
  active_members: string | number;
  contributors_month: string | number;
  construction_total: string | number;
  construction_count: string | number;
  overdue_count: string | number;
  next_7_days_count: string | number;
  next_7_days_amount: string | number;
  overdue_items: DashboardPayable[];
  next_7_days_items: DashboardPayable[];
}

interface DashboardSeriesRow {
  year: number;
  selected_year: number;
  month: number;
  income: string | number;
  expense: string | number;
  income_by_kind: JsonAmounts;
}

interface CachedResult {
  expiresAt: number;
  value: unknown;
}

const CACHE_TTL_MS = 60_000;
const PAYMENT_KINDS = ["CASH", "PIX", "CARD", "TRANSFER", "CHECK", "OTHER"];

@Injectable()
export class DashboardService {
  private readonly cache = new Map<string, CachedResult>();

  constructor(private readonly transactions: TenantTransactions, private readonly audit: AuditService) {}

  async updateCard(tenantId: string, userId: string, contributionTypeId: string | null) {
    return this.transactions.withTenantTx({ tenantId, userId }, async (transaction) => {
      const current = await sql<{ contribution_type_id: string | null }>`
        select dashboard_contribution_type_id as contribution_type_id
          from tenant_settings where tenant_id = ${tenantId}::uuid for update
      `.execute(transaction);
      if (!current.rows[0]) throw new NotFoundException({ code: "NOT_FOUND" });
      if (contributionTypeId) {
        const type = await sql<{ id: string }>`
          select id from contribution_types
           where tenant_id = ${tenantId}::uuid and id = ${contributionTypeId}::uuid and active
        `.execute(transaction);
        if (!type.rows[0]) throw new BadRequestException({ code: "INVALID_CONTRIBUTION_TYPE" });
      }
      await sql`
        update tenant_settings set dashboard_contribution_type_id = ${contributionTypeId}::uuid,
          updated_at = now() where tenant_id = ${tenantId}::uuid
      `.execute(transaction);
      await this.audit.record(transaction, {
        action: "DASHBOARD_CARD_UPDATED", entity: "tenant_settings", entityId: tenantId,
        before: { contributionTypeId: current.rows[0].contribution_type_id },
        after: { contributionTypeId },
      });
      return { contributionTypeId };
    });
  }

  private async getCustomCard(tenantId: string, userId: string) {
    return this.transactions.withTenantTx({ tenantId, userId }, async (transaction) => {
      const result = await sql<{
        contribution_type_id: string | null;
        contribution_type_name: string | null;
        total: string | null;
        contribution_types: { id: string; description: string }[];
      }>`
        select ts.dashboard_contribution_type_id as contribution_type_id,
               selected.description as contribution_type_name,
               case when selected.id is null then null else (
                 select coalesce(sum(c.amount), 0.00)::text
                   from contributions c
                   join tenants t on t.id = c.tenant_id
                  where c.tenant_id = ${tenantId}::uuid
                    and c.contribution_type_id = selected.id
                    and c.status = 'ACTIVE'
                    and c.occurred_on <= (now() at time zone t.timezone)::date
               ) end as total,
               (select coalesce(jsonb_agg(jsonb_build_object('id', ct.id, 'description', ct.description)
                                         order by ct.description, ct.id), '[]'::jsonb)
                  from contribution_types ct
                 where ct.tenant_id = ts.tenant_id and (ct.active or ct.id = selected.id)
               ) as contribution_types
          from tenant_settings ts
          left join contribution_types selected
            on selected.tenant_id = ts.tenant_id and selected.id = ts.dashboard_contribution_type_id
         where ts.tenant_id = ${tenantId}::uuid
      `.execute(transaction);
      const row = result.rows[0];
      if (!row) throw new InternalServerErrorException({ code: "DASHBOARD_CARD_UNAVAILABLE" });
      return {
        contributionTypeId: row.contribution_type_id,
        contributionTypeName: row.contribution_type_name,
        total: row.total,
        contributionTypes: row.contribution_types,
      };
    });
  }

  async getSummary(tenantId: string, userId: string, canReadPayables: boolean) {
    const summary = await this.cached(
      `${tenantId}:summary`,
      () =>
        this.transactions.withTenantTx({ tenantId, userId }, async (transaction) => {
          const result = await sql<DashboardSummaryRow>`
            with calendar as (
              select
                (now() at time zone t.timezone)::date as today,
                extract(year from now() at time zone t.timezone)::int as year,
                extract(month from now() at time zone t.timezone)::int as month,
                ts.week_starts_on,
                date_trunc('month', now() at time zone t.timezone)::date as month_start,
                make_date(
                  extract(year from now() at time zone t.timezone)::int,
                  1, 1
                ) as year_start,
                (
                  (now() at time zone t.timezone)::date
                  - (
                    (
                      extract(dow from (now() at time zone t.timezone)::date)::int
                      - ts.week_starts_on + 7
                    ) % 7
                  )
                ) as week_start
              from tenants t
              join tenant_settings ts on ts.tenant_id = t.id
              where t.id = ${tenantId}::uuid
            ),
            month_balance as (
              select mb.*
                from monthly_balances mb
                cross join calendar p
               where mb.tenant_id = ${tenantId}::uuid
                 and mb.year = p.year
                 and mb.month = p.month
            ),
            previous_balance as (
              select mb.*
                from monthly_balances mb
                cross join calendar p
               where mb.tenant_id = ${tenantId}::uuid
                 and make_date(mb.year, mb.month, 1) = p.month_start - interval '1 month'
                 and mb.closed_at is not null
            ),
            income_totals as (
              select
                coalesce(sum(c.amount) filter (
                  where c.occurred_on >= p.week_start and c.occurred_on <= p.today
                ), 0) as week,
                coalesce(sum(c.amount) filter (
                  where c.occurred_on >= p.week_start - 7 and c.occurred_on < p.week_start
                ), 0) as previous_week,
                coalesce(sum(c.amount) filter (
                  where c.occurred_on >= p.month_start and c.occurred_on <= p.today
                ), 0) as month,
                count(*) filter (
                  where c.occurred_on >= p.week_start and c.occurred_on <= p.today
                ) as week_count,
                count(*) filter (
                  where c.occurred_on >= p.week_start - 7 and c.occurred_on < p.week_start
                ) as previous_week_count,
                count(*) filter (
                  where c.occurred_on >= p.month_start and c.occurred_on <= p.today
                ) as month_count
              from calendar p
              left join contributions c
                on c.tenant_id = ${tenantId}::uuid
               and c.status = 'ACTIVE'
               and c.occurred_on >= least(p.month_start, p.week_start - 7)
               and c.occurred_on <= p.today
            ),
            expense_totals as (
              select
                coalesce(sum(e.amount) filter (
                  where e.occurred_on >= p.week_start and e.occurred_on <= p.today
                ), 0) as week,
                coalesce(sum(e.amount) filter (
                  where e.occurred_on >= p.month_start and e.occurred_on <= p.today
                ), 0) as month,
                coalesce(sum(e.amount) filter (
                  where e.occurred_on >= p.year_start and e.occurred_on <= p.today
                ), 0) as year,
                count(*) filter (
                  where e.occurred_on >= p.week_start and e.occurred_on <= p.today
                ) as week_count,
                count(*) filter (
                  where e.occurred_on >= p.month_start and e.occurred_on <= p.today
                ) as month_count,
                count(*) filter (
                  where e.occurred_on >= p.year_start and e.occurred_on <= p.today
                ) as year_count
              from calendar p
              left join expenses e
                on e.tenant_id = ${tenantId}::uuid
               and e.status = 'ACTIVE'
               and e.occurred_on >= p.year_start
               and e.occurred_on <= p.today
            ),
            kind_periods as (
              select 'week'::text as period, c.kind_snapshot, sum(c.amount) as amount
                from contributions c cross join calendar p
               where c.tenant_id = ${tenantId}::uuid and c.status = 'ACTIVE'
                 and c.occurred_on >= p.week_start and c.occurred_on <= p.today
               group by c.kind_snapshot
              union all
              select 'previousWeek', c.kind_snapshot, sum(c.amount)
                from contributions c cross join calendar p
               where c.tenant_id = ${tenantId}::uuid and c.status = 'ACTIVE'
                 and c.occurred_on >= p.week_start - 7 and c.occurred_on < p.week_start
               group by c.kind_snapshot
              union all
              select 'month', c.kind_snapshot, sum(c.amount)
                from contributions c cross join calendar p
               where c.tenant_id = ${tenantId}::uuid and c.status = 'ACTIVE'
                 and c.occurred_on >= p.month_start and c.occurred_on <= p.today
               group by c.kind_snapshot
            ),
            kind_maps as (
              select period, jsonb_object_agg(kind_snapshot, amount) as amounts
                from kind_periods
               group by period
            ),
            month_values as (
              select
                mb.opening_balance,
                (mb.id is not null or pb.closed_at is not null) as opening_defined,
                coalesce(
                  mb.opening_balance,
                  (pb.closing_snapshot->>'accumulated')::numeric
                ) as effective_opening,
                case when mb.closed_at is not null
                  then coalesce(
                    (mb.closing_snapshot->>'income')::numeric,
                    it.month
                  )
                  else it.month
                end as income,
                case when mb.closed_at is not null
                  then coalesce(
                    (mb.closing_snapshot->>'expense')::numeric,
                    et.month
                  )
                  else et.month
                end as expense,
                case when mb.closed_at is not null
                  then coalesce(
                    (mb.closing_snapshot->>'cash_on_hand')::numeric,
                    mb.cash_on_hand
                  )
                  else mb.cash_on_hand
                end as cash_on_hand,
                case when mb.closed_at is not null
                  then coalesce(
                    mb.closing_snapshot->'income_by_kind',
                    km.amounts,
                    '{}'::jsonb
                  )
                  else coalesce(km.amounts, '{}'::jsonb)
                end as month_kinds
              from calendar p
              cross join income_totals it
              cross join expense_totals et
              left join month_balance mb on true
              left join previous_balance pb on true
              left join kind_maps km on km.period = 'month'
            ),
            member_totals as (
              select
                (select count(*) from members m
                  where m.tenant_id = ${tenantId}::uuid
                    and m.status = 'ACTIVE' and m.deleted_at is null) as active_members,
                (select count(distinct c.member_id)
                   from contributions c
                   join members m on m.tenant_id = c.tenant_id and m.id = c.member_id
                   join contribution_types ct
                     on ct.tenant_id = c.tenant_id and ct.id = c.contribution_type_id
                   cross join calendar p
                  where c.tenant_id = ${tenantId}::uuid and c.status = 'ACTIVE'
                    and c.member_id is not null and m.deleted_at is null
                    and ct.counts_as_contributor
                    and c.occurred_on >= p.month_start and c.occurred_on <= p.today
                ) as contributors_month
            ),
            construction_totals as (
              select coalesce(sum(c.amount), 0) as total, count(*) as count
                from contributions c cross join calendar p
               where c.tenant_id = ${tenantId}::uuid and c.status = 'ACTIVE'
                 and c.category_snapshot = 'CONSTRUCTION_OFFERING'
                 and c.occurred_on >= p.month_start and c.occurred_on <= p.today
            ),
            payable_totals as (
              select
                count(*) filter (where o.due_date < p.today) as overdue_count,
                count(*) filter (
                  where o.due_date >= p.today and o.due_date <= p.today + 7
                ) as next_7_days_count,
                coalesce(sum(o.amount) filter (
                  where o.due_date >= p.today and o.due_date <= p.today + 7
                ), 0) as next_7_days_amount,
                coalesce(
                  jsonb_agg(jsonb_build_object(
                    'id', o.id,
                    'payableId', o.payable_id,
                    'description', payable.description,
                    'dueDate', o.due_date::text,
                    'expectedAmount', o.amount::text
                  ) order by o.due_date, o.id)
                    filter (where o.due_date < p.today),
                  '[]'::jsonb
                ) as overdue_items,
                coalesce(
                  jsonb_agg(jsonb_build_object(
                    'id', o.id,
                    'payableId', o.payable_id,
                    'description', payable.description,
                    'dueDate', o.due_date::text,
                    'expectedAmount', o.amount::text
                  ) order by o.due_date, o.id)
                    filter (where o.due_date >= p.today and o.due_date <= p.today + 7),
                  '[]'::jsonb
                ) as next_7_days_items
              from payable_occurrences o
              join payables payable
                on payable.tenant_id = o.tenant_id and payable.id = o.payable_id
              cross join calendar p
               where o.tenant_id = ${tenantId}::uuid and o.status = 'OPEN'
            )
            select
              p.year, p.month, p.today::text, p.week_start::text, p.week_starts_on,
              it.week as income_week,
              it.previous_week as income_previous_week,
              case when mb.closed_at is not null
                then (mb.closing_snapshot->>'income')::numeric
                else it.month
              end as income_month,
              it.week_count as income_week_count,
              it.previous_week_count as income_previous_week_count,
              case when mb.closed_at is not null
                then coalesce((mb.closing_snapshot->>'income_count')::bigint, it.month_count)
                else it.month_count
              end as income_month_count,
              et.week as expense_week,
              case when mb.closed_at is not null
                then (mb.closing_snapshot->>'expense')::numeric
                else et.month
              end as expense_month,
              et.year as expense_year,
              et.week_count as expense_week_count,
              case when mb.closed_at is not null
                then coalesce((mb.closing_snapshot->>'expense_count')::bigint, et.month_count)
                else et.month_count
              end as expense_month_count,
              et.year_count as expense_year_count,
              coalesce(week_kinds.amounts, '{}'::jsonb) as kinds_week,
              coalesce(previous_kinds.amounts, '{}'::jsonb) as kinds_previous_week,
              mv.month_kinds as kinds_month,
              mv.effective_opening as opening_balance,
              mv.opening_defined,
              mv.cash_on_hand,
              mv.income - mv.expense as month_balance,
              case when mv.cash_on_hand is not null
                then mv.income - mv.expense + mv.cash_on_hand
                else null
              end as final_balance,
              case when mv.opening_defined and mv.cash_on_hand is not null
                then mv.effective_opening + mv.income - mv.expense + mv.cash_on_hand
                else null
              end as accumulated,
              mt.active_members,
              mt.contributors_month,
              ct.total as construction_total,
              ct.count as construction_count,
              pt.overdue_count,
              pt.next_7_days_count,
              pt.next_7_days_amount,
              pt.overdue_items,
              pt.next_7_days_items
            from calendar p
            cross join income_totals it
            cross join expense_totals et
            cross join month_values mv
            cross join member_totals mt
            cross join construction_totals ct
            cross join payable_totals pt
            left join month_balance mb on true
            left join kind_maps week_kinds on week_kinds.period = 'week'
            left join kind_maps previous_kinds on previous_kinds.period = 'previousWeek'
          `.execute(transaction);

          const row = result.rows[0];
          if (!row) {
            throw new InternalServerErrorException({
              code: "DASHBOARD_SUMMARY_UNAVAILABLE",
            });
          }

          return {
            period: {
              year: Number(row.year),
              month: Number(row.month),
              today: row.today,
              weekStart: row.week_start,
              weekStartsOn: Number(row.week_starts_on),
            },
            income: {
              week: money(row.income_week),
              previousWeek: money(row.income_previous_week),
              month: money(row.income_month),
              weekCount: Number(row.income_week_count),
              previousWeekCount: Number(row.income_previous_week_count),
              monthCount: Number(row.income_month_count),
            },
            expense: {
              week: money(row.expense_week),
              month: money(row.expense_month),
              year: money(row.expense_year),
              weekCount: Number(row.expense_week_count),
              monthCount: Number(row.expense_month_count),
              yearCount: Number(row.expense_year_count),
            },
            balance: {
              month: money(row.month_balance),
              opening: row.opening_balance === null ? null : money(row.opening_balance),
              openingDefined: row.opening_defined,
              cashOnHand:
                row.cash_on_hand === null ? null : money(row.cash_on_hand),
              final:
                row.final_balance === null ? null : money(row.final_balance),
              accumulated:
                row.accumulated === null ? null : money(row.accumulated),
            },
            byKind: {
              week: row.kinds_week,
              previousWeek: row.kinds_previous_week,
              month: row.kinds_month,
            },
            members: {
              active: Number(row.active_members),
              contributorsMonth: Number(row.contributors_month),
            },
            constructionOffering: {
              total: money(row.construction_total),
              count: Number(row.construction_count),
            },
            payables: {
              overdueCount: Number(row.overdue_count),
              next7DaysCount: Number(row.next_7_days_count),
              next7DaysAmount: money(row.next_7_days_amount),
              overdue: row.overdue_items,
              next7Days: row.next_7_days_items,
            },
          };
        }),
    );
    const customCard = await this.getCustomCard(tenantId, userId);
    if (canReadPayables) return { ...summary, customCard };
    return {
      ...summary,
      customCard,
      payables: { ...summary.payables, overdue: null, next7Days: null },
    };
  }

  getSeries(tenantId: string, userId: string, year?: number) {
    return this.cached(
      `${tenantId}:series:${year ?? "current"}`,
      () =>
        this.transactions.withTenantTx({ tenantId, userId }, async (transaction) => {
          const result = await sql<DashboardSeriesRow>`
            with requested_year as (
              select coalesce(
                ${year ?? null}::int,
                extract(year from now() at time zone t.timezone)::int
              ) as selected_year
                from tenants t
               where t.id = ${tenantId}::uuid
            ),
            periods as (
              select y.year, m.month
                from requested_year r
                cross join lateral (
                  select r.selected_year as year
                  union all
                  select r.selected_year - 1
                ) y
                cross join generate_series(1, 12) as m(month)
            ),
            income_actual as (
              select extract(year from c.occurred_on)::int as year,
                     extract(month from c.occurred_on)::int as month,
                     sum(c.amount) as total
                from contributions c
                cross join requested_year r
               where c.tenant_id = ${tenantId}::uuid and c.status = 'ACTIVE'
                 and c.occurred_on >= make_date(r.selected_year - 1, 1, 1)
                 and c.occurred_on < make_date(r.selected_year + 1, 1, 1)
               group by 1, 2
            ),
            income_kinds as (
              select k.year, k.month,
                     jsonb_object_agg(k.kind_snapshot, k.total)
                       || jsonb_build_object(
                         'NON_PIX',
                         coalesce(sum(k.total) filter (where k.kind_snapshot <> 'PIX'), 0)
                       ) as amounts
                from (
                  select extract(year from c.occurred_on)::int as year,
                         extract(month from c.occurred_on)::int as month,
                         c.kind_snapshot,
                         sum(c.amount) as total
                    from contributions c
                    cross join requested_year r
                   where c.tenant_id = ${tenantId}::uuid and c.status = 'ACTIVE'
                     and c.occurred_on >= make_date(r.selected_year - 1, 1, 1)
                     and c.occurred_on < make_date(r.selected_year + 1, 1, 1)
                   group by 1, 2, c.kind_snapshot
                ) k
               group by k.year, k.month
            ),
            expense_actual as (
              select extract(year from e.occurred_on)::int as year,
                     extract(month from e.occurred_on)::int as month,
                     sum(e.amount) as total
                from expenses e
                cross join requested_year r
               where e.tenant_id = ${tenantId}::uuid and e.status = 'ACTIVE'
                 and e.occurred_on >= make_date(r.selected_year - 1, 1, 1)
                 and e.occurred_on < make_date(r.selected_year + 1, 1, 1)
               group by 1, 2
            )
            select p.year, r.selected_year, p.month,
                   coalesce(
                     (mb.closing_snapshot->>'income')::numeric,
                     ia.total,
                     0
                   ) as income,
                   coalesce(
                     (mb.closing_snapshot->>'expense')::numeric,
                     ea.total,
                     0
                   ) as expense,
                   case when mb.closed_at is not null then
                     coalesce(
                       mb.closing_snapshot->'income_by_kind',
                       '{}'::jsonb
                     ) || jsonb_build_object(
                       'NON_PIX',
                       (select coalesce(sum(amount::numeric), 0)
                          from jsonb_each_text(
                            coalesce(
                              mb.closing_snapshot->'income_by_kind',
                              '{}'::jsonb
                            )
                          ) as kind_totals(kind, amount)
                         where kind <> 'PIX')
                     )
                   else coalesce(ik.amounts, '{}'::jsonb)
                   end as income_by_kind
              from periods p
              cross join requested_year r
              left join monthly_balances mb
                on mb.tenant_id = ${tenantId}::uuid
               and mb.year = p.year and mb.month = p.month
               and mb.closed_at is not null
              left join income_actual ia on ia.year = p.year and ia.month = p.month
              left join income_kinds ik on ik.year = p.year and ik.month = p.month
              left join expense_actual ea on ea.year = p.year and ea.month = p.month
             order by p.year desc, p.month
          `.execute(transaction);

          const rows = result.rows;
          const selectedYear = Number(rows[0]?.selected_year);
          if (!Number.isInteger(selectedYear)) {
            throw new InternalServerErrorException({
              code: "DASHBOARD_SERIES_UNAVAILABLE",
            });
          }

          const current = rows.filter((row) => Number(row.year) === selectedYear);
          const previous = rows.filter(
            (row) => Number(row.year) === selectedYear - 1,
          );
          const byKind: Record<string, { current: string[]; previous: string[] }> =
            {};
          for (const kind of PAYMENT_KINDS) {
            byKind[kind] = {
              current: current.map((row) => money(row.income_by_kind[kind] ?? 0)),
              previous: previous.map((row) =>
                money(row.income_by_kind[kind] ?? 0),
              ),
            };
          }
          byKind.NON_PIX = {
            current: current.map((row) =>
              money(row.income_by_kind.NON_PIX ?? 0),
            ),
            previous: previous.map((row) =>
              money(row.income_by_kind.NON_PIX ?? 0),
            ),
          };

          return {
            year: selectedYear,
            income: {
              current: current.map((row) => money(row.income)),
              previous: previous.map((row) => money(row.income)),
              byKind,
            },
            expense: {
              current: current.map((row) => money(row.expense)),
              previous: previous.map((row) => money(row.expense)),
            },
          };
        }),
    );
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;

    const value = await load();
    const now = Date.now();
    for (const [cacheKey, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(cacheKey);
    }
    this.cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  }
}

function money(value: string | number): string {
  return typeof value === "number" ? value.toFixed(2) : value;
}
