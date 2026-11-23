# Correção: Pagamentos em Dinheiro retornando como "Outros" no Relatório PDF

## Problema Identificado

O relatório PDF estava retornando "Outros" para pagamentos em dinheiro porque:

1. A coluna `kind_snapshot` na tabela `contributions` estava NULL para contribuições antigas
2. A coluna `kind` na tabela `payment_methods` podia estar NULL em alguns casos
3. A query do relatório não tinha fallback adequado para valores NULL

## Solução Implementada

### 1. Código Corrigido

Foram alterados os seguintes arquivos:

#### `src/modules/contributions/contributions-report.service.ts`
- Alterada a query para usar `coalesce(c.kind_snapshot, pm.kind, 'OTHER')` em vez de apenas `pm.kind`
- Isso garante que sempre retornará um valor válido, mesmo se ambos forem NULL

#### `src/modules/contributions/contributions.service.ts`
- Adicionado `coalesce(kind, 'OTHER')` nas queries que obtêm dados de `payment_methods`
- Isso garante que o kind nunca seja NULL nas operações de criação de contribuições

### 2. Migrations do Banco de Dados

Foram criadas duas migrations:

#### `supabase/migrations/20261123102759_ensure_payment_methods_kind.sql`
- Garante que a coluna `kind` existe em `payment_methods`
- Atualiza qualquer registro com `kind = NULL` baseado na descrição
- Define `kind` como NOT NULL

#### `supabase/migrations/20261123102800_populate_kind_snapshot.sql`
- Popula `kind_snapshot` para contribuições antigas que têm NULL
- Atualiza qualquer NULL restante para 'OTHER' como fallback
- Define `kind_snapshot` como NOT NULL para prevenir futuros NULLs

### 3. Como Executar as Migrations

Execute as migrations do Supabase:

```bash
# Se estiver usando Supabase CLI local
supabase db push

# Ou se estiver usando Supabase Cloud
supabase db push --db-url postgresql://[user]:[password]@[host]:5432/[database]
```

## Resultado

Depois de executar as migrations:
- Pagamentos em "Dinheiro" aparecerão como "Dinheiro" no relatório
- Outros tipos de pagamento (Pix, Cartão, etc.) aparecerão com seus nomes corretos
- O sistema terá fallback para "Outros" apenas quando a informação estiver realmente indisponível

## Teste

Os testes unitários já foram validados e passam com sucesso:
✅ PDF usa dados ativos do tenant e datas inclusivas; mantém agrupamento e totais exatos
✅ Todos os 13 testes de contribuições passam
