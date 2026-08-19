# AGENT COMPANY OS — LIVE CONSOLE & CONTEXT REVISION

## Amaç
Mevcut Agent Runtime'ı yeniden yazma. Şu üç problemi düzelt:

1. Agent çalışırken UI dakikalarca sessiz kalıyor.
2. Founder approval verildikten sonra agent aynı approval için tekrar `wait_for approval` üretebiliyor.
3. Basit agent adımlarında gereksiz büyük context/token taşınıyor.

## Genel Kurallar
- Her taskın hedefini eksiksiz tamamla; mevcut implementasyon kısmen varsa “zaten var” deyip geçme.
- Yalnız ilgili mevcut modülleri geliştir; paralel ikinci sistem kurma.
- Private chain-of-thought gösterme. Yalnız structured status/event/tool çıktıları göster.
- Her taskta tüm repoyu yeniden tarama; ilgili runtime, terminal, approval ve context modüllerine targeted git.
- İş sonunda mevcut `NEW-REVISED.md` dosyasına bu paket için kısa özet ekle.

---

# TASK 1 — Agent Console ≠ Shell

## Şu an
`AgentSessionCell` agent_steps kayıtlarını terminal benzeri gösteriyor; gerçek shell ve agent çalışma akışı aynı kavram gibi algılanıyor.

## Olması gereken
İki görünümü ayır:

```text
Agent Console
Shell
```

**Agent Console:** reasoning lifecycle, tool/action/task/approval/event durumlarını gösterir.  
**Shell:** yalnız gerçek PTY/stdout/stderr gösterir.

CEO gibi shell yetkisi olmayan agentlarda Console ana görünüm olsun; developer agentlarda Console + Shell birlikte erişilebilir olsun.

---

# TASK 2 — Live Runtime Event Stream

## Şu an
UI yalnız action tamamlanıp `agent_step` persist edildikten sonra yeni satır gösteriyor; LLM çağrısı sırasında ekran sessiz kalıyor.

## Olması gereken
Agent runtime aşağıdaki structured eventleri gerçek zamanlı yayınlasın:

```text
context.build.started
context.build.completed
llm.started
llm.completed
action.selected
tool.started
tool.output
tool.completed
task.created
task.delegated
approval.requested
approval.received
wait.started
wait.completed
agent.status
```

NATS/WebSocket mevcut realtime hattını kullan.

Örnek UI:

```text
16:40:01  ◌ Context hazırlanıyor
16:40:02  ✓ 8.4k token context hazır
16:40:02  ◌ Model yanıtı bekleniyor
16:40:08  ✓ Action: create_task
16:40:08  + Backend takım planı oluşturuluyor
```

LLM token-by-token düşüncesini gösterme; yalnız lifecycle/progress göster.

---

# TASK 3 — Active Operation / Heartbeat

## Şu an
Bir model/tool çağrısı uzun sürerse Founder bunun çalışıyor mu takıldı mı olduğunu anlayamıyor.

## Olması gereken
Her aktif runtime operation için:

```text
operationType
startedAt
lastHeartbeatAt
elapsedMs
status
```

tut.

UI saniyelik elapsed timer gösterebilsin:

```text
◌ Model yanıtı bekleniyor · 18sn
◌ Tool çalışıyor: npm test · 42sn
```

Heartbeat/event kesilirse:

```text
⏳ 3dk yeni heartbeat yok
```

göster.

---

# TASK 4 — Durable Approval State

## Şu an
`approvalVerdict` bir signal olarak bir sonraki working set'e eklenip sonra temizleniyor; agent approval'ı gördükten sonraki stepte tekrar unutabiliyor.

## Olması gereken
Approval sonucu task/project context'te kalıcı decision state olsun.

Örnek:

```text
approvalRef
status: pending|approved|rejected|expired
decisionNote
requestedAt
decidedAt
```

Working Set ilgili aktif/son approval state'ini DB'den yüklesin.

Founder onayı sonrası sonraki tüm step'lerde:

