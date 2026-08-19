# ACOS — Uygulama Agent'ı Çalışma Emri

**Sürüm:** 2026-08-15 (rev 2) · `7219857` sonrası
**Bu dosya:** Yetki sınırların + tek birleşik yapılacaklar listesi. `CLAUDE.md` ile oku; çelişkide `CLAUDE.md` ve `_DECISIONS.md` üstündür.
**Kaynak incelemeler:** `CODE-REVIEW-2026-08-15.md` (runtime) · `CODEREVIEWHAFIZA.md` (hafıza) · `ACOSHEDEFBOSLUKANALIZI.md` (vizyon boşluğu). Üçünün bulguları burada **doğrulanmış ve tekilleştirilmiş** halde.

> ⚠️ **Kaynak incelemelerin satır numaralarına güvenme.** Hafıza ve boşluk analizleri daha eski bir GitHub klonunda yapıldı; numaralar kaymış, bazı bulgular çoktan düzeltilmiş. Her maddeyi **yerel kodda doğrula** (§1.6).

---

## §1 — YETKİ SINIRLARI

### 1.1 Neyi yeniden vermeyeceksin

- **Stack seçimi** (Postgres/Temporal/NATS/Fastify/Drizzle/React yerine başkası)
- **Var olan tablo/sütun/event/state adını** değiştirmek, kaldırmak, anlamını değiştirmek
- **INV-1…21**'den birini gevşetmek
- **ADR'lerde reddedilmiş** bir şeyi geri getirmek (Redis, Kafka, K8s, üçüncü parti ajan framework'ü)

### 1.2 Neyi YAPMAKLA YÜKÜMLÜSÜN

Bunlar mimari karar **değil**, mimarinin **uygulanmasıdır** — engellenmiş değil, beklenen iştir:

- **Dokümanda tarif edilmiş ama kodda olmayan şeyi yazmak.** Doküman spec'tir, kod ondan geridir. Farkı kapatmak "yeniden karar vermek" değil, **eksik uygulamayı tamamlamaktır.**
- **Toplamalı migration** — yeni tablo, yeni nullable/default'lu sütun, yeni index. Var olanı bozmuyorsa ve bir dokümana dayanıyorsa **izinlidir.**
- **Kod–doküman çelişkisinde kodu dokümana getirmek** (port şekli, imza, veri şekli dahil).
- **Wiring hatalarını düzeltmek** — arayüz tanımlı ama bağlanmamışsa bağla.

### 1.3 Çelişki çözüm sırası (`CLAUDE.md`)

```
_DECISIONS.md  →  domain dokümanı (NN-*.md)  →  ADR
```

**Kod bu listede yok.** Kod bir domain dokümanıyla çeliştiğinde **doküman kazanır**. Kodu dokümana uydurmak asla yetki aşımı değildir; tersi yetki aşımıdır. Domain dokümanı bir ADR ile çelişirse **domain dokümanı kazanır**.

### 1.4 Karar ağacı

```
Yapmak istediğim şey…
├─ Bir domain dokümanında / _DECISIONS'ta tarif edilmiş mi?
│   ├─ EVET → YAP. Bölümü commit'te ve kod yorumunda cite et. SORMA.
│   └─ HAYIR ↓
├─ Var olan tablo/sütun/event/state'i yeniden adlandırıyor,
│  kaldırıyor veya anlamını değiştiriyor muyum?
│   ├─ EVET → DUR, sor.
│   └─ HAYIR ↓
├─ Tamamen toplamalı mı, var olan davranışı bozmuyor mu?
│   ├─ EVET → YAP, gerekçeyi yaz.
│   └─ HAYIR → DUR, sor.
```

### 1.5 Tıkandığında

1. **Hedefi koru, adımları at.** İnceleme raporu **hipotezdir**; bağlayıcı olan ulaşılmak istenen **sonuçtur**, önerilen adımlar değil.
2. **Cevaba bağlı olmayan her şeyi bitir.** Sıfır teslimatla bekleme.
3. **Varsayımını yazılı beyan et, devam et.**
4. **Yalnızca** geri dönülemez zarar (veri kaybı, güvenlik açığı, invariant ihlali) riski varsa dur.

