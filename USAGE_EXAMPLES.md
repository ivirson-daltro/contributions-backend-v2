# Exemplos Práticos de Uso - Endpoints de Edição e Exclusão

## 🚀 Fluxo Completo de Uso

### 1️⃣ Criar uma Contribuição (POST)

```bash
curl -X POST "http://localhost:3000/v1/contributions" \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "x-tenant-id: seu_tenant_id" \
  -H "Idempotency-Key: criacao-ana-001" \
  -H "Content-Type: application/json" \
  -d '{
    "contributionTypeId": "550e8400-e29b-41d4-a716-446655440001",
    "paymentMethodId": "550e8400-e29b-41d4-a716-446655440002",
    "memberId": "550e8400-e29b-41d4-a716-446655440003",
    "amount": "850.00",
    "occurredOn": "2026-11-20",
    "observation": "Dízimo de novembro"
  }'
```

**Resposta (201 Created):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440004",
  "occurredOn": "2026-11-20",
  "amount": "850.00",
  "member": {
    "id": "550e8400-e29b-41d4-a716-446655440003",
    "name": "Ana Silva"
  },
  "type": {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "description": "Dízimo",
    "category": "TITHE"
  },
  "method": {
    "id": "550e8400-e29b-41d4-a716-446655440002",
    "description": "Pix",
    "kind": "PIX"
  },
  "observation": "Dízimo de novembro",
  "status": "ACTIVE",
  "attachmentsCount": 0,
  "version": 1
}
```

---

### 2️⃣ Editar a Contribuição (PUT)

**Cenário**: Ana percebe que o valor estava errado e precisa corrigir de R$ 850 para R$ 900

```bash
curl -X PUT "http://localhost:3000/v1/contributions/550e8400-e29b-41d4-a716-446655440004" \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "x-tenant-id: seu_tenant_id" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "900.00",
    "observation": "Dízimo de novembro - corrigido",
    "version": 1
  }'
```

**Resposta (200 OK):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440004",
  "occurredOn": "2026-11-20",
  "amount": "900.00",
  "member": {
    "id": "550e8400-e29b-41d4-a716-446655440003",
    "name": "Ana Silva"
  },
  "type": {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "description": "Dízimo",
    "category": "TITHE"
  },
  "method": {
    "id": "550e8400-e29b-41d4-a716-446655440002",
    "description": "Pix",
    "kind": "PIX"
  },
  "observation": "Dízimo de novembro - corrigido",
  "status": "ACTIVE",
  "attachmentsCount": 0,
  "version": 2  // ← Version incrementada!
}
```

---

### 3️⃣ Tentar Editar com Versão Desatualizada ❌

**Cenário**: Outro usuário já editou a contribuição, mas você está usando `version: 1`

```bash
curl -X PUT "http://localhost:3000/v1/contributions/550e8400-e29b-41d4-a716-446655440004" \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "x-tenant-id: seu_tenant_id" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "950.00",
    "version": 1
  }'
```

**Resposta (409 Conflict):**
```json
{
  "statusCode": 409,
  "code": "VERSION_MISMATCH",
  "message": "Versão desatualizada. Recarregue os dados."
}
```

**Solução**: Recarregar os dados (GET), pegar a versão correta (2), e tentar novamente

---

### 4️⃣ Mudar Meio de Pagamento

**Cenário**: A contribuição foi feita em dinheiro, mas deveria ser Pix

```bash
curl -X PUT "http://localhost:3000/v1/contributions/550e8400-e29b-41d4-a716-446655440004" \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "x-tenant-id: seu_tenant_id" \
  -H "Content-Type: application/json" \
  -d '{
    "paymentMethodId": "550e8400-e29b-41d4-a716-446655440005",
    "version": 2
  }'
```

**Nota**: O `kind_snapshot` mantém o valor original (a data/hora será preservada como "CASH" ou o que era)

---

### 5️⃣ Anular Contribuição (DELETE)

**Cenário**: A contribuição foi registrada por engano e precisa ser cancelada

```bash
curl -X DELETE "http://localhost:3000/v1/contributions/550e8400-e29b-41d4-a716-446655440004" \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "x-tenant-id: seu_tenant_id" \
  -H "Content-Type: application/json" \
  -d '{
    "voidReason": "Lançamento duplicado - removendo",
    "version": 2
  }'
```

