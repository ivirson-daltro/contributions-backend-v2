# 🔧 Correção: FOR UPDATE com LEFT JOIN

## Problema

Ao tentar editar o meio de pagamento de uma contribuição, o erro abaixo era retornado:

```
error: 'FOR UPDATE cannot be applied to the nullable side of an outer join'
```

## Causa Raiz

No PostgreSQL, quando você usa `FOR UPDATE` em um SELECT que contém LEFT JOIN, o banco não permite aplicar lock diretamente. Isso ocorre porque:

1. `LEFT JOIN` cria um "outer join" (junção externa)
2. `FOR UPDATE` sem especificação de tabela tenta bloquear TODAS as tabelas
3. PostgreSQL não pode bloquear as linhas do LEFT JOIN (nullable)

**Código problemático:**
```sql
select c.id, c.status, ...
  from contributions c
  join contribution_types ct on ...
  join payment_methods pm on ...
  left join members m on ...  -- ← nullable
 where c.tenant_id = $1::uuid and c.id = $2::uuid
   for update  -- ← Ambíguo! Qual tabela bloquear?
```

## Solução

Especificar explicitamente qual tabela deve ser bloqueada usando `FOR UPDATE OF`:

```sql
select c.id, c.status, ...
  from contributions c
  join contribution_types ct on ...
  join payment_methods pm on ...
  left join members m on ...
 where c.tenant_id = $1::uuid and c.id = $2::uuid
   for update of c  -- ← Bloqueia APENAS contributions
```

## Mudanças Realizadas

### Método `update()` - Linha 377

**Antes:**
```typescript
for update
```

**Depois:**
```typescript
for update of c
```

Onde `c` é o alias para a tabela `contributions`.

### Método `void()` - Linha 512

**Antes:**
```typescript
for update
```

**Depois:**
```typescript
for update of contributions
```

## Por Que Funciona

- `FOR UPDATE OF c` bloqueia apenas as linhas da tabela `contributions`
- As outras tabelas (tipos, métodos, membros) não são bloqueadas
- PostgreSQL permite isso porque as outras tabelas vêm de INNER JOINs (required) ou LEFT JOINs (nullable)
- O LEFT JOIN de members é permitido porque não estamos tentando bloqueá-lo

## Verificação

✅ Build: `npm run build` → Sucesso  
✅ Type-check: `npm run typecheck` → Sucesso  
✅ Lint: `npm run lint` → Sucesso  

## Teste

Agora é possível editar o meio de pagamento sem erro:

```bash
PUT /v1/contributions/{id}
{
  "paymentMethodId": "novo-id-uuid",
  "version": 1
}
```

## Commits

```
a95e65b fix: correct FOR UPDATE clause in contribution queries
```

## Referências

- PostgreSQL FOR UPDATE documentation: https://www.postgresql.org/docs/current/sql-select.html
- Kyse ORM documentation: https://github.com/koskimas/kysely

## 📌 Notas

- Essa correção não afeta a lógica de negócio
- O versionamento otimista continua funcionando
- Transações ACID ainda garantidas
- Performance não é afetada (mesmo número de locks)
