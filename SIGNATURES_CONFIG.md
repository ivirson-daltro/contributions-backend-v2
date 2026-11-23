# Modular Report Signatures Configuration

## Visão Geral

A seção de assinaturas nos relatórios PDF é agora modular e configurável. Diferentes tipos de relatórios podem ter diferentes layouts de assinaturas.

## Uso

### Para o Relatório de Contribuições

Atualmente, o relatório de contribuições usa a configuração `contributionsReportSignaturesConfig`:

```typescript
export const contributionsReportSignaturesConfig: SignaturesConfig = {
  rows: [
    ["1º Tesoureiro(a)", "2º Tesoureiro(a)"],
    ["Conselho Fiscal 1", "Conselho Fiscal 2", "Conselho Fiscal 3"],
  ],
};
```

Isso resulta em **3 linhas de assinatura**:
- Linha 1: 1º e 2º Tesoureiro(a) (2 pessoas)
- Linha 2: 3 membros do Conselho Fiscal

### Para Criar Novo Relatório com Assinaturas Diferentes

1. **Adicione uma nova configuração em `report-signatures-config.ts`:**

```typescript
export const anotherReportSignaturesConfig: SignaturesConfig = {
  rows: [
    ["Presidente", "Vice-Presidente", "Secretário"],
    ["Membro 1", "Membro 2", "Membro 3"],
    ["Membro 4", "Membro 5"],
  ],
};
```

2. **Use a configuração no seu novo serviço de relatório:**

```typescript
import { anotherReportSignaturesConfig } from "../../common/pdf/report-signatures-config";

export function reportDocument(
  // ... outros parâmetros
): TDocumentDefinitions {
  // ... construção do conteúdo
  
  content.push(...reportSignatures(anotherReportSignaturesConfig.rows));
  return reportLayout(content);
}
```

## Estrutura

### SignaturesConfig

```typescript
interface SignaturesConfig {
  rows: string[][];
}
```

- **rows**: Array de arrays de strings
  - Cada array interno representa uma linha de assinatura
  - Cada string é o label de uma pessoa/posição
  - O número de posições por linha é flexível

### Exemplos de Configuração

**2 linhas, 2 pessoas por linha:**
```typescript
rows: [
  ["Pessoa 1", "Pessoa 2"],
  ["Pessoa 3", "Pessoa 4"],
]
```

**3 linhas, quantidade variável por linha:**
```typescript
rows: [
  ["Presidente"],
  ["Membro A", "Membro B"],
  ["Membro C", "Membro D", "Membro E"],
]
```

**5 linhas como no exemplo original:**
```typescript
rows: [
  ["1º Tesoureiro(a)", "2º Tesoureiro(a)"],
  ["Conselho Fiscal 1", "Conselho Fiscal 2", "Conselho Fiscal 3"],
  ["Conselho Fiscal 4", "Conselho Fiscal 5"],
  // ... mais linhas conforme necessário
]
```

## Arquivos Envolvidos

- `src/common/pdf/report-signatures-config.ts` - Configurações de assinaturas
- `src/common/pdf/report-layout.ts` - Componentes de layout (já modular)
- `src/modules/contributions/contributions-report.service.ts` - Serviço que usa a configuração
