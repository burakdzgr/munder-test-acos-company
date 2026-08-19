# AGENT COMPANY OS — PROJECT LIFECYCLE & CONTEXT ARCHITECTURE

## Amaç
Mevcut çalışan ACOS çekirdeğini genişlet. Paralel/ikinci bir sistem kurma; mevcut Project Intake, GitHub, Scheduler, CodeIndex, Memory, Agent Runtime, Tool Gateway, Sandbox ve Preview yapılarını bu modele taşı.

Öncelik: **doğru temel mimari + düşük token maliyeti + tekrar repo taramama**.

## Uygulama Kuralları
- Her taskın hedefini eksiksiz gerçekleştir; mevcut kod kısmen varsa “zaten var” deyip geçme.
- Task gerektiriyorsa mevcut kodu refactor/genişlet; yalnız ilgisiz çalışan davranışları bozma.
- Yeni paralel servis yerine mümkün olduğunca mevcut modülü geliştir.
- Her taskta tüm repoyu baştan okuma. Önce mevcut index/doküman ve hedef modülleri kullan; yalnız eksik bağ için targeted search/read yap.
- Deterministik yapılabilecek analizleri LLM'e yaptırma.
- Secret/token hiçbir agent promptuna, memory'ye, log'a veya workspace'e girmez.
- İş sonunda mevcut `NEW-REVISED.md` dosyasına bu paket için kısa bir bölüm ekle; her task 1-2 cümle.

---

# TEMEL MODEL

```text
Company
 ├─ Teams
 ├─ Agents
 └─ Projects
      └─ Repositories (1..N)
```

**Project tek repoya hard-code edilmemeli.** MVP'de bir repo oluşturulabilir/bağlanabilir ancak veri modeli bir projenin birden fazla repository taşımasına izin vermeli.

Agent kimliği modelden bağımsızdır. LLM seçimi `Agent/Model Binding` üzerinden yapılmalı ve gerektiğinde task/purpose bazlı override edilebilmelidir.

---

# TASK 1 — Project Entry UX

## Şu an
Project creation/intake akışı mevcut ancak kullanıcı açısından iki net ürün yolu tek lifecycle altında tanımlı değil.

## Olması gereken
Yeni proje ekranında yalnız iki ana seçenek olsun:

### 1. `Projeni Dahil Et`
- GitHub repository URL
- GitHub connection seçimi/gerekirse credential
- Proje adı opsiyonel; repo metadata'dan üretilebilir.

### 2. `Proje Oluştur`
- Proje adı
- Yapılmak istenen iş / objective
- GitHub connection
- İsteğe bağlı başlangıç takım/agent yapısı
- Agentların LLM model seçimleri

İki yol aynı `Project Lifecycle` altında birleşmeli.

---

# TASK 2 — Project State Machine

## Şu an
Project intake ve task statusları var fakat proje seviyesinde tüm lifecycle açık bir state machine olarak kullanılmıyor.

## Olması gereken
Project lifecycle en az şu mantığı taşısın:

```text
DRAFT
→ REPOSITORY_SETUP
→ INDEXING
→ READY
→ PLANNING
→ STAFFING_REVIEW
→ WAITING_FOR_FOUNDER (gerektiğinde)
→ EXECUTING
→ PAUSED / COMPLETED / FAILED
```

Import edilen proje `READY` olduğunda **otomatik kodlama başlamasın**. Kullanıcıya:

> “Proje indekslendi. Bu projede ne yapmak istiyorsun?”

aşamasına gelinsin.

Greenfield projede objective zaten verildiği için `READY → PLANNING` otomatik ilerleyebilir.

Workflow retry/idempotency güvenli olmalı; aynı repo, takım, agent veya initial commit tekrar yaratılmamalı.

---

# TASK 3 — Existing Project Import

## Şu an
Repo ingest + analyzer + CodeIndex var.

## Olması gereken
`Projeni Dahil Et` sonrası repository sandbox üzerinden sisteme alınsın ve **tam proje indeksleme işi bitmeden READY olmasın**.

