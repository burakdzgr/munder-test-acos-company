# PROMPT 1 — T44 + T45: Canlı Katmanlı Hafıza Motoru

> Bunu Claude Code'a olduğu gibi yapıştır. Otorite sırası ve invariant'lar bağlayıcıdır:
> `_DECISIONS.md` → `docs/architecture/docs/NN-*.md` → ADR. `35-CLAUDE-CODE-HANDOFF.md §12`'deki
> 21 invariant ihlal edilemez. Sabit kararlar (stack, tablo adları, event isimleri, state machine'ler)
> yeniden açılmaz.

## Bağlam / teşhis

`memories` hafıza katmanının **veri tarafı bitti ama motoru kurulmadı.** Kanıt (`PROGRESS.md`):

- **T09/T10/T12 DONE**: `packages/domain/src/entity/memory.ts` (scope/scopeRef + [0,1] + provenance),
  `@acos/domain/policies` (retrieval skorlama 0.55/0.2/0.15/0.1; evidence ≥3×≥2 task; promotion
  ≥2 project + manager approval → company), `packages/db/src/schema` 0007 migration = `memories`
  tablosu + **HNSW 1536+768 partial indexleri**, `versions/evidence/relations/promotions/decisions`.
- **T44 (Memory Consolidation Engine) PENDING** ve **T45 (Memory Retrieval & RAG) PENDING**.

Sonuç: UI'daki "Hafıza — 0 anı, ajanlar öğrendikçe belirir" paneli boş, çünkü ajan çalışırken anı
**yazan** (T44) ve geri **okuyan** (T45) katman yok. Bu görev bu iki task'ı bitirir ve anıları
UI'a **canlı** akıtır.

## Yapılacaklar

### 1) T44 — Consolidation Engine (yazma + konsolidasyon + promotion)

- Ajan döngüsünün (own agent loop, ADR-004) bir görev adımını/task'ı tamamladığı her noktada
  **episodic memory** üret: `scope='agent'`, `scopeRef=agentId`, içerik = ne yapıldı / ne öğrenildi /
  hangi karar verildi, **provenance zorunlu** (taskId, runId, kaynak event'ler), evidence kaydı.
  Embedding: **live modda** gerçek embedding sağlayıcısı; **scripted modda** T30'daki deterministik
  pseudo-embedding (`createScriptedAdapter`) — ikisi de çalışmalı.
- **Konsolidasyon workflow'u** (Temporal durable workflow, `workers/*`): tekrarlayan/ilişkili episodic
  anıları semantic anıya sıkıştır; `relations` ve `versions` tablolarını kullan; hiçbir anıyı
  kaybetme (append + supersede semantiği).
- **Promotion**: `@acos/domain/policies`'teki kuralları uygula — agent→project (evidence ≥3 task ×
  ≥2 agent), project→company (≥2 project + manager approval). Manager approval'ı mevcut approval
  engine üzerinden iste; otomatik promote ETME.
- Yazma yolu **kesinlikle** transactional outbox → NATS JetStream deseninden geçsin; yeni event
  tipleri mevcut event-adlandırma sözleşmesine uysun (`memory.recorded`, `memory.consolidated`,
  `memory.promoted` gibi — var olan konvansiyona hizala, uydurma).
- Postgres tek DB invariant'ı korunur; anılar `memories` tablosuna yazılır, başka store yok.

### 2) T45 — Retrieval & RAG (okuma + working set)

- **Recall pipeline**: HNSW vektör sorgusu + `@acos/domain/policies` skorlama ağırlıkları
  (0.55/0.2/0.15/0.1) ile sıralama; scope-aware (agent kendi + project + company anılarını görür,
  scope kurallarına göre).
- **Working set builder** (08 §8 bölüm 4-6): ajan bir göreve başlamadan önce ilgili anıları çekip
  bağlamına koysun (RAG). Böylece CEO/CTO/ajan görev üretirken/işlerken geçmiş anıları kullanır.
- Scripted modda deterministik, live modda gerçek embedding sorgusu — ikisi de yeşil.

### 3) Canlı emit → UI "Hafıza" paneli

- `memory.recorded/consolidated/promoted` event'leri → mevcut projection/read-model → **WebSocket** →
  web app'teki **Hafıza paneli** (Graf / Liste / Zaman sekmeleri). Yeni anı oluştuğu an panele
  **canlı** düşsün; "0 anı" gerçek sayıyla değişsin; **Graf** görünümü anı düğümlerini ve
  `relations` kenarlarını çizsin; **Zaman** görünümü kronolojik akışı göstersin.
- Bu, "canlı yaşayan ofis" akışının hafıza ayağıdır: görev atanır → ajan işler → anı **canlı** belirir.

## Kabul kriterleri (definition of done)

1. Scripted modda bir görevi bir ajana atadığımda, ajan çalışınca **Hafıza panelinde en az birkaç
   anı canlı belirir** (0 → N), sayaç ve Graf/Liste/Zaman güncellenir.
2. Retrieval, yeni bir göreve başlayan ajanın working set'ine ilgili geçmiş anıları getirir
   (test: bilinen bir anı, ilgili görevde recall edilir).
3. Promotion yolu test edilebilir: eşikler dolunca manager approval istenir, onaylanınca scope yükselir.
4. Live modda gerçek embedding ile aynı akış çalışır (en az bir smoke test).
5. `pnpm build && pnpm typecheck && pnpm lint && pnpm test` ve e2e yeşil. Yeni bir e2e:
   "görev ata → anı canlı belirir → recall çalışır".
6. `docs/architecture/PROGRESS.md`'de T44 ve T45 DONE olarak işaretlenir, oluşturulan dosyalar not edilir.

## Sınırlar

- Sabit kararları yeniden açma; şemayı sadece gerekiyorsa additive migration ile genişlet
  (mevcut 0007 yapısını bozma).
- Framework ekleme (ADR-004). Kendi loop'umuz + Temporal + NATS deseni.
- Önce kısa bir plan yaz (hangi dosyalar, hangi event'ler, hangi migration), sonra uygula.