**Resposta (200 OK):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440004",
  "status": "VOIDED",
  "voidReason": "Lançamento duplicado - removendo"
}
```

**O que acontece após DELETE:**
- Status muda para `VOIDED`
- Contribuição não aparece mais em relatórios (filtram ACTIVE por padrão)
- Dados permancem no banco (soft-delete, não hard-delete)
- Registra motivo na auditoria

---

### 6️⃣ Tentar Editar Contribuição Anulada ❌

```bash
curl -X PUT "http://localhost:3000/v1/contributions/550e8400-e29b-41d4-a716-446655440004" \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "x-tenant-id: seu_tenant_id" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "1000.00",
    "version": 3
  }'
```

**Resposta (409 Conflict):**
```json
{
  "statusCode": 409,
  "code": "CONTRIBUTION_VOIDED",
  "message": "Contribuição já foi anulada"
}
```

---

### 7️⃣ Listar Contribuições (com filtro de status)

**Apenas ACTIVE (padrão):**
```bash
curl -X GET "http://localhost:3000/v1/contributions" \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "x-tenant-id: seu_tenant_id"
```

**Incluindo VOIDED:**
```bash
curl -X GET "http://localhost:3000/v1/contributions?status=ALL" \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "x-tenant-id: seu_tenant_id"
```

**Apenas VOIDED:**
```bash
curl -X GET "http://localhost:3000/v1/contributions?status=VOIDED" \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "x-tenant-id: seu_tenant_id"
```

---

## 🔄 Exemplo com JavaScript/TypeScript

```typescript
// 1. Criar contribuição
const createResponse = await fetch(`${API}/contributions`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-tenant-id': tenantId,
    'Idempotency-Key': `create-${Date.now()}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    contributionTypeId: 'tipo-uuid',
    paymentMethodId: 'metodo-uuid',
    memberId: 'membro-uuid',
    amount: '850.00',
    occurredOn: '2026-11-20'
  })
});

const contribution = await createResponse.json();
console.log(`Criada com ID: ${contribution.id}, version: ${contribution.version}`);

// 2. Editar com versão
const updateResponse = await fetch(`${API}/contributions/${contribution.id}`, {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-tenant-id': tenantId,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    amount: '900.00',
    version: contribution.version
  })
});

const updated = await updateResponse.json();
console.log(`Atualizada, nova version: ${updated.version}`);

// 3. Anular com versão
const deleteResponse = await fetch(`${API}/contributions/${updated.id}`, {
  method: 'DELETE',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-tenant-id': tenantId,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    voidReason: 'Cancelado por teste',
    version: updated.version
  })
});

const voided = await deleteResponse.json();
console.log(`Anulada: ${voided.status}`);
```

---

## 🧪 Cenários de Teste

### ✅ Sucesso
- [ ] Editar contribuição com todos os campos opcionais
- [ ] Editar apenas um campo (ex: observação)
- [ ] Editar apenas outro campo (ex: valor)
- [ ] Anular com motivo
- [ ] Anular sem motivo
- [ ] Verificar que versão incrementa corretamente

### ❌ Erros Esperados
- [ ] Editar com versão desatualizada → 409
- [ ] Editar contribuição anulada → 409
- [ ] Anular com versão desatualizada → 409
- [ ] Anular já anulada → 409
- [ ] Editar período fechado → 409
- [ ] Editar mês encerrado → 409
- [ ] Usar tipo inválido → 422
- [ ] Usar membro inválido → 422
- [ ] ID inexistente → 404

---

## 📊 Verificar Auditoria

```sql
-- Ver histórico de edições de uma contribuição
SELECT 
  id, 
  action, 
  entity, 
  entity_id, 
  created_by, 
  created_at,
  before_data,
  after_data
FROM audit_logs
WHERE entity = 'contribution' 
  AND entity_id = 'seu-contribution-id'
ORDER BY created_at DESC;

-- Ver quem fez a última edição
SELECT 
  updated_by,
  updated_at
FROM contributions
WHERE id = 'seu-contribution-id';
```

---

## 🔐 Checklist de Segurança

- ✅ Sempre enviar `version` para detectar edições concorrentes
- ✅ Validar resposta HTTP status (409 = conflito, tente novamente)
- ✅ Recarregar dados antes de editar se receber 409
- ✅ Usar token com permissão `contributions:write`
- ✅ Incluir `x-tenant-id` correto
- ✅ Manter auditoria e motivos de anulação
- ✅ Não permitir edição de contribuições anuladas (pela API)