Index en az şunları kapsasın:

- file/folder tree
- package/module boundaries
- languages/frameworks
- dependencies
- classes/functions/methods/symbols
- imports/exports
- references
- call / called_by
- tests ve test→symbol ilişkileri
- configs/env variable names
- CI/build/test/dev commands
- git branches/default branch
- commit/head SHA
- architecture/module relations
- generated/vendor/binary/large-file ignore bilgisi
- security/config metadata
- code content hashları

Kodun tamamı prompta taşınmamalı. **CodeIndex tüm projeyi bilmeli; LLM yalnız sorgu sonucu gerekli snippetleri görmeli.**

Index sonucu `repository + commit SHA` ile versionlanmalı.

---

# TASK 4 — Language-Aware CodeIndex

## Şu an
AST tabanlı CodeIndex başladı ancak belirli dil implementasyonuna bağımlı kalma riski var.

## Olması gereken
CodeIndex modüler `LanguageIndexer` yaklaşımına sahip olsun.

Örnek:

```text
TypeScriptIndexer
JavaScriptIndexer
PHPIndexer
PythonIndexer
GoIndexer
GenericTextIndexer
```

Mevcut TypeScript Compiler API implementasyonu korunabilir; sistem yeni dil adapterı eklenebilecek şekilde kurulmalı.

Index canonical olarak:

```text
Repository
→ File
→ Symbol
→ Edge
```

grafiği üretmeli.

Edge örnekleri:

```text
imports
references
calls
called_by
implements
extends
tested_by
defines
```

---

# TASK 5 — Incremental + Branch Overlay Index

## Şu an
Merge diff sonrası incremental indexing mevcut.

## Olması gereken
Full scan yalnız ilk import/rebuild içindir.

```text
Git diff
→ changed files
→ changed symbols
→ affected edges
→ incremental index update
```

Concurrent agent worktree'ları için:

```text
Canonical Index = default branch HEAD
Task Overlay Index = task branch/uncommitted changes
```

Context query sırasında `Canonical + Task Overlay` birlikte okunmalı.

Merge sonrası canonical index güncellenip task overlay silinmeli.

Index stale ise agent bunu bilmeli; sessizce eski bilgiyi truth kabul etmemeli.

---

# TASK 6 — Greenfield Repository Creation

## Şu an
GitHub publish mekanizması var ancak greenfield lifecycle açık şekilde tanımlanmalı.

## Olması gereken
`Proje Oluştur` sonrası:

1. Internal project oluştur.
2. Internal bare repository oluştur.
3. GitHub remote gerekiyorsa CEO `github.repository.create` niyeti üretir.
4. Tool Gateway server-side GitHub connection ile private repo oluşturur.
5. Remote internal repo ile bağlanır.
6. Deterministik minimal başlangıç dosyaları oluşturulur.
7. Initial commit atılır.
8. Canonical CodeIndex başlatılır.
9. Project `READY` olur.
10. Objective CEO planlama akışına gider.

**CEO hiçbir zaman raw GitHub token görmemeli.**

UI kullanıcının PAT/token girmesine izin verebilir ancak token encrypted `GitHubConnection/Secret Store` içinde tutulmalı. Agent yalnız yetkili tool çağrısı yapar.

---

# TASK 7 — GitHub Connection Model

## Şu an
GitHub credential company secret olarak kullanılabiliyor.

## Olması gereken
Credential kullanımını açık bir `GitHubConnection` kavramı altında modelle.

En az:

```text
id
companyId
owner/account
credentialRef
scopes
status
createdAt
lastValidatedAt
```

Project yalnız `githubConnectionId` referansı taşır.

Token:
- DB'de plaintext tutulmaz.
- agent prompt/context'e girmez.
- terminal env'e verilmez.
- log/memory/event payload'a yazılmaz.

CEO/Lead tool çağırır; Tool Gateway credential'ı dispatch anında resolve eder.