### 1.6 Bir bulguyu uygulamadan önce

Önce **premisi doğrula**, sonra kod yaz: iddia edilen dosya/satır/sütun **var mı**? Doküman bölümü **gerçekten öyle mi diyor**? Semptom **gözlemlenebiliyor mu**?

- Premis yanlış + sonuç doğru → **hedefi uygula, yolu değiştir**, raporda düzelt.
- İkisi de yanlış → bulguyu reddet, gerekçeyi yaz.

> **Not:** B1'de tam olarak doğru davrandın — premisi çürüttün, şema gerektirmeyen yarıyı gönderdin. Tek eksik §1.2'yi kullanmamandı. Aşağıdaki listede **her madde dayanağıyla birlikte yetkilendirilmiştir**; hiçbiri için sormana gerek yok.

---

## §2 — DURUM

### Bitmiş (kodda doğrulandı — tekrar yapma)

| Bulgu | Kanıt |
|---|---|
| **B2** `prepare()` köprüsü | `app.ts` sarmalayıcısında |
| **B3** timeout/retry ayrıştırma | ayrı dispatch proxy (45 dk, retry 1) + `in_flight` fail-closed |
| **B5** gözlem kırpma | alan-farkındalı bütçe, pencere 5→8; **canlıda doğrulandı** (40. adımda başarılı `fs.edit`) |
| **Y7** temperature/refusal | `acceptsTemperature()` + `refused` LlmError |
| **Y1** `request_help`/`record_decision` | `agent-task.ts:1016,1044` + exhaustiveness guard |
| **B1** maliyet kod tarafı | `pricing-defaults.ts`, `resolveProviderPricing`, `main.ts` wiring, `logLlmCall` |
| **B4** hayalet araçlar | katalog 9 araca indi, `SEED_GRANT_TOOLS` temizlendi |

> Boşluk analizinin "kod yazma 🟡 KISMİ" notu **o an aslında 🔴 idi** (B2/B3 ilk araç çağrısını kesin öldürüyordu). İkisi de düzeldi. Aynı analizin "50/50 salt-okuma / guard yara bandı" kanıtı da artık geçersiz — kök neden B5'ti, düzeltildi.

### Doğrulanmış açık boşluklar

`ACOSHEDEFBOSLUKANALIZI.md`'nin dokuz iddiasını koda karşı test ettim: **sekizi tam doğru**, biri (`hedef delege edilince DONE oluyor`) artık `REVIEW`'a taşındığı için harfiyen eskimiş ama **özü — join yok — aynen geçerli**.

Kritik keşif: **"eksik" denen üç mimari parçanın üçü de dokümanda tam tarif edilmiş, sadece yazılmamış.** Yani hiçbiri yeni karar gerektirmiyor — §1.2'nin birinci maddesi.

---

## §3 — YAPILACAKLAR

Her madde: **dayanak → iş → kabul kriteri**. Dayanağı olan her madde §1.2 gereği yetkilidir.

---

### FAZ A — Sistem kendi kendine aksın

*Bu faz bitmeden hiçbir üst katman kanıtlanamaz.*

#### `A1` — `model_providers.pricing` sütunu (B1'in son parçası)

**Dayanak:** `26-COST-MANAGEMENT.md` §3.1 sütunu adıyla, tipiyle, JSON şekliyle tarif ediyor: *"model_providers.pricing (JSONB), platform-level, editable in Settings → Providers"* + seed defaults `packages/llm/pricing-defaults.ts`'ten.

