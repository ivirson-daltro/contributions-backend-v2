# Endpoints de Edição e Exclusão de Contribuições

## Visão Geral

Foram implementados dois novos endpoints para complementar as operações CRUD em contribuições:

- **PUT /contributions/:id** - Editar uma contribuição
- **DELETE /contributions/:id** - Marcar uma contribuição como VOIDED (exclusão lógica)

Ambos os endpoints requerem a permissão `contributions:write`.

## PUT /contributions/:id - Editar Contribuição

Permite atualizar os dados de uma contribuição existente.

### Request

```bash
curl -X PUT "http://localhost:3000/contributions/{id}" \
  -H "Authorization: Bearer {token}" \
  -H "x-tenant-id: {tenant-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "contributionTypeId": "uuid-opcional",
    "paymentMethodId": "uuid-opcional",
    "memberId": "uuid-ou-null-opcional",
    "amount": "850.00",
    "occurredOn": "2026-11-12",
    "observation": "Observação opcional",
    "version": 1
  }'
```

### Validações

- **version** (obrigatório): Versão atual da contribuição. Usado para controle de concorrência otimista.
- Todos os outros campos são opcionais, mas pelo menos um deve ser informado além da versão.
- Mantém as mesmas validações de data, período fechado e membro obrigatório como no POST.

### Response (200 OK)

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "occurredOn": "2026-11-12",
  "amount": "850.00",
  "member": {
    "id": "00000000-0000-4000-8000-000000000002",
    "name": "Ana"
  },
  "type": {
    "id": "00000000-0000-4000-8000-000000000003",
    "description": "Dízimo",
    "category": "TITHE"
  },
  "method": {
    "id": "00000000-0000-4000-8000-000000000004",
    "description": "Pix",
    "kind": "PIX"
  },
  "observation": "Observação opcional",
  "status": "ACTIVE",
  "attachmentsCount": 0,
  "version": 2
}
```

### Erros

- **404 Not Found**: Contribuição não encontrada.
- **409 Conflict**: 
  - Contribuição já foi anulada (VOIDED)
  - Versão desatualizada (VERSION_MISMATCH)
  - Período fechado (MONTH_CLOSED)
- **422 Unprocessable Entity**: Tipo, meio de pagamento ou membro inválido/inativo.

## DELETE /contributions/:id - Anular Contribuição

Marca uma contribuição como VOIDED (exclusão lógica/soft-delete).

### Request

```bash
curl -X DELETE "http://localhost:3000/contributions/{id}" \
  -H "Authorization: Bearer {token}" \
  -H "x-tenant-id: {tenant-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "voidReason": "Cancelado por engano",
    "version": 1
  }'
```

### Parâmetros

- **version** (obrigatório): Versão atual da contribuição. Usado para controle de concorrência otimista.
- **voidReason** (opcional): Motivo da anulação (até 2000 caracteres).

### Response (200 OK)

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "status": "VOIDED",
  "voidReason": "Cancelado por engano"
}
```

### Erros

- **404 Not Found**: Contribuição não encontrada.
- **409 Conflict**:
  - Contribuição já foi anulada (ALREADY_VOIDED)
  - Versão desatualizada (VERSION_MISMATCH)

## Controle de Concorrência

Ambos os endpoints usam **versionamento otimista** para evitar conflitos de edição simultânea:

1. Cliente lê a contribuição (recebe versão atual)
2. Cliente envia requisição de edição/exclusão com a versão
3. Server valida a versão antes de fazer a alteração
4. Response retorna a versão incrementada (versão + 1)
5. Se versão não corresponder, retorna 409 Conflict

Isso garante que edições simultâneas não causem sobrescrita silenciosa de dados.

## Auditoria

Todas as operações são registradas:

- **CONTRIBUTION_UPDATED**: Registra mudanças de edição (before/after)
- **CONTRIBUTION_VOIDED**: Registra anulações com motivo
- Ambas incluem o `updated_by` (userId) e `updated_at` (timestamp)

## Snapshots Imutáveis

Ao editar uma contribuição:

- `category_snapshot` e `kind_snapshot` **não são alterados**
- Mantêm os valores do momento original da criação
- Apenas campos mutáveis são atualizados:
  - `contribution_type_id` (pode mudar)
  - `payment_method_id` (pode mudar)
  - `member_id` (pode mudar)
  - `amount` (pode mudar)
  - `occurred_on` (pode mudar)
  - `observation` (pode mudar)

## Restrições

- Não é permitido editar ou anular contribuições em períodos fechados
- Não é permitido alterar uma contribuição já anulada
- As mesmas validações de data futura se aplicam (se configurado no tenant)