---

# TASK 8 — CEO Project Planning

## Şu an
CEO objective üzerinden task üretebiliyor.

## Olması gereken
Greenfield objective veya imported proje için yeni kullanıcı isteği önce `Project/Requirement Analyzer` tarafından yapılandırılsın.

Çıktı:

```text
goal
requirements
constraints
required_capabilities
architecture_decisions
risks
success_criteria
```

Greenfield projede CEO kod tasklarından önce kısa bir architecture plan üretmeli.

Geri döndürülmesi zor, maliyetli veya belirsiz kararlar varsa Founder'a sor; normal teknik seçimlerde Founder'ı gereksiz yere bölme.

Onaylanan kritik kararları Project Memory/Decision olarak kaydet.

---

# TASK 9 — Staffing Gap Analysis

## Şu an
Kullanıcı takım/agent oluşturabiliyor; Scheduler mevcut çalışanlar arasından seçim yapıyor.

## Olması gereken
CEO task dağıtmadan önce proje gereksinimlerini mevcut organizasyonla karşılaştırsın.

Örnek:

```text
Gerekli:
Frontend x2
Backend x1
DevOps x1
SEO x1

Mevcut:
Backend x2
DevOps x1

Eksik:
Frontend x2
SEO x1
```

Kullanıcı yanlış/eksik takım kurmuş olsa bile proje başarısız akışa girmemeli.

Eksik varsa CEO Founder'a tek bir toplu approval göndermeli:

> “Bu proje için Frontend x2 ve SEO x1 eksik. Gerekli takımları kurup agent almama izin veriyor musun?”

Approval içine:
- takım
- role/capability
- agent sayısı
- önerilen model profile
- tahmini maliyet/budget etkisi
- kısa gerekçe

girsin.

---

# TASK 10 — CEO Org Mutation + Agent Factory

## Şu an
Org ve agent yapıları mevcut.

## Olması gereken
CEO şu capability'lere sahip olabilsin:

```text
org.team.propose
org.team.create
agent.hire
agent.assign_project
model.bind
```

Ancak `team.create` ve `agent.hire` varsayılan olarak **Founder approval** gerektirsin.

Approval sonrası CEO:
- eksik takımı oluşturur,
- gerekli agentları Agent Factory ile oluşturur,
- hierarchy/reports_to ilişkilerini kurar,
- capability/tool grants verir,
- seçilen LLM model bindinglerini bağlar,
- project staffing assignment oluşturur.

Team/Agent company-level kalıcı varlıklardır; project yalnız hangi agentların bu projede çalıştığını ilişkilendirir.

CEO eksik uzmanlığı ilgisiz agente zorla atayarak approval mekanizmasını bypass etmemeli.

---

# TASK 11 — Model Selection

## Şu an
Agent/model binding altyapısı var.

## Olması gereken
Setup ekranında her agent için kullanıcı model seçebilsin.

Model identity'den ayrı tutulmalı:

```text
Agent
 └─ ModelBindings
      ├─ default
      ├─ coding
      ├─ planning
      └─ review
```

Model seçimleri registry/profile üzerinden yapılmalı; kod içinde provider/model stringleri dağılmamalı.

Scheduler gerektiğinde taskın ihtiyacına ve budgeta göre izin verilen bindingler arasından seçim yapabilsin.

---

# TASK 12 — Task Graph + Scheduler

## Şu an
Priority/dependency-aware Scheduler ve deterministic candidate score mevcut.

## Olması gereken
CEO doğrudan “şu agente ver” mantığının sahibi olmasın.

CEO:

```text
Task
required capabilities
priority
dependencies
success criteria
risk
```

üretsin.

Scheduler:

```text
skill
workload
project familiarity
historical success
memory affinity
priority
dependency readiness
cost/model suitability
```

ile deterministic assignment yapsın.

Tasklar DAG olarak:

```text
BLOCKED → READY → ASSIGNED → RUNNING
```

ilerlesin.

