# Implementação de Endpoints de Edição e Exclusão de Contribuições

## 📋 Resumo

Foram implementados dois novos endpoints RESTful para complementar as operações CRUD de contribuições, seguindo os padrões estabelecidos no projeto:

## ✨ Endpoints Implementados

### 1. **PUT /contributions/:id** - Editar Contribuição
- **Método HTTP**: PUT
- **Permissão**: `contributions:write`
- **Descrição**: Atualiza dados de uma contribuição existente

#### Campos Atualizáveis (todos opcionais, mas pelo menos um necessário):
- `contributionTypeId` - UUID do tipo de contribuição
- `paymentMethodId` - UUID do meio de pagamento
- `memberId` - UUID do membro (pode ser null)
- `amount` - Valor decimal positivo (ex: "850.00")
- `occurredOn` - Data da contribuição (AAAA-MM-DD)
- `observation` - Observação/nota (até 2000 caracteres)
- `version` - **Obrigatório** para controle de concorrência

#### Exemplo de Requisição:
```bash
PUT /contributions/00000000-0000-4000-8000-000000000001
{
  "amount": "900.00",
  "observation": "Atualizado",
  "version": 1
}
```

#### Respostas:
- **200 OK**: Contribuição atualizada com `version` incrementada
- **404 Not Found**: Contribuição não existe
- **409 Conflict**: Contribuição anulada, versão desatualizada, ou período fechado
- **422 Unprocessable Entity**: Dados inválidos

---

### 2. **DELETE /contributions/:id** - Anular Contribuição (Soft-Delete)
- **Método HTTP**: DELETE
- **Permissão**: `contributions:write`
- **Descrição**: Marca uma contribuição como VOIDED (exclusão lógica)

#### Campos:
- `version` - **Obrigatório** para controle de concorrência
- `voidReason` - Motivo opcional da anulação (até 2000 caracteres)

#### Exemplo de Requisição:
```bash
DELETE /contributions/00000000-0000-4000-8000-000000000001
{
  "voidReason": "Cancelado por engano",
  "version": 1
}
```

#### Respostas:
- **200 OK**: Contribuição anulada com sucesso
- **404 Not Found**: Contribuição não existe
- **409 Conflict**: Contribuição já anulada ou versão desatualizada

---

## 🔒 Segurança e Validações

### Controle de Concorrência (Optimistic Locking)
- Cada contribuição possui um campo `version` que incrementa a cada mudança
- Clientes devem enviar a versão atual na requisição
- Se versão não corresponder, server retorna **409 Conflict**
- Previne sobrescrita silenciosa de mudanças simultâneas

### Validações Implementadas
- ✅ Período não pode estar fechado (mês encerrado)
- ✅ Data futura bloqueada se configurado no tenant
- ✅ Membro obrigatório para certos tipos de contribuição
- ✅ Tipo, meio de pagamento e membro devem estar ativos
- ✅ Contribuição anulada não pode ser editada/revertida
- ✅ Valores devem ser positivos
- ✅ Observação limitada a 2000 caracteres

---

## 📊 Snapshots Imutáveis

Ao editar uma contribuição, **NÃO são alterados**:
- `category_snapshot` - Categoria do tipo no momento da criação
- `kind_snapshot` - Tipo de pagamento no momento da criação

Isso garante histórico fiscal/auditável imutável.

**SÃO alteráveis**:
- Tipo de contribuição (atualiza `contribution_type_id`)
- Meio de pagamento (atualiza `payment_method_id`)
- Membro (atualiza `member_id`)
- Valor (`amount`)
- Data (`occurred_on`)
- Observação (`observation`)

---

## 🔍 Auditoria

Todas as operações são registradas na tabela de auditoria:

### Para Edição (PUT):
```json
{
  "action": "CONTRIBUTION_UPDATED",
  "entity": "contribution",
  "entityId": "...",
  "before": { /* dados anteriores */ },
  "after": { /* dados novos */ }
}
```

### Para Anulação (DELETE):
```json
{
  "action": "CONTRIBUTION_VOIDED",
  "entity": "contribution",
  "entityId": "...",
  "after": {
    "status": "VOIDED",
    "voidReason": "motivo opcional"
  }
}
```

---

## 🗄️ Banco de Dados

### Migração Adicionada
**Arquivo**: `supabase/migrations/20261123150000_add_updated_by_to_contributions.sql`

Adiciona coluna `updated_by` para rastrear quem fez a última edição:
- Coluna: `updated_by UUID` (nullable)
- Índice: `contributions_updated_by_idx`
- Foreign key: Referencia `auth.users(id)`

---

## 🧪 Testes de Implementação

✅ **Build**: Compila sem erros TypeScript
✅ **Type-checking**: `npm run typecheck` - Passou
✅ **Linting**: `npm run lint` - Sem erros
✅ **Compilação NestJS**: `npm run build` - Sucesso

---

## 📝 DTOs e Validação Zod

### UpdateContributionDto
```typescript
{
  contributionTypeId?: uuid,
  paymentMethodId?: uuid,
  memberId?: uuid | null,
  amount?: string (regex: /^\d{1,12}(\.\d{1,2})?$/),
  occurredOn?: date,
  observation?: string | null,
  version: number (required, positive)
}
```
Validação: Requer pelo menos um campo além da versão

### DeleteContributionDto
```typescript
{
  voidReason?: string | null,
  version: number (required, positive)
}
```

---

## 🔗 Integração com Arquitetura Existente

- ✅ Segue padrão de transações (TenantTransactions)
- ✅ Usa decoradores de permissão (@RequirePermissions)
- ✅ Integra com AuditService para registros
- ✅ Implementa tenant isolation
- ✅ Usa Zod para validação de schemas
- ✅ Segue padrão de erro da API (HTTP status codes padronizados)

---

## 📚 Documentação

**Arquivo**: `EDIT_DELETE_ENDPOINTS.md`

Contém:
- Exemplos de curl para ambos endpoints
- Descrição de todos os erros possíveis
- Detalhe sobre controle de concorrência
- Notas sobre snapshots imutáveis
- Informações de auditoria

---

## ✅ Próximos Passos (Recomendações)

1. ✅ Executar migrations do banco de dados (npm run migrate)
2. ✅ Testar endpoints manualmente via Postman/Insomnia
3. ✅ Validar resposta HTTP 409 Conflict em cenários de concorrência
4. ✅ Verificar registros de auditoria no banco de dados
5. ✅ Testar validações (período fechado, data futura, etc.)

---

## 📌 Commits

```
813328e feat: add edit and delete endpoints for contributions

Implements PUT and DELETE endpoints for contribution management:
- PUT /contributions/:id - Update a contribution with optimistic locking via version
- DELETE /contributions/:id - Soft-delete (void) a contribution

Changes:
- Added UpdateContributionDto with partial fields (all optional except version)
- Added DeleteContributionDto with voidReason (optional) and version
- Implemented service.update() with version validation and audit recording
- Implemented service.void() for soft-delete
- Added PUT and DELETE controller endpoints with OpenAPI documentation
- Added migration to add updated_by column for edit tracking
```