**İş:**
1. `identity.ts` → `modelProviders`'a `pricing: jsonb("pricing").notNull().default({})`
2. `drizzle-kit generate` ile migration + meta snapshot + journal **üret** (elle yazma — `@acos/db` lint'i `drizzle-kit check` koşuyor)
3. `packages/db`'ye `loadProviderPricing(db)`: doküman şeklinden (`in_per_mtok_cents`) `ProviderPricingTable`'a (`inputPerMTokCents`) çevir; **boş `{}` ise `pricingDefaultsFor(kind)`'a düş**
4. `main.ts:123-140` → `loadProviderPricing` kullansın, defaults fallback kalsın
5. `seed.ts` → `ensureLiveModelRouting` provider satırını `pricing` ile bassın (`source: "seed"`)

**Dokunma:** var olan `model_providers` sütunları; `llm_calls`/`cost_entries` şekli; fiyatın `llm_calls.cost_cents`'e denormalize edilmesi (26 §3.1: *"historical entries never re-price"*).

**Kabul:** entegrasyon testi — sütuna doküman-şekilli JSON yaz, `loadProviderPricing` doğru tabloyu üretsin. (`pricing.test.ts` lookup'ı zaten kapsıyor, tekrarlama.)

#### `A2` — Maliyet transaction bütünlüğü

**Dayanak:** INV-11 (olay + durum aynı tx) ve INV-19.

**İş:** İki yerde maliyet, ait olduğu tx'in dışında:
- `gateway.ts:653-662` — `costs.recordCost`, invocation güncelleme tx'inin dışında
- `agent-task.ts` `persistStepActivity` — `.then()` içinde

B1 düzeldiği için bu yarış artık gerçek. İkisini de kendi tx'ine al.

**Kabul:** tx ortasında kasıtlı hata → maliyet ve durum birlikte geri alınıyor.

#### `A3` — Bütçe yarışı ve sınırsız fallback

**Dayanak:** INV-19, `26 §4`.

**İş:** `gateway.ts:790` `tightestBudget` rezervasyonsuz — N paralel çağrı aynı `remainingCents`'i okuyup hepsi geçiyor. `FOR UPDATE` ile kilitle **veya** dispatch öncesi tahmini rezerve et. Ayrıca bütçe satırı yoksa `MAX_SAFE_INTEGER` = **sınırsız**; seed her şirkete günlük bütçe satırı bassın.

**Kabul:** 10 paralel çağrı, bütçe 5 çağrılık → 5'i geçer, 5'i `deny`.

#### `A4` — `dependencyResolved` sinyal köprüsü

**Dayanak:** `07-TASK-ENGINE.md` §3, birebir: *"When a predecessor reaches DONE, the state-machine service emits `task.dependency.resolved` and **signals `dependencyResolved` into every waiting dependent workflow** (08 §5)."* `09-WORKFLOW-ENGINE.md` §9: *"Every producer of `messageReceived`, **`dependencyResolved`**, verdicts, directives, `cancel` is fire-and-forget."*

**Doğrulanan durum:** Emit var (`task-engine.ts:750`), handler var (`agent-task.workflow.ts:164`), **gönderen yok**. Repoda tek bir `signal("dependencyResolved", …)` çağrısı bile yok. DAG yalnız timeout'la uyanıyor.

**İş:** `messageReceived` köprüsünün aynısını kur (`server/main.ts:61-70` kalıbı): `task.dependency.resolved` olayını tüketen bir consumer, bekleyen her bağımlı görevin workflow handle'ına `dependencyResolved` sinyali göndersin. `10 §5`'e göre teslimat `signalId` ile dedupe edilmeli.

**Kabul:** entegrasyon testi — A görevi B'yi blokluyor, A DONE olunca B'nin workflow'u **timeout beklemeden** uyanıyor.

#### `A5` — Konteyner roll-up (teslimat join'i)

**Dayanak:** `07-TASK-ENGINE.md` §2, birebir: *"`goal` and `initiative` … are containers; their status is **derived-but-persisted** — a nightly job plus **child-completion triggers** move a container to DONE when all children are terminal-successful, FAILED if any critical-path child FAILED without replacement."* `[WRITER-DECISION]` — yani kayıtlı karar.

**Doğrulanan durum:** `task-engine.ts`'te `to === "DONE"` dalında **çocuk kontrolü yok**. CEO script'i `delegate_task` → hemen `complete_task` yapıyor. Hedef, çocukların teslimatı beklenmeden kapanıyor.

**İş:** Çocuk terminal olduğunda tetiklenen roll-up: tüm çocuklar terminal-başarılıysa konteyner DONE; kritik-yol çocuğu ikamesiz FAILED ise FAILED. `TaskStateService` içinde (INV-13 — tek durum yazarı). `goal`/`initiative` kindlerinde bireysel `complete_task` ile DONE'a gitmeyi engelle.

**Kabul:** 2 çocuklu initiative — biri DONE'ken parent açık kalıyor, ikincisi DONE olunca parent otomatik DONE ve `task.completed` yayılıyor.

#### `A6` — `stuck-task-sweep` scheduler'ı

**Dayanak:** `09-WORKFLOW-ENGINE.md` §9 Temporal Schedules tablosu: `stuck-task-sweep` · **every 30m** · *"detects ASSIGNED-too-long / WAITING-past-SLA tasks → manager notifications (07 §7–8)"*. Aynı doküman §4: `agentTaskWorkflow` tetikleyicisi *"task assignment (delegation/**scheduler**)"*.

**Doğrulanan durum:** `server/main.ts`'te üç `setInterval` var (`rollupRefresh`, `retrievalBatch`, `approvalSweep`) — **`stuck-task-sweep` yok**. Görev `WAITING`'e park edilirse (guard, bağımlılık, onay) onu geri alan hiçbir mekanizma yok. İş yalnız üç yoldan ilerliyor: HTTP route, `delegate_task` sonrası, intake sonrası.

**İş:** Sweep'i ekle (mevcut `setInterval` kalıbı kabul — `main.ts:116` "recorded narrowing of the Temporal-cron scheduler activity" zaten kayıtlı sapma). ASSIGNED-çok-uzun ve WAITING-SLA-aşımı görevleri tespit et → yöneticiye bildirim + sahibinin workflow'u ölüyse **yeniden başlat**.

**Kabul:** Guard'la WAITING'e parkedilmiş görev, sweep sonrası yönetici bildirimi üretiyor ve workflow'u canlanıyor.

#### `A7` — 🔴 **TEK KANIT KOŞUSU** (pazarlık dışı)

Üç ayrı e2e yazma — **tek senaryo üçünü birden kanıtlasın:**

> Founder bir hedef verir → CEO decompose eder → alt görev **gerçek artefakt üretir** (commit) → review→QA→merge → parent roll-up ile DONE → `task.completed` → hafıza konsolidasyonu → `memory.created` → panelde görünür. Boyunca: `cost_entries` satırları yazılır, `tasks.spent_cents` artar, bütçe eşiği aşılınca devre kesici ajanları duraklatır, bütçe yükseltilince otomatik devam eder.

Assert edilecekler: (1) devre kesici zinciri, (2) döngü kapanışı (A4+A5+A6), (3) hafıza zinciri.

**Neden bu şart:** Bu projenin **tüm** bloker'ları "kod var ama sistem çalışmıyor" boşluğunda yaşadı. Tip sistemi ve birim testleri hiçbirini görmedi.

---

### FAZ B — Ajan yetkinliği

#### `B1` — `memory.search` + `task.query` dispatch

**Dayanak:** `17 §3.1` araç envanteri; ikisi de `MVP_TOOLS`'ta.
**İş:** `MemoryRetrievalService` ve `TasksService` ile bağla. Sonra katalog satırına (`agent-task.ts:597`) ve `SEED_GRANT_TOOLS`'a geri ekle. **Bağlamadığın aracı katalogda gösterme.**
**Kabul:** ajan `memory.search` çağırıyor, sonuç dönüyor, `tool_invocations` `succeeded`.

#### `B2` — Canlı hafıza tetikleyicileri

**Dayanak:** `12-MEMORY-ARCHITECTURE.md` §5.0 — N-anlamlı-olay, `escalation.resolved`, `experiment.completed`, reflection.
**Doğrulanan durum:** `memory/trigger.ts` toplam **72 satır**, yalnız `task.completed`/`task.failed`. Yorum "recorded MVP narrowing" diyor.
**İş:** 12 §5.0'daki tetikleyicileri ekle. Hafızayı "görev sonu toplu"dan "çalışırken sürekli"ye çeviren tek değişiklik bu.
**Kabul:** görev bitmeden, N olay sonrası anı oluşuyor ve panelde beliriyor.

#### `B3` — Prompt caching

**Dayanak:** `26 §3` maliyet kontrolü; Anthropic prefix-cache.
**Doğrulanan durum:** `ai-sdk.ts`'te `cache_control`/`providerOptions` **hiç yok**.
**İş:** Working set'in **sabit öneki** (system + persona + katalog) cache breakpoint'i alsın; değişken kısım (adımlar, sinyaller) sonra gelsin. Sıra zaten doğru — yalnız işaretleme eksik.
**Kabul:** ikinci adımda `usage.cachedInputTokens > 0`.

#### `B4` — Intake LLM sentez katmanı

**Dayanak:** `14 §3.1` stage 3.
**Doğrulanan durum:** `intake/report.ts:3-5` kendi kaydını tutuyor: *"stage 3's interpretive LLM pass lands with the live synthesis polish"*. 5 bölüm sabit `UNAVAILABLE`.
**İş:** Analizör JSON'u üzerine yorumlayıcı LLM geçişi. Repo'suz (boş fikir) girdi yolunu da destekle — şu an ingest tek zorunlu aşama.
**Kabul:** repo'suz bir proje fikri anlamlı bir intake raporu üretiyor.

---

### FAZ C — Güvenlik ve doğruluk

#### `C1` — `db.inspect` gerçekten salt-okunur (bağlamadan önce)

`definitions.ts:278` regex'i yetersiz: `WITH x AS (INSERT … RETURNING) SELECT` geçiyor; `EXPLAIN ANALYZE DELETE` ifadeyi **çalıştırıyor**. Araç `risk: "R0"`, `sideEffectFree: true` — en düşük denetimle geçiyor.
**İş:** Savunma dispatch'te — ayrı salt-okunur DB rolü + `SET TRANSACTION READ ONLY` + `statement_timeout`. Regex ikinci hat: `explain analyze` ve `\b(insert|update|delete|merge)\b` engelle.

#### `C2` — `fs.write`/`fs.edit` argüman sınırı

Base64 tek shell argümanı olarak gidiyor; `MAX_ARG_STRLEN` 128 KB → pratik tavan **~96 KB**. Şemalar 2 MB / 200 KB vaat ediyor. `fs.edit` tüm dosyayı geri yazdığı için 100 KB'lık dosyada 3 satırlık değişiklik bile patlıyor, hata ham `E2BIG`.
**İş:** Argüman yerine **stdin** (sandbox-manager exec API'sinde yoksa ekle). Şema tavanlarını gerçek limite indir.

#### `C3` — Grant kısıtları

`gateway.ts:734` `startsWith` normalize edilmemiş (`src` → `srcret/`); `gateway.ts:747` DB'den gelen regex **çapasız** (`"main"` → `not-main-really`) ve **ReDoS**'a açık; `gateway.ts:753` `new URL()` try/catch dışında → bozuk URL 500 verir, `deny` değil (fail-closed ihlali).

#### `C4` — Çift workspace

`workspaces.ts:198-210` `(taskId, isolationLevel)` ile anahtarlıyor ama `volumeName` seviye içermiyor → iki workspace, aynı volume. `git.merge`/`checkpointBranch` keyfi birini alıyor. `analysis` `network:"none"` olduğu için orada `terminal.run` sessizce ölüyor.
**İş:** Görev başına tek workspace, seviyeyi gerekene yükselt.

#### `C5` — Küçük güvenlik

`secure` cookie · `AUTH_AUTOLOGIN` boot uyarısı · `User: "1000:1000"` · squid subnet'ini env'den üret.

---

### FAZ D — Gerçek dünya (vizyonun asıl farkı)

*Faz A kanıtlanmadan başlama — aksi halde kanıtsız üstüne kanıtsız yığmak olur.*

#### `D1` — Teslimat: deploy/publish

**Doğrulanan durum:** `deployments` tablosu var ama yorumu birebir *"dark in MVP, schema present"*. `definitions.ts`'te deploy/publish aracı **yok**. Her şey iç bare-repo'da bitiyor.
**İş:** Dış git remote push + bir deploy hedefi + `deployments` tablosunu ve event'lerini devreye al. Yeni araç → Gateway'den (INV-3), risk sınıfı R2+, `founderCategory` değerlendir.

#### `D2` — Entegrasyon modülü (ADR-017)

**Doğrulanan durum:** `packages/` = config, contracts, db, domain, events, llm, tools, ui. `services/` = yalnız sandbox-manager. **Modül yazılmamış.**
**İş:** Adapter modülü + OAuth/kimlik deposu (`secrets` tablosu var, S2 gereği sunucu tarafında çözülmeli).

#### `D3` — Pazarlama aktüasyonu

**Doğrulanan durum:** `marketing.ts`'te 5 tablo, `apps/server`+`workers`+`services` içinde **sıfır** referans.
**İş:** `publish_jobs` dispatcher worker'ı + sosyal/email adaptörleri + analitik ingest. **publish→metrik→öğren** döngüsünü kapat.

#### `D4` — Proje-bazlı egress

**Doğrulanan durum:** `squid.conf` yalnız paket registry'leri + GitHub; `deny all`. Ajanlar dış API'ye erişemiyor.
**İş:** Proje ayarlarından üretilen include (squid.conf yorumu bunu zaten öngörüyor: *"per-workspace additions come from project settings via a generated include"*). S8 ve INV-8 korunsun.

---

### FAZ E — Küçük düzeltmeler

`fs.search` `glob` sessizce yok sayılıyor + grep/ripgrep tutarsızlığı · `.catch(()=>{})` yutmaları (`git.merge`) · `checkpointBranch` `Date.now()>>13` idempotency · her adımda tüm ajanların yüklenmesi · relay toplu işaretleme · `MVP_TOOLS` yorumu (13→14) · `subjectFilters[1]` ölü kod · `guard_stopped` oturumu `"completed"` sayılıyor · dispatch hatasında olay yayılmıyor.

---

## §4 — SIRA

```
A1 → A2 → A3 → A4 → A5 → A6 → A7 (TEK KANIT KOŞUSU)
  → B1 → B2 → B3 → B4
  → C1 → C2 → C3 → C4 → C5
  → D1 → D2 → D3 → D4
  → E
```

**A7 pazarlık dışı.** Faz B'ye A7 yeşil olmadan geçme.
**Faz D'ye Faz A+B tamamlanmadan başlama.**

---

## §5 — HER DEĞİŞİKLİKTE

1. **Önce premisi doğrula** (§1.6). Rapor hipotez, kod gerçek.
2. **INV-1…21 kontrol:** INV-3 (her araç Gateway'den), INV-4 (`CompanyContext`), INV-11 (append-only), INV-13 (`TaskStateService` tek yazar), INV-14 (reviewer ≠ author), INV-19 (guard'lar hep açık).
3. **Yeşil bırak:** `pnpm typecheck && pnpm lint && pnpm test`. Şemaya dokunduysan `pnpm --filter @acos/db lint` + `pnpm test:int`.
4. **Regresyon testi yaz** — wiring hataları tip sistemine görünmez, onları yalnız davranış testi tutar. **Zaten geçen bir testi tekrar yazma** (ör. `router.test.ts` fiyatlamayı kapsıyor; eksik olan wiring'di).
5. **`PROGRESS.md`'ye işle** — madde + tarih + not.
6. **Commit mesajında madde kodunu ve doküman bölümünü cite et:** `fix(cost): A1 — model_providers.pricing sütunu (26 §3.1)`
7. **Yapmadığını söyle.** Kapsamı sessizce daraltma; ne bıraktığını ve nedenini yaz.

---

## §6 — SCRIPTED MOD DÜRÜSTLÜĞÜ

`testing/embeddings.ts:108` `cannedConsolidation` bilinen fixture yoksa `"Consolidated: <key>"` döndürüyor → gerçek görevlerde **çöp anı**. `08-objective-to-tasks.spec.ts` `ceo.objective-decompose.yaml`'daki başlığı birebir assert ediyor — **script tekrarını** kanıtlıyor, planlama kalitesini değil. Nightly canlı test *toolless* ve `abandoned`/`guard_stopped`'ı **geçerli sayıyor**.

Sonuç: scripted mod bir **geliştirme aracıdır, kanıt değil**. Panelde ve dokümantasyonda böyle etiketle. Gerçek kanıt A7'dir.