Agent başına tek aktif runtime korunmalı; queued işler priority üzerinden drain edilmeli.

---

# TASK 13 — Context Compiler / Token Architecture

## Şu an
CodeIndex + Memory retrieval mevcut ancak tüm agent görevleri için tek zorunlu context pipeline haline getirilmeli.

## Olması gereken
**Her task LLM'e gitmeden önce**:

```text
Task
 ↓
Task Analyzer
 ↓
CodeIndex Query
 ↓
Memory Query
 ↓
Context Compiler
 ↓
Minimal Context Pack
 ↓
Agent
```

### Task Analyzer
Tasktan:
- domain
- intent
- required capabilities
- likely modules
- likely symbols
- likely tests
- search terms
çıkarır.

### Retrieval sırası
1. exact symbol/path
2. Code Graph neighbors
3. project decisions/procedures/failures
4. semantic CodeIndex/memory search
5. bounded source snippet reads
6. yalnız sonuç yetersizse bounded `fs.search`

**Agentın varsayılan davranışı tüm repoyu taramak olmamalı.**

---

# TASK 14 — Anti-Rescan / Read Budget

## Şu an
Read-loop guard var fakat agent hâlâ task başında “kod nerede?” diyerek geniş taramaya yönelebilir.

## Olması gereken
Project index `READY` ise agent önce CodeIndex kullanmak zorunda olsun.

Kurallar:
- Full-repo `find/grep/read` ilk seçenek olamaz.
- Aynı taskta tekrar edilen search/read dedupe/cache edilmeli.
- CodeIndex sonucu file/symbol hedeflerini vermeden geniş source read yapılmamalı.
- Source dosyada yalnız gerekli symbol/range okunmalı.
- Index sonucu yetersiz/stale ise sınırlı fallback search açılmalı ve bulunan bilgi indexe geri beslenmeli.
- Context Pack token budgetlı olmalı.
- Önceki taskta aynı commit üzerinde alınmış güvenilir query sonucu cache'den kullanılabilmeli.

Amaç:

```text
Task
→ 3-10 ilgili symbol/file
→ gerekli snippet
→ edit
```

Akışını varsayılan yapmak.

---

# TASK 15 — MemoryOS Separation

## Şu an
Memory ve CodeIndex bağlı çalışıyor.

## Olması gereken
İki truth kaynağını karıştırma:

### CodeIndex
Kodun yapısal gerçeği:
- files
- symbols
- edges
- tests
- commits

### MemoryOS
Organizasyonel/deneyimsel bilgi:
- decisions
- procedures
- failures
- episodes
- relationships

Memory bir symbol/file/commit/test referansı taşıyabilir ancak kaynak kodun yerine geçmemeli.

Context Compiler ikisini birleştirsin.

Memory candidate→evidence→promotion→supersession mevcut güvenli modeli korunmalı.

---

# TASK 16 — Workspace / Git Execution

## Şu an
Bare repo + task worktree + sandbox akışı var.

## Olması gereken
Her coding task:

```text
Project Repository
→ task branch/worktree
→ isolated workspace
→ agent runtime
→ tests/review
→ merge
→ canonical index update
```

üzerinden çalışmalı.

Agentlar birbirinin worktree'ını doğrudan değiştirmemeli.

Imported repo'da default branch korunmalı.
Greenfield repo ilk commit sonrası aynı akışa girmeli.

GitHub external remote bir publish/sync target; internal repository çalışma sırasında platform source-of-truth olmaya devam etmeli.

---

# TASK 17 — Project Preview + HTTP Client

## Şu an
Preview Gateway ve port discovery mevcut.

## Olması gereken
Bunu project runtime'ın standardı yap.

Agent:

```text
npm run dev / equivalent
```

çalıştırdığında:
- listening port keşfedilir,
- `port.opened` event'i çıkar,
- Preview Gateway güvenli URL üretir,
- Founder `Open Preview` ile açabilir.

Ayrıca agent/QA için ayrı `http.request` tool'u olsun:

