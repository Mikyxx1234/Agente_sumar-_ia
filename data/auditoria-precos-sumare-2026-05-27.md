# Auditoria de preços — Sumaré (site vs Supabase)

Data: 2026-05-27  
**Nenhuma alteração foi feita no Supabase** — apenas levantamento para revisão.

## Fontes oficiais

| Tipo | URL |
|------|-----|
| Pós-graduação EAD | https://mg.sumare.edu.br/pos-graduacao/ead |
| Graduação EAD | https://pr.sumare.edu.br/graduacao/ead |
| Exemplo (Psicopedagogia) | https://sumare.edu.br/posGraduacao/Educação/ead-psicopedagogia-e-psicomotricidade |

Valores do site = **mensalidade com desconto** (1º valor) e **mensalidade cheia** (2º valor).  
Pós EAD: período típico **6 meses** (6 parcelas). Graduação: **4 a 8 semestres** conforme curso.

## Resumo

| Status | Pós (`pos_preco`, 41) | Grad (`grad_preco`, 41) |
|--------|----------------------|-------------------------|
| **ok** — desconto e cheio batem com o site | 0 | **20** |
| **divergente_campo_desconto** — valor certo está em `grad ou pos`, não em `preco com desconto` | **19** | 0 |
| **divergente** — outros campos (ex.: cheio 636 vs site 623; tier 191) | 13 | **21** |
| **sem_match_site** — curso fora da página de catálogo listada | 9 | 0 |
| **corrupt** — colunas deslocadas no `content` (import CSV) | 5 | 0 |

## Causa raiz (caso Psicopedagogia — imagens enviadas)

O agente respondeu **R$ 33,00** (desconto) porque o campo `preco com desconto` no Supabase está **33**, enquanto o site e o campo `grad ou pos` no mesmo registro trazem **187**.

| Campo | Supabase (id 124) | Site oficial |
|-------|-------------------|--------------|
| preco com desconto | **33** ❌ | **187** |
| preco cheio | 623 | **623,33** |
| grad ou pos | **187** ✓ (valor real) | — |

Padrão repetido na maioria dos registros de pós: `preco com desconto` = 33 ou 65, e o valor mensal correto aparece em `grad ou pos`.

## Arquivo para revisão

- Planilha: `data/auditoria-precos-sumare-2026-05-27.csv` (UTF-8 com BOM — abre direto no Excel)

## Próximo passo (após sua aprovação)

1. Corrigir `preco com desconto` ← valor de `grad ou pos` (ou do site) onde aplicável  
2. Reindexar embeddings (`content` + vetor) nas tabelas `pos_preco` / `grad_preco`  
3. Validar cursos sem match no catálogo (pós extras fora da página MG) em páginas individuais sumare.edu.br
