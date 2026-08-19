# ACOS — Hedefe Ulaşma Boşluk Analizi

Vizyon: Founder bir iş fikri verir; AI ajanlardan oluşan sanal şirket onu **baştan sona planlar,
kod yazar, gerçek dünyaya teslim eder, sosyal medya + pazarlama yapar** — tümü oto-pilotta, Founder
yalnızca hedef verir ve onay/eskalasyonları yönetir.

Yöntem: repo (`burakdzgr/agent-company-os`, main) klonlanıp 4 ayak üzerinden kod okunarak incelendi.
Bulgular kanıtlı (dosya:satır). Aşağıda **ne çalışıyor / ne eksik / hedefe nasıl ulaşırız.**

---

## Tek cümlelik teşhis

**İç motor (org, delegasyon, sandbox, yönetişim) gerçekten iyi kurulmuş; ama vizyonun gerektirdiği
üç bütün katman ya eksik ya kanıtsız: (a) gerçek planlama/anlama zekâsı, (b) gerçek dünyaya
teslimat + dış dünya aktüasyonu, (c) kendini yürüten oto-pilot döngü — ve sistem canlı LLM ile
hiç uçtan uca çalıştırılmadı.** Yani "iskelet doğru, ama şirket henüz *çalışmıyor*."

---

## Vizyon ayakları × mevcut durum

| Ayak | Durum | Kanıt (özet) |
|---|---|---|
| Founder fikri → plan | 🟡 KISMİ | Intake repo'da çalışıyor ama LLM yorum/sentez katmanı yazılmamış; boş fikir (repo yok) sıfır analiz üretiyor. Gerçek planlayıcı/roadmap YOK — decomposition jenerik ajan döngüsünün denetimsiz yan-etkisi, sadece canlı-LLM, kalite test edilmemiş. Delegasyon motoru gerçek ve iyi. |
| Kod yazma (yürütme) | 🟡 KISMİ | Docker sandbox, git, fs, terminal **gerçek ve kanıtlı**. Ama canlı modelin gerçekten teslimat üretmesi kanıtsız ve kırılgan (belgelenmiş 50/50 salt-okuma döngüsü; guard'lar yara bandı). Tamamlanma yolu (review→merge→DONE) gerçek ama yalnız scripted modda kanıtlı. |
| Gerçek dünyaya teslimat | 🔴 YOK | Her şey iç bare-repo'da bitiyor. deploy/publish aracı yok, `deployments` tablosu "dark", dış remote/registry/hosting yok. "Gerçek dünyaya sunma" tamamen eksik. |
| Sosyal medya / pazarlama | 🔴 YOK (iskelet) | DB tabloları + event isimleri + org şablonları var; **çalışma-zamanı aktüasyonu sıfır**. Sosyal API yok, email yok, reklam/analitik yok. Entegrasyon modülü (ADR-017) yazılmamış. Egress proxy dışarıyı paket-registry + GitHub'a kilitli — ajanlar dış API'ye erişemez bile. |
| Öğrenme (hafıza) | 🟡 KISMİ, beslenmiyor | Şema/pipeline/retrieval kurulu; sadece görev bitince tetikleniyor, scripted'da sahte, çalışırken canlı hafıza yok. (Ayrı code-review'da detaylı.) |
| Oto-pilot döngü + otonomi | 🟡 KISMİ | Otonomi/onay/eskalasyon motoru **gerçek ve en güçlü parça**. Ama döngü kapanmıyor: sürekli sürücü/heartbeat yok; bağımlılık uyandırma ölü kod; teslimat roll-up'ı yok (hedef, teslimatla değil delege edilince "tamamlandı" oluyor). |

---

## Kök nedenler (her şeyi tıkayan 4 şey)

1. **Canlı-LLM hiç doğrulanmadı.** Her şey yalnızca scripted modda, elle yazılmış 5 YAML fixture ile
   kanıtlı. Canlı modelde planlama kalitesi, görev tamamlama, hafıza — hepsi kanıtsız.
   (`apps/web/e2e/08-objective-to-tasks.spec.ts` fixture başlıklarını assert ediyor; nightly live test
   **araçsız** ve `abandoned`/`guard_stopped`'ı geçerli sayıyor — `live-llm.nightly.int.test.ts:59,176`.)
2. **Döngü kendini yürütmüyor.** İş yalnız ajanın `delegate_task`'ıyla ilerliyor; hazır/atanmamış
   görevleri alan bir sweeper/heartbeat/orchestrator yok. `task.dependency.resolved` DB event'i
   `dependencyResolvedSignal` workflow handler'ına **hiç köprülenmemiş** (`task-engine.ts:750` ↔
   `agent-task.workflow.ts:151`) → bağımlılık DAG'ı akmıyor, sadece timeout'la uyanıyor.