```text
GET/POST/PUT/PATCH/DELETE
headers
body
expected status
```

Yalnız ilgili project workspace'in keşfedilmiş local portlarına erişebilsin.

Amaç: hazırlanmakta olan uygulama hem kullanıcı tarafından görüntülenebilsin hem agentlar API/UI entegrasyonunu HTTP üzerinden doğrulayabilsin.

---

# TASK 18 — Imported Project Ready Screen

Index tamamlandığında kullanıcıya kısa Project Understanding göster:

```text
Repository
Stack
Main modules
Run/test commands
Index status
HEAD SHA
```

Uzun LLM raporu üretme; structured index verisinden render et.

Ardından tek ana aksiyon:

> “Bu projede ne yapmak istiyorsun?”

Kullanıcı isteği yeni GOAL oluşturup CEO planning pipeline'ına girsin.

---

# TASK 19 — Greenfield Ready/Start Flow

Greenfield proje için akış:

```text
User creates project
→ internal repo
→ GitHub repo
→ initial commit
→ initial CodeIndex
→ requirement analysis
→ CEO architecture plan
→ staffing gap analysis
→ Founder approval if needed
→ team/agent updates
→ task DAG
→ Scheduler
→ execution
→ preview
→ review/merge
→ incremental CodeIndex
→ Memory consolidation
```

Bu akış tek bir resumable orchestration üzerinden gözlemlenebilir olmalı; yarıda restart olursa kaldığı adımdan devam etmeli.

---

# TASK 20 — Observability

Founder project ekranında en az şunları görebilsin:

```text
Project lifecycle state
Repository/index status
Current HEAD/index SHA
Teams assigned
Agents/status/current task
Task DAG/queue
Active workspaces
Open preview ports
Approvals
Cost/token usage
Recent merges
Memory/index health
```

Index çalışırken progress göster; sistem sessizce “hazır” görünmemeli.

---

# ZORUNLU INVARIANTS

1. Raw secrets agentlara verilmez.
2. Imported project full initial index tamamlanmadan READY olmaz.
3. READY index commit SHA ile bağlıdır.
4. Her taskta full repo rescan yapılmaz.
5. Canonical CodeIndex + task overlay birlikte sorgulanır.
6. Project veri modeli 1..N repository destekler.
7. Agent identity LLM modelinden ayrıdır.
8. CEO org değiştirebilir ancak hire/team-create Founder approval ile yapılır.
9. Approval fail-closed.
10. Scheduler assignment'ın deterministic sahibidir.
11. Agent task worktree izolasyonu korunur.
12. GitHub remote çalışma sırasında platformun tek truth kaynağı değildir.
13. Memory kaynak kodun yerine geçmez.
14. LLM'e yalnız minimum gerekli context verilir.
15. Workflow retry duplicate repo/team/agent/commit yaratamaz.

---

# IMPLEMENTATION TOKEN DISCIPLINE

Bu paketi geliştirirken de aynı prensibi uygula:

```text
Taskı oku
→ ilgili mevcut modülü belirle
→ targeted search/read
→ implement et
→ ilgili test
→ sonraki task
```

Her taskta “bakayım kod nerede” diyerek tüm repo ağacını yeniden okuma.

Önceden doğrulanmış path/modül bilgisini tekrar keşfetme.
Uzun ara rapor yazma.
Kod dışı token tüketimini minimum tut.

---

# Final

Tüm tasklar sonunda mevcut `NEW-REVISED.md` dosyasına:

```md
## Project Lifecycle & Context Architecture

### Project Entry
1-2 cümle.

### Repository & Index
1-2 cümle.

### CEO & Staffing
1-2 cümle.

### Scheduler & Context
1-2 cümle.

### Preview & Runtime
1-2 cümle.
```

şeklinde kısa özet ekle.

Ayrıca `PROGRESS.md` kullanılıyorsa bu paket için **tek kısa kayıt** ekle; uzun implementation günlüğü yazma.