```text
Staffing approval: APPROVED
Founder note: "Minimal ekibi onaylıyorum"
```

bilgisi erişilebilir olsun.

Signal yalnız workflow'u uyandırmak için kullanılmalı; truth DB approval state olmalı.

---

# TASK 5 — Duplicate Approval Wait Guard

## Şu an
Approved bir karar sonrası model tekrar `wait_for {what:"approval"}` üretebiliyor ve workflow gereksiz yere park oluyor.

## Olması gereken
`wait_for approval` deterministic validation'dan geçsin.

```text
if referenced/active approval == approved|rejected|expired:
    wait action çalıştırma
    observation: approval_already_resolved
    workflow hemen devam et
```

Aynı requirement/staffing kararı için duplicate approval request de mümkünse dedupe edilmelidir.

LLM'in hatırlamasına güvenme.

---

# TASK 6 — Context Budget

## Şu an
Basit CEO adımlarında dahi çok büyük Working Set oluşabiliyor; task tree, memories, recent steps ve diğer bölümler gereğinden fazla taşınabiliyor.

## Olması gereken
Role/task aware context budget uygula.

Önerilen hedef:

```text
CEO/Manager normal step: 6k–12k input token
Developer normal step: 8k–20k input token
Hard warning: >24k
Hard investigation threshold: >32k
```

Sabit limitleri config yap; model context window'u ile karıştırma.

Context Compiler şu sırayla küçültsün:

1. current task + required decision
2. current project summary
3. active approvals/signals
4. relevant org/staffing state
5. relevant CodeIndex results
6. relevant Memory
7. bounded recent steps

Tüm task tree / tüm memory / uzun eski observations varsayılan olarak prompta girmez.

---

# TASK 7 — Working Set Telemetry

## Şu an
UI toplam tokenı gösteriyor ancak hangi context bölümünün maliyeti büyüttüğü net değil.

## Olması gereken
Her model çağrısında structured telemetry kaydet:

```text
totalInputTokens
cachedInputTokens
systemTokens
taskTokens
projectTokens
orgTokens
codeIndexTokens
memoryTokens
recentStepTokens
signalTokens
outputTokens
modelLatencyMs
```

Founder/Costs ekranında detay şart değil; ilk etapta Agent Console'da kısa gösterim yeterli:

```text
Context 9.2k
Memory 1.4k
Code 2.1k
Recent 0.8k
Model 6.4sn
```

Bu telemetry sonraki optimizasyonların ölçüm kaynağı olsun.

---

# ZORUNLU DAVRANIŞ

Oktay staffing approval aldıktan sonra örnek doğru akış:

```text
approval.received
→ DB approval = approved
→ agent wakes
→ Console: "Founder approval received"
→ staffing mutation başlar
→ team/agent creation
```

Şu davranış artık oluşmamalı:

```text
approval received
→ record_decision
→ approval signal silinir
→ wait_for approval
→ 15dk park
```

---

# UI HEDEFİ

Agent Console yaklaşık şu akıcılıkta görünmeli:

```text
Oktay — TASK-1

✓ Founder approval received
◌ Staffing plan uygulanıyor
+ Backend team oluşturuldu
+ Backend Developer işe alındı
+ Frontend team oluşturuldu
+ Frontend Developer işe alındı
◌ Model bindings hazırlanıyor
✓ Organizasyon güncellendi
◌ Task DAG hazırlanıyor
```

Shell gerektiğinde ayrı sekmede gerçek PTY olarak akmalı:

```text
$ npm test
...
PASS
```

---

# Final

Tüm tasklar tamamlanınca mevcut `NEW-REVISED.md` dosyasına yalnız şunu ekle:

```md
## Live Console & Context

### Console
1-2 cümle.

### Approval
1-2 cümle.

### Context
1-2 cümle.
```

`PROGRESS.md` kullanılıyorsa tek kısa kayıt ekle; uzun implementation günlüğü yazma.
