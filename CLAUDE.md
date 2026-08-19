# AI Agent Company OS

Bu repo docs/architecture/ altındaki mimari pakete göre inşa ediliyor.

## Kurallar
- Giriş noktası: docs/architecture/docs/35-CLAUDE-CODE-HANDOFF.md
- Çelişki durumunda otorite sırası: _DECISIONS.md → ilgili domain dokümanı (NN-*.md) → ADR
- Mimari kararları YENİDEN VERME. Stack, tablo adları, event adları, state machine'ler sabittir.
- 35-CLAUDE-CODE-HANDOFF.md §12'deki 21 invariant asla ihlal edilemez.
- Görevler T01–T50 sırasıyla ve bağımlılık sırasına göre yapılır.
- İlerleme docs/architecture/PROGRESS.md dosyasında işaretlenir (tamamlanan görev + tarih + not).