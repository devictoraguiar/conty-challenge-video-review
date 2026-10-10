# Conty — revisão de vídeo e peças da campanha

API TypeScript com Hono e SQLite nativo do Node. O upload é uma referência fictícia ou URL; a regra de aprovação e o histórico são persistidos de verdade.

## Rodar

Node **22.23.3 ou superior**.

```bash
npm ci
npm test
npm run typecheck
npm run dev
```

API em `http://127.0.0.1:3002`. `DATABASE_PATH` e `PORT` configuram o arquivo SQLite e a porta; veja `.env.example`. Não é necessário serviço externo.

## Regra

- A campanha declara `requiredPieces`: lista não vazia, sem duplicatas, entre `script`, `video`, `cover` e `caption`. Não há endpoint para alterar essa lista.
- Cada peça tem versões numeradas, preservadas no histórico. A de maior número é a atual; uma versão nova começa em `in_review` e **não herda aprovação**.
- Aprovar uma versão não aprova a entrega. `POST /deliveries/:id/approval` verifica, no banco, se **cada peça exigida tem sua versão atual aprovada**. Ausência ou versão pendente retorna `409` com `pendingPieces` e código `REQUIRED_PIECES_PENDING`.
- Aprovação antiga não conta para a versão atual. Tentar aprovar uma versão histórica retorna `409`.
- Uma nova versão de **qualquer** peça reabre a entrega em `in_production` e limpa `approvedAt`, na mesma transação do envio. A aprovação das outras peças permanece.
- Peça não exigida não bloqueia. Se uma peça opcional recebe versão nova, a entrega reabre, mas pode ser reaprovada sem aprovar essa peça opcional.
- Aprovações repetidas são idempotentes. Comentários não mudam aprovações.
- Comentário pertence ao `versionId` do vídeo, com `second` numérico, finito e não negativo (inclusive zero e frações). Continua visível naquela versão, mesmo depois de substituída; não migra para a nova.

## API

| Método | Caminho | Corpo |
|---|---|---|
| POST | `/campaigns` | `{ "title": "Campanha", "requiredPieces": ["video", "caption"] }` |
| GET | `/campaigns/:id` | — |
| POST | `/deliveries` | `{ "campaignId": "…", "creatorId": "creator-1" }` |
| GET | `/deliveries/:id` | — |
| POST | `/deliveries/:id/pieces/:kind/versions` | `{ "content": "https://example.com/video-v1.mp4" }` |
| GET | `/deliveries/:id/pieces/:kind/versions/:versionId` | — |
| POST | `/deliveries/:id/pieces/:kind/versions/:versionId/approval` | — |
| POST | `/deliveries/:id/approval` | — |
| POST | `/deliveries/:id/pieces/video/versions/:versionId/comments` | `{ "second": 12.5, "text": "Ajustar esta cena" }` |

Criações retornam `201`; consultas e aprovações, `200`. Entradas inválidas retornam `400`, recursos inexistentes ou versão fora da entrega/peça indicada, `404`, e conflitos de aprovação, `409`. Strings de entrada não podem conter NUL (`U+0000`): a API rejeita com `400`, sem truncar ou sanitizar o texto. `content` é texto não vazio: roteiro/legenda podem conter o próprio texto; vídeo/capa podem conter URL ou nome de arquivo fictício. A API não baixa URLs nem recebe binários.

A resposta da entrega inclui `status`, `approvedAt`, `requiredPieces`, `pendingPieces` e `pieces`. Cada peça contém `currentVersionId` e `versions`, com `status`, `approvedAt`, `isCurrent` e seus próprios `comments`.

## Exemplo completo

Com a API rodando, execute em Bash. O exemplo exige somente vídeo, portanto roteiro não bloqueia. O helper usa apenas Node, sem `jq`.

