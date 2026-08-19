# Revised

## Scheduler
Kuyruk artık priority-first (P0→P3) + FIFO ve çözülmemiş bağımlılığı olan görevleri atlıyor (`pickNextQueuedTaskId`); delege hedefi hierarchy içinde skill match, workload, project familiarity, historical success ve memory affinity'den oluşan deterministic skorla seçiliyor — LLM yalnız işi tanımlıyor.

## Interactive Shell
Sandbox-manager'a uzun ömürlü çift yönlü PTY (`/bin/sh`, stdin bağlı) eklendi; Founder terminal panelinden "Kontrolü al" ile `terminal.write` ve resize yapabiliyor, `agent_control ↔ human_control` takeover/return akışı server'da tutuluyor ve write yalnız human_control'de kabul ediliyor.

## Preview Gateway
Workspace portları `/proc/net/tcp`'den keşfediliyor ve `GET .../workspaces/:id/ports` previewUrl'lerle dönüyor; `ALL /preview/:companyId/:workspaceId/:port/*` server→sandbox-manager→container zinciriyle güvenli reverse proxy, `acos_preview` çerezi + 404 fallback mutlak yollu assetleri de çalıştırıyor.

## CodeIndex
Regex tabanlı code_graph'ın yerine TypeScript compiler API ile AST/sembol indeksi geldi (migration 0019: `code_files`/`code_symbols`/`code_edges` — import/reference/call/tests); `project.imported` tam indeksi, merge sonrası `mergeCommit~1` diff'i yalnız değişen dosyaları incremental güncelliyor.

## Memory + CodeIndex
Anılar `entities.files/.symbols/.commits/.tests` canonical referanslarını normalize edilmiş taşıyor; retrieval'a CodeIndex lane'i eklendi — dokunulan dosyalar kod grafiğiyle komşu dosya+sembollere genişliyor, eşleşen anılar working set'e giriyor ve seed dosyaların sembol haritası `[CodeIndex]` bloğu olarak context'e ekleniyor.

## Approval
Intake'teki Founder consultation fail-closed yapıldı: zaman aşımı/hata otomatik `approved: true` üretmiyor, GOAL `PLANNED`'da (WAITING_FOR_FOUNDER eşdeğeri) bekliyor ve CEO döngüsü yalnız gerçek onayla (UI'dan ASSIGN) başlıyor.

## Production Auth
`NODE_ENV=production` + `AUTH_AUTOLOGIN=true` boot'u artık exit 1 ile reddediyor; bilinçli tek kullanıcılı kurulum `AUTH_AUTOLOGIN_ALLOW_PRODUCTION=true` ile açık opt-in veriyor, geliştirme ortamı davranışı değişmedi.

## Project Lifecycle & Context Architecture

### Project Entry
Yeni proje ekranı iki ana yola indirildi — "Projeni Dahil Et" (GitHub URL + bağlantı seçimi, ad repo'dan türetilir) ve "Proje Oluştur" (ad + hedef + bağlantı) — ikisi de aynı yaşam döngüsüne akar: draft → repository_setup → indexing → ready → planning → staffing_review → waiting_for_founder → executing. GitHub credential'ı artık açık GitHubConnection modeli altında (token yalnız secrets'ta mühürlü, proje sadece referans taşır, dispatch anında sunucuda çözülür).

### Repository & Index
Import edilen proje tam CodeIndex kurulmadan READY olmaz ve READY commit SHA'ya bağlıdır; greenfield projeler deterministik başlangıç dosyaları + initial commit + (bağlantı varsa) GitHub remote ile doğar. CodeIndex modüler LanguageIndexer kaydına geçti (TS Compiler API + Python + Generic; implements/extends kenarları) ve canonical + task-overlay katmanlı: worktree'ın commit edilmemiş değişiklikleri gölge katmanda indekslenir, merge sonrası canonical incremental güncellenip overlay silinir.

### CEO & Staffing
Kullanıcı hedefi önce Requirement Analyzer'dan yapılandırılmış geçer (goal/requirements/capabilities/risks/success_criteria); staffing gap analizi DETERMİNİSTİKTİR ve eksik kadro TEK toplu Founder onayına dönüşür — onay sonrası Agent Factory takım+pozisyon+ajan+izin+model bağlarını kurar ve planlama kaldığı yerden sürer; boş organizasyon projeyi asla düşürmez, bekletir. CEO org.team.create/agent.hire niyetleri R3 olarak varsayılan Founder onay kapısındadır.

### Scheduler & Context
CEO işi tanımlar (requiredCapabilities dahil), atamanın deterministic sahibi Scheduler'dır: yetenek filtresi + skill/yük/aşinalık/başarı/anı-yakınlığı/model-uygunluğu skoru; açık ajan dayatması yetenek filtresinden geçmiyorsa geçersizdir. Her görev LLM'e gitmeden Task Analyzer → CodeIndex (canonical+overlay) → Memory → minimal Context Pack hattından geçer; code.search aracı ilk arama yolu, tam repo taraması yasak, read-only çağrılar görev bazında önbelleklidir, bayat indeks açıkça işaretlenir.

### Preview & Runtime
preview.ports aracı dev sunucusunun portlarını keşfedip workspace.port.opened olayı ve Founder'ın Open Preview URL'lerini üretir; http.request aracı ajan/QA'nın YALNIZ kendi workspace'inin keşfedilmiş portlarına HTTP doğrulaması yapmasına izin verir. Founder proje ekranındaki "Durum" sekmesi yaşam döngüsü, indeks+SHA, kadro, görev kuyruğu, workspaces, onaylar, maliyet ve açık portları tek uçtan gösterir; imported READY ekranı structured Project Understanding + "Bu projede ne yapmak istiyorsun?" akışını sunar.
