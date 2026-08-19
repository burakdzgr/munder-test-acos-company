# PROMPT 2 — CodeIndexPort + codebase-memory-mcp Adapter (kod-bilgi hafızası)

> Bunu Claude Code'a olduğu gibi yapıştır. Otorite sırası bağlayıcı: `_DECISIONS.md` →
> `docs/architecture/docs/NN-*.md` → ADR; `§12` 21 invariant ihlal edilemez. Tool gateway +
> permissions + sandbox invariant'ları korunur. Self-hosted / offline ilkesi korunur.

## Amaç

Ajanların bir projede "login endpoint nerede / bu fonksiyonu kim çağırıyor" gibi soruları **tüm dosyayı
okumadan** yanıtlaması için kod-bilgi grafiğini entegre et. Motor olarak olgun bir dış proje kullan:
**DeusData/codebase-memory-mcp** (saf C, tek static binary, sıfır runtime bağımlılığı, API key yok,
gömülü embedding, SQLite bilgi grafiği, 158 dil tree-sitter, 15 MCP tool). **AMA** bağımlılık çekirdeğe
sızmasın: her şey bir **port** arkasında dursun, adapter değiştirilebilir olsun.

## Mimari ilke — Port/Adapter (bağımlılığı yapısal olarak izole et)

- Ajanlar **hiçbir zaman** MCP'yi doğrudan çağırmaz; **`CodeIndexPort`** arayüzünü çağırır.
- Bugünkü adapter = `codebase-memory-mcp`. Yarın istenirse aynı port'un arkasına native
  (tree-sitter + pgvector) adapter yazılıp binary sökülür — **ajan/tool tarafında tek satır değişmeden.**
- codebase-memory-mcp'nin SQLite cache'i (`~/.cache/codebase-memory-mcp` / proje içi
  `.codebase-memory/graph.db.zst`) **yeniden üretilebilir türev cache**'tir; "Postgres tek DB" durable
  invariant'ını bozmaz. Kalıcı gerçek Postgres'te kalır; bu yalnızca repodan her an yeniden inşa
  edilebilen yardımcı okuma-modelidir. Proje workspace'i altında tut, durable state ile karıştırma.

## Yapılacaklar

### 1) `CodeIndexPort` arayüzü (core paket)

Dil-agnostik, MCP'den bağımsız imza (örnek — mevcut isimlendirmeye hizala):

```
indexProject(projectId, repoPath) -> { status }
indexStatus(projectId) -> { indexed, files, lastSync }
searchGraph(projectId, query, mode: 'structural'|'semantic') -> results
tracePath(projectId, from, to) -> callPath
getArchitecture(projectId) -> overview
getCodeSnippet(projectId, ref) -> code
detectChanges(projectId) -> diff
```

### 2) Adapter: codebase-memory-mcp'yi tool gateway'e MCP server olarak kaydet

- 15 MCP tool'unu (`index_repository`, `search_graph`, `trace_path`, `get_architecture`,
  `get_code_snippet`, `detect_changes`, `query_graph`, `index_status`, ...) port metodlarına eşle.
- Binary'yi worker/sandbox imajına koy (Linux; `install.sh` veya release binary). Docker imaj
  build'inde bulunmalı; runtime'da internet gerektirmez (offline korunur).
- `CBM_ALLOWED_ROOT` ile indeks yolunu proje workspace'ine kısıtla; `CBM_CACHE_DIR`'i proje altına al.

### 3) Proje intake/upload'ında otomatik indeksleme

- Bir proje/repo sisteme girdiğinde (intake/import akışı) **otomatik** `indexProject` tetiklensin.
- İndeks durumu event'i yayınlansın (outbox → NATS → projection) ki UI'da proje "indekslendi/…%"
  görünsün. Bu, "canlı ofis" akışının kod-okuma ayağının ilk adımıdır (upload → oto-indeks → ajan
  grafiği sorgular, dosyaları taramaz).

### 4) İzin kademeleri — Scout / Verify / Auditor → seniority/autonomy

- codebase-memory-mcp'nin üç kademesini bizim rollerimize bağla, tool gateway permission modeliyle zorla:
  - `member` / junior → **Scout** (hızlı keşif, dar kapsam)
  - `lead` / mid–senior → **Verify** (varsayılan, göreve yönelik kanıt)
  - `security` + auditor rolleri / senior lead → **Auditor** (geniş kapsam)
- Bu tool **salt-okunur**: koda yazmaz, sadece indeksler/sorgular. Sandbox ve permission invariant'ları geçerli.

### 5) Swappability kanıtı

- Port'un arkasına ikinci bir **stub/native-iskelet adapter** koy (boş da olsa) ve config ile
  hangi adapter'ın aktif olduğunu seçilebilir yap. Böylece "dış repoyu sökebiliriz" iddiası kod
  seviyesinde kanıtlanır.

## Kabul kriterleri

1. Bir repo upload edilince otomatik indekslenir; UI'da indeks durumu görünür.
2. Bir ajan `CodeIndexPort` üzerinden "login endpoint nerede" sorusunu sorar ve **tüm dosyaları
   okumadan** doğru dosyayı/satırı alır; token kullanımı belirgin düşer (öncesi/sonrası logla).
3. Kademeler zorlanır: junior ajan Auditor kapsamını çağıramaz.
4. Adapter seçimi config'ten değişebilir (codebase-memory-mcp ↔ stub); ajan/tool kodu değişmez.
5. `pnpm build && pnpm typecheck && pnpm lint && pnpm test` yeşil; offline (internet kapalı) çalışır.
6. Yeni entegrasyon task'ı `PROGRESS.md`'ye eklenir (ör. T51 — Code Knowledge / CodeIndexPort).

## Sınırlar

- Bu **kod-bilgi** katmanıdır; deneyimsel şirket/ajan hafızası (`memories`/pgvector, T44/T45) ile
  KARIŞTIRMA — o ayrı katman ve nativedir.
- Sabit kararları yeniden açma; framework ekleme (ADR-004). Önce kısa plan, sonra uygulama.
- Lisans: repo MIT; personal/local kullanım uygun. Dağıtım/ticari kullanım öncesi lisansı
  `CREDITS.md`'ye kaydet.
