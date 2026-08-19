# AGENT COMPANY OS — REVISION TASKS

Amaç: Mevcut mimariyi koruyarak aşağıdaki eksikleri minimum değişiklikle tamamla. Gereksiz refactor, yeniden yazım ve uzun açıklama yapma; tokenların çoğu kod üretimine gitsin.

## Genel Kurallar
- Her taskta yalnız ilgili dosya/modülleri değiştir.
- Çalışan mevcut mimariyi bozma.
- Gereksiz yeni abstraction oluşturma.
- Test gerekiyorsa yalnız değişiklikle doğrudan ilgili testleri ekle/güncelle.
- İş bitince kökte `NEW-REVISED.md` oluştur.
- `NEW-REVISED.md` içinde her task için sadece 1-2 cümleyle ne değiştirildiğini yaz.

## TASK 1 — Scheduler
**Şu an:** Agent başına tek aktif task var; diğer `ASSIGNED` tasklar FIFO (`created_at ASC`) ilerliyor ve delegasyon çoğunlukla hierarchy + load üzerinden yapılıyor.

**Olması gereken:** Queue priority/dependency-aware olsun. Agent seçimi hierarchy yanında skill, workload, project familiarity, historical success ve memory affinity üzerinden deterministic score ile yapılsın; LLM yalnız işi tanımlasın, seçimi Scheduler yapsın.

## TASK 2 — Interactive Agent Shell
**Şu an:** PTY çıktısı NATS üzerinden canlı izlenebiliyor ancak terminal tek yönlü; Founder agent terminaline komut gönderemiyor.

**Olması gereken:** Long-lived bidirectional PTY ekle. `terminal.write`, resize ve `agent_control ↔ human_control` takeover/return-control akışı desteklenmeli.

## TASK 3 — Preview Gateway
**Şu an:** Sandbox içinde çalışan localhost portlarını Founder arayüzüne açan port discovery / preview sistemi yok.

**Olması gereken:** Workspace port discovery + güvenli reverse proxy ekle. Founder çalışan web uygulamasını `Open Preview` ile browser içinde açabilsin.

## TASK 4 — CodeIndex / Code Graph
**Şu an:** Project intake `code_graph` analizi regex tabanlı ve sınırlı module/import/export bilgisi üretiyor.

**Olması gereken:** AST/symbol tabanlı CodeIndex oluştur; file, class/function/method, import, reference, call/called_by ve test ilişkilerini sakla. Git diff sonrası yalnız değişen dosya/symbol'ları incremental güncelle.

## TASK 5 — Memory ↔ CodeIndex
**Şu an:** Memory güçlü fakat codebase bilgisiyle ilişkisi sınırlı ve çoğunlukla dosya seviyesinde.

**Olması gereken:** Memory kayıtları canonical file/symbol/commit/test referansları taşıyabilsin. Retrieval önce CodeIndex ile ilgili symbol/dosyaları daraltsın, ardından yalnız gerekli memory ve kod parçalarını context'e alsın.

## TASK 6 — Founder Approval Fail-Closed
**Şu an:** Project intake Founder consultation hata verirse bazı akışlarda otomatik `approved: true` ile devam ediyor.

**Olması gereken:** Approval servisi hata/timeout durumunda otomatik onay vermesin; task `WAITING_FOR_FOUNDER` benzeri güvenli durumda kalsın ve yalnız gerçek approval sonrası ilerlesin.

## TASK 7 — Production Auth Safety
**Şu an:** `AUTH_AUTOLOGIN` production ortamında açık olsa bile server warning vererek ayağa kalkabiliyor.

**Olması gereken:** Production ortamında `AUTH_AUTOLOGIN=true` ise boot fail-closed olsun; geliştirme ortamındaki mevcut kolaylık korunabilir.

## Final
Tüm tasklar tamamlandıktan sonra yalnız kısa özet için kökte:

`NEW-REVISED.md`

oluştur ve şu formatı kullan:

```md
# Revised

## Scheduler
1-2 cümle.

## Interactive Shell
1-2 cümle.

## Preview Gateway
1-2 cümle.

## CodeIndex
1-2 cümle.

## Memory + CodeIndex
1-2 cümle.

## Approval
1-2 cümle.

## Production Auth
1-2 cümle.
```

Uzun rapor, tekrar eden açıklama veya değiştirilmemiş dosyaların özeti yazılmasın.