3. **Gerçek dünyaya aktüasyon katmanı yok.** deploy/publish aracı, entegrasyon/adapter modülü
   (ADR-017), dış remote, kimlik-bilgisi deposu, açık egress — hiçbiri yok. Şirket dışarıya
   *hiçbir şey* yayınlayamıyor/gönderemiyor/harcayamıyor; tek dış eylem read-only `web.fetch/search`.
4. **Hedef tamamlanması kozmetik.** Üst-görev, çocukların teslimatını bekleyen bir join olmadan,
   delege edilir edilmez DONE oluyor (`ceo.objective-decompose.yaml`). "Teslim edildi" sinyali
   tepede hiç oluşmuyor.

---

## Hedefe ulaşmak için yol haritası (bağımlılık sırasına göre)

### FAZ 0 — "Bir kez gerçekten çalışsın" (çekirdeği kanıtla)
Bunlar olmadan diğer her şey havada. Amaç: canlı LLM ile tek bir Founder hedefi uçtan uca aksın.
- **Canlı-LLM + maliyet kontrolü**: prompt caching'i adapter'a bağla, günlük/görev bütçesini kıs,
  Console spend-limit koy (ayrı maliyet notunda detaylı). Ucuz tier'a route et.
- **Döngü yakınsaması**: ajanın 50 adım salt-okumada takılmasını, guard yamasıyla değil, "keşif→
  teslimat→tamamla" politikasıyla çöz. Görevler gerçek artefaktla DONE'a ulaşmalı.
- **Döngü kapanışı**: (1) hazır/atanmamış görevleri dağıtan sürekli bir sürücü (heartbeat/sweeper);
  (2) `task.dependency.resolved` → `dependencyResolvedSignal` köprüsü (DAG aksın); (3) teslimat
  roll-up'ı — hedef, çocukların teslimatıyla tamamlansın.

### FAZ 1 — Çıktıyı gerçek yap (planlama + teslimat)
- **Gerçek planlama/anlama**: intake LLM sentez katmanını yaz; boş fikri (repo yok) de destekle;
  yapılandırılmış roadmap→epik→görev üreten ve **tamlık kontrolü** yapan bir planlama rutini ekle.
- **Gerçek teslimat**: deploy/publish aracı + ADR-017 entegrasyon modülü; dış git remote push;
  bir hosting/deploy hedefi; `deployments` tablosu + event'leri devreye al. ("Gerçek dünyaya sunma".)

### FAZ 2 — Dış dünya aktüasyonu (asıl farklılaştırıcı: sosyal + pazarlama)
- Entegrasyon/adapter modülü: sosyal yayın adaptörleri (X/Instagram/LinkedIn), email/newsletter,
  analitik ingest; OAuth/kimlik deposu; `publish_jobs` dispatcher worker'ı; egress allowlist'i
  proje-bazlı aç; uyuyan marketing tabloları/event'lerini bağla. **publish→metrik→öğren** döngüsünü kapat.

### FAZ 3 — Hafıza kendini beslesin (öğrenme)
- Canlı tetikleyiciler (N-olay, eskalasyon, deney) + çalışırken episodik adım hafızası + canlı-LLM
  gerçek extraction + panelin canlı dolması. (Hafıza code-review'ındaki İ1–İ6.)

**Enine kesen ilke**: canlı-LLM'i birinci-sınıf test yap; scripted modu yalnız geliştirme için tut.

---

## Öncelik önerisi

En kritik ilk hamle **FAZ 0**: çünkü canlı ile bir kez uçtan uca akmayan sistemde planlama, teslimat,
sosyal medya eklemenin hepsi kanıtsız üstüne kanıtsız yığmak olur. FAZ 0 bittiğinde elinde "Founder
hedef verdi → şirket çalıştı → bir şey DONE oldu" gösterilebilir bir çekirdek olur; sonra FAZ 1-2 ile
o çıktıyı gerçek dünyaya taşırsın.