```bash
BASE=http://127.0.0.1:3002
field() { node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }

CAMPAIGN=$(curl -sS -X POST "$BASE/campaigns" \
  -H 'content-type: application/json' \
  -d '{"title":"Lançamento","requiredPieces":["video"]}' | field id)
DELIVERY=$(curl -sS -X POST "$BASE/deliveries" \
  -H 'content-type: application/json' \
  -d "{\"campaignId\":\"$CAMPAIGN\",\"creatorId\":\"creator-1\"}" | field id)

# 409: vídeo exigido ainda ausente.
curl -sS -i -X POST "$BASE/deliveries/$DELIVERY/approval"

curl -sS -X POST "$BASE/deliveries/$DELIVERY/pieces/video/versions" \
  -H 'content-type: application/json' -d '{"content":"video-v1.mp4"}'
V1=$(curl -sS "$BASE/deliveries/$DELIVERY" | \
  node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.parse(s).pieces.find(p=>p.kind==="video").currentVersionId))')

curl -sS -X POST "$BASE/deliveries/$DELIVERY/pieces/video/versions/$V1/comments" \
  -H 'content-type: application/json' -d '{"second":12.5,"text":"Ajustar esta cena"}'
curl -sS -X POST "$BASE/deliveries/$DELIVERY/pieces/video/versions/$V1/approval"
curl -sS -X POST "$BASE/deliveries/$DELIVERY/approval" # approved

# A versão nova reabre a entrega e não recebe o comentário de V1.
curl -sS -X POST "$BASE/deliveries/$DELIVERY/pieces/video/versions" \
  -H 'content-type: application/json' -d '{"content":"https://example.com/video-v2.mp4"}'
curl -sS -i -X POST "$BASE/deliveries/$DELIVERY/approval" # 409
curl -sS "$BASE/deliveries/$DELIVERY/pieces/video/versions/$V1" # comentário preservado
V2=$(curl -sS "$BASE/deliveries/$DELIVERY" | \
  node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.parse(s).pieces.find(p=>p.kind==="video").currentVersionId))')
curl -sS -X POST "$BASE/deliveries/$DELIVERY/pieces/video/versions/$V2/approval"
curl -sS -X POST "$BASE/deliveries/$DELIVERY/approval" # approved novamente
```

Exemplo de conflito:

```json
{
  "error": "Peças obrigatórias sem versão atual aprovada: video.",
  "code": "REQUIRED_PIECES_PENDING",
  "pendingPieces": ["video"]
}
```

## Projeto e referências

Modelo relacional: campanhas, requisitos da campanha, entregas, versões de peças e comentários vinculados à versão. A lista de peças exigidas é dado persistido, não uma condição por tipo espalhada pelos endpoints. Uma única verificação de pendências serve à consulta e à aprovação.

Operações de aprovação e substituição usam transações síncronas `BEGIN IMMEDIATE`, sem `await` dentro delas, para verificar e escrever sob o mesmo bloqueio. Consultas usam transações de leitura para obter um retrato consistente sem reservar o bloqueio de escrita. Chaves estrangeiras e unicidade por entrega/peça/número protegem o histórico, sem ORM, fila ou serviço de armazenamento.

Referências consultadas:
- [SQLite: transações](https://www.sqlite.org/lang_transaction.html) — reserva de escrita com `BEGIN IMMEDIATE` e commit/rollback.
- [SQLite: chaves estrangeiras](https://www.sqlite.org/foreignkeys.html) — relações persistentes e ativação de `PRAGMA foreign_keys`.
- [SQLite: NUL em strings](https://www.sqlite.org/nulinstr.html) — limites de tratamento desse caractere; rejeitá-lo na entrada evita respostas truncadas na leitura pelo driver nativo das versões do Node verificadas.
- [Frame.io: criação de comentários](https://next.developer.frame.io/platform/v4/api-reference/comments/create) — exemplo real de comentário associado a um arquivo, com posição temporal. Aqui a referência é a versão específica; a unidade simplificada é segundo, conforme o enunciado. A regra de aprovação da Conty vem do enunciado, não dessa referência.

Sem autenticação, interface, pagamento real ou validação da duração do vídeo: não há metadados de mídia para verificar o limite superior do segundo. A API é local e não impõe limite de corpo JSON; antes de exposição pública, limites de payload e autorização por campanha/criador precisam ser definidos. Integração de armazenamento seria trabalho separado.

## Testes

Os **62 testes** cobrem peças exigidas e opcionais, aprovação da versão atual, substituição após aprovação, comentários por versão, persistência, requisições atrasadas, rollback e validação de entradas. Testes e typecheck passaram no Node 22.23.3 e 24.11.1. O exemplo acima foi executado por HTTP, incluindo os dois conflitos `409` esperados e a reaprovação.

## Uso de IA e revisão

Usei IA na análise do enunciado, implementação da API, elaboração dos testes, documentação e revisões técnicas. Revisei pessoalmente o código, os testes e a documentação, incluindo a regra das peças exigidas, a aprovação da versão atual, a invalidação da entrega e o vínculo dos comentários com a versão original.
