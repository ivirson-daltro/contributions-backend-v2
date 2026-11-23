# Documentação Técnica - Endpoints de Edição e Exclusão

## 📋 Índice
1. [Arquitetura](#arquitetura)
2. [DTOs e Schemas](#dtos-e-schemas)
3. [Fluxo de Requisição](#fluxo-de-requisição)
4. [Validações](#validações)
5. [Tratamento de Erros](#tratamento-de-erros)
6. [Transações e Locking](#transações-e-locking)
7. [Auditoria](#auditoria)
8. [Snapshots](#snapshots)
9. [Performance](#performance)

---

## 🏗️ Arquitetura

### Camadas da Aplicação

```
Controller (contributionsController)
    ↓
DTOs (UpdateContributionDto, DeleteContributionDto)
    ↓
Service (ContributionsService)
    ↓
Database (Kyse ORM + PostgreSQL)
    ↓
Audit (AuditService)
```

### Componentes Principais

#### 1. **Controller** (`contributions.controller.ts`)
- Endpoints HTTP
- Validação de headers (x-tenant-id, Authorization)
- OpenAPI/Swagger documentation
- Roteamento de requisições

#### 2. **DTOs** (`contributions.dto.ts`)
- Zod schemas para validação
- Conversão de tipos with `createZodDto`
- Validações declarativas (refine, checks)

#### 3. **Service** (`contributions.service.ts`)
- Lógica de negócio
- Transações ACID
- Validações de regras de negócio
- Integração com auditoria

---

## 🧩 DTOs e Schemas

### UpdateContributionDto

**Arquivo**: `contributions.dto.ts`

```typescript
export const updateContributionSchema = z
  .object({
    contributionTypeId: uuid.optional(),
    paymentMethodId: uuid.optional(),
    memberId: uuid.nullable().optional(),
    amount: z.string()
      .regex(/^\d{1,12}(\.\d{1,2})?$/)
      .refine((value) => /[1-9]/.test(value), "O valor deve ser positivo.")
      .optional(),
    occurredOn: date.optional(),
    observation: z.string().trim().max(2000).nullable().optional(),
    version: z.number().int().positive(), // ← Obrigatório
  })
  .strict()
  .refine((value) => Object.keys(value).length > 1, {
    message: "Pelo menos um campo deve ser atualizado além da versão.",
  });

export class UpdateContributionDto extends createZodDto(updateContributionSchema) {}
```

**Regras de Validação Zod:**
- `uuid.optional()`: UUID válido ou ausente
- `z.number().int().positive()`: Número inteiro positivo para versão
- `.strict()`: Nenhum campo extra permitido
- `.refine()`: Validação customizada (pelo menos um campo além de version)
- `.nullable()`: Pode ser null (para memberId)

### DeleteContributionDto

```typescript
export const deleteContributionSchema = z
  .object({
    voidReason: z.string().trim().max(2000).optional(),
    version: z.number().int().positive(),
  })
  .strict();

export class DeleteContributionDto extends createZodDto(deleteContributionSchema) {}
```

---

## 🔄 Fluxo de Requisição

### PUT /contributions/:id (Edição)

```
1. Request chega em ContributionsController.update()
   ├─ @Param("id"): extrai ID da URL
   ├─ @Body(): deserializa e valida JSON com UpdateContributionDto
   ├─ @CurrentUser(): extrai usuário autenticado
   ├─ @CurrentTenant(): extrai tenant do header x-tenant-id
   └─ @RequirePermissions("contributions:write"): verifica permissão

2. Controller passa para ContributionsService.update()
   
3. Service inicia transação com TenantTransactions
   
4. Dentro da transação (READ LOCK):
   ├─ Busca contribuição existente com FOR UPDATE (bloqueia)
   ├─ Valida status (não pode ser VOIDED)
   ├─ Valida versão (match obrigatório)
   │
   ├─ Se alguma validação falha → Rollback + erro HTTP
   └─ Se OK → continua
   
5. Validações de negócio:
   ├─ Verifica tipo de contribuição (exists, active, requires_member)
   ├─ Verifica meio de pagamento (exists, active)
   ├─ Verifica membro se obrigatório (exists, active, not deleted)
   ├─ Verifica data futura (se bloqueado)
   ├─ Verifica período fechado (mês encerrado)
   │
   └─ Se falha → Rollback + erro HTTP 422/409
   
6. Se OK → UPDATE na tabela contributions
   ├─ Atualiza campos mutáveis
   ├─ Incrementa version += 1
   ├─ Seta updated_by = userId
   ├─ Seta updated_at = now()
   └─ NOT altered: category_snapshot, kind_snapshot
   
7. Busca attachments count para response
   
8. Registra na auditoria (AuditService)
   ├─ action: CONTRIBUTION_UPDATED
   ├─ before: dados anteriores
   └─ after: dados novos
   
9. Commit da transação
   
10. Response HTTP 200 OK com dados atualizados
```

### DELETE /contributions/:id (Anulação)

```
1. Request chega em ContributionsController.delete()
   ├─ @Param("id"): extrai ID da URL
   ├─ @Body(): deserializa e valida JSON com DeleteContributionDto
   ├─ @CurrentUser(): extrai usuário autenticado
   ├─ @CurrentTenant(): extrai tenant do header x-tenant-id
   └─ @RequirePermissions("contributions:write"): verifica permissão

2. Controller passa para ContributionsService.void()
   
3. Service inicia transação com TenantTransactions
   
4. Dentro da transação (READ LOCK):
   ├─ Busca contribuição existente com FOR UPDATE (bloqueia)
   ├─ Valida status (não pode ser VOIDED já)
   ├─ Valida versão (match obrigatório)
   │
   └─ Se falha → Rollback + erro HTTP
   
5. Se OK → UPDATE na tabela contributions
   ├─ seta status = 'VOIDED'
   ├─ seta void_reason = payload.voidReason (ou null)
   ├─ seta voided_at = now() (automaticamente via trigger se houver)
   ├─ seta voided_by = userId
   ├─ incrementa version += 1
   ├─ seta updated_by = userId
   ├─ seta updated_at = now()
   │
   └─ NOT altered: category_snapshot, kind_snapshot, amount, etc
   
6. Registra na auditoria (AuditService)
   ├─ action: CONTRIBUTION_VOIDED
   └─ after: { status: 'VOIDED', voidReason: ... }
   
7. Commit da transação
   
8. Response HTTP 200 OK com { id, status, voidReason }
```

---

## ✅ Validações

### Validações de Entrada (Zod)
- ✅ UUID válido (contributionTypeId, paymentMethodId, memberId)
- ✅ Amount: regex positivo, sem zeros à esquerda
- ✅ Date: formato AAAA-MM-DD
- ✅ Observation: máximo 2000 caracteres
- ✅ Version: número inteiro positivo
- ✅ VoidReason: máximo 2000 caracteres

### Validações de Negócio
- ✅ Contribuição existe (404 se não)
- ✅ Contribuição não está VOIDED (409 se está)
- ✅ Versão corresponde (409 se não)
- ✅ Tipo de contribuição ativo e existe (422 se não)
- ✅ Meio de pagamento ativo e existe (422 se não)
- ✅ Membro obrigatório presente (422 se não)
- ✅ Membro está ativo e não deletado (422 se não)
- ✅ Data não é futura (se bloqueado no tenant)
- ✅ Período não está fechado (409 se está)

### Validações de Autorização
- ✅ Usuário autenticado
- ✅ Token Bearer válido
- ✅ Tenant ID válido e user tem acesso
- ✅ Usuário tem permissão `contributions:write`

---

## 🚨 Tratamento de Erros

### HTTP Status Codes

| Status | Situação | DTO/Zod |
|--------|----------|---------|
| **200 OK** | PUT/DELETE sucesso | ✅ |
| **400 Bad Request** | JSON malformado | ❌ |
| **401 Unauthorized** | Token ausente/inválido | ❌ |
| **403 Forbidden** | Sem permissão `contributions:write` | ❌ |
| **404 Not Found** | Contribution não existe | ✅ |
| **409 Conflict** | Versão desatualizada, já VOIDED, período fechado | ✅ |
| **422 Unprocessable Entity** | Tipo/membro/método inválido | ✅ |
| **500 Internal Server Error** | Erro não esperado no banco/transação | ❌ |

### Códigos de Erro (codes)

**Update (PUT):**
- `VERSION_MISMATCH`: Versão enviada ≠ versão no banco
- `CONTRIBUTION_VOIDED`: Contribuição já foi anulada
- `INVALID_REFERENCE`: Tipo, método ou membro inválido/inativo
- `MEMBER_REQUIRED`: Tipo requer membro, mas não foi fornecido
- `FUTURE_DATE_NOT_ALLOWED`: Data no futuro bloqueada
- `MONTH_CLOSED`: Período/mês encerrado

**Delete (DELETE):**
- `VERSION_MISMATCH`: Versão enviada ≠ versão no banco
- `ALREADY_VOIDED`: Já foi anulada
- `CONTRIBUTION_NOT_FOUND`: ID não existe

### Exemplo de Resposta de Erro

```json
{
  "statusCode": 409,
  "code": "VERSION_MISMATCH",
  "message": "Versão desatualizada. Recarregue os dados."
}
```

---

## 🔐 Transações e Locking

### Isolamento SERIALIZABLE

```typescript
return this.transactions.withTenantTx({ tenantId, userId }, async (trx) => {
  // Todas as operações dentro desta função rodam em uma transação
  // Isolamento: SERIALIZABLE (padrão do projeto)
});
```

### READ LOCK com FOR UPDATE

```sql
select c.id, c.status, c.version, ...
  from contributions c
  ...
 where c.tenant_id = $1::uuid and c.id = $2::uuid
   for update  -- ← Bloqueia a linha até fim da transação
```

**Comportamento:**
1. Thread A faz SELECT ... FOR UPDATE
2. Thread B tenta SELECT ... FOR UPDATE na mesma linha
   - Thread B aguarda até Thread A fazer COMMIT/ROLLBACK
3. Se versão não corresponder:
   - Thread A faz ROLLBACK
   - Thread B recebe erro 409 Conflict

### Concorrência Otimista (Optimistic Locking)

```
Cliente A:
  GET → version: 1

Cliente B:
  GET → version: 1

Cliente B:
  PUT com version: 1 → Sucesso, novo version: 2

Cliente A:
  PUT com version: 1 → Falha! 409 Conflict (versão desatualizada)
  
Cliente A:
  GET → version: 2 (recarrega)
  PUT com version: 2 → Sucesso, novo version: 3
```

---

## 📝 Auditoria

### Registros Criados

#### Para UPDATE:
```sql
INSERT INTO audit_logs (
  tenant_id,
  entity,
  entity_id,
  action,
  created_by,
  before_data,
  after_data,
  created_at
) VALUES (
  $1,                            -- tenant_id
  'contribution',                -- entity
  $2,                            -- entity_id
  'CONTRIBUTION_UPDATED',        -- action
  $3,                            -- created_by (userId)
  jsonb_set(...),                -- before_data com estado anterior
  jsonb_set(...),                -- after_data com estado novo
  now()
);
```

#### Para DELETE:
```sql
INSERT INTO audit_logs (
  tenant_id,
  entity,
  entity_id,
  action,
  created_by,
  after_data,
  created_at
) VALUES (
  $1,                            -- tenant_id
  'contribution',                -- entity
  $2,                            -- entity_id
  'CONTRIBUTION_VOIDED',         -- action
  $3,                            -- created_by (userId)
  {'status': 'VOIDED', 'voidReason': '...'},
  now()
);
```

### Rastreamento via Contribuição

```sql
-- Ver quem editou por último
SELECT updated_by, updated_at FROM contributions WHERE id = $1;

-- Ver histórico de versões
SELECT version, updated_at, updated_by FROM contributions WHERE id = $1;
```

---

## 📸 Snapshots

### Imutáveis

```
Contribuição criada:
  category_snapshot = 'TITHE'          (capturado do tipo no momento)
  kind_snapshot = 'PIX'                (capturado do método no momento)

Após edição:
  category_snapshot = 'TITHE'          (NÃO MUDA)
  kind_snapshot = 'PIX'                (NÃO MUDA)
  
  contribution_type_id = novo_tipo_uuid (pode mudar)
  payment_method_id = novo_metodo_uuid (pode mudar)
```

**Razão**: Relatórios e auditoria precisam mostrar qual era a categoria/tipo no momento do lançamento, não depois que foi editado.

---

## ⚡ Performance

### Índices Utilizados

```sql
-- Busca principal (SELECT ... FOR UPDATE)
CREATE INDEX contributions_tenant_date_idx 
  ON contributions (tenant_id, occurred_on DESC) 
  WHERE status = 'ACTIVE';

CREATE INDEX contributions_updated_by_idx 
  ON contributions (tenant_id, updated_by);
```

### Complexidade

| Operação | Tempo | Query Plan |
|----------|-------|-----------|
| SELECT for update | O(1) | Index + FOR UPDATE lock |
| Validar tipo | O(1) | Index + FOR SHARE |
| Validar método | O(1) | Index + FOR SHARE |
| Validar membro | O(1) | Index + FOR SHARE |
| UPDATE | O(1) | Direct update |
| Registrar auditoria | O(1) | Insert |
| **Total** | **O(1)** | Constant |

### Conexão com Pool

```typescript
// Pool gerenciado por TenantTransactions
this.transactions.withTenantTx(
  { tenantId, userId },
  async (trx) => {
    // 'trx' é uma conexão do pool
    // Automaticamente retornada ao pool após Promise
  }
);
```

---

## 🔗 Integração com Arquitetura

### Decoradores

```typescript
@Put("contributions/:id")
@RequirePermissions("contributions:write")  // ← Autorização
// @RequireMfa()  // ← Se configurado
export async update(...) {
  // Controller
}
```

### Middleware de Tenant

```typescript
// Injeta tenant do header x-tenant-id
@CurrentTenant()
tenant: TenantRequestContext

// Valida tenant_id contra permissões do usuário
// Falha com 403 se inválido
```

### Auditoria Automática

```typescript
// AuditService gerencia persistência
await this.audit.record(trx, {
  action: "CONTRIBUTION_UPDATED",
  entity: "contribution",
  entityId: id,
  before: { ... },
  after: { ... }
});
```

---

## 🧪 Testes Sugeridos

### Unit Tests (Service)
```typescript
describe('ContributionsService.update', () => {
  it('should update amount and increment version', async () => {
    // Mock database
    // Call service.update()
    // Assert version incremented
  });
  
  it('should reject with VERSION_MISMATCH if version differs', async () => {
    // Setup: existing version 2
    // Call with version 1
    // Assert ConflictException
  });
  
  it('should reject if contribution is VOIDED', async () => {
    // Setup: status VOIDED
    // Call update
    // Assert ConflictException
  });
});
```

### Integration Tests (Controller)
```typescript
describe('PUT /contributions/:id', () => {
  it('should return 200 with updated data', async () => {
    // Create contribution
    // PUT with valid data
    // Assert 200, version incremented
  });
  
  it('should return 409 Conflict on version mismatch', async () => {
    // Create contribution
    // PUT with wrong version
    // Assert 409 Conflict
  });
});
```

---

