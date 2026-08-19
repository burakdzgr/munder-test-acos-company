# PROMPT — Galaksi Hafıza Görselleştirmesi (R3F + three.js) — kesin uygulama

> Claude Code'a olduğu gibi yapıştır. Kapsam SADECE bu: `apps/web`'de hafıza grafiğini
> codebase-memory-mcp'deki gibi 3D "galaxy" olarak render eden bir sahne. Veri modeline/backend'e
> DOKUNMA (o ayrı). Otorite: `_DECISIONS.md` → NN-*.md → ADR; ADR-003/007 ihlal yok.
> Referans (MIT, blueprint — kopya değil): `DeusData/codebase-memory-mcp` `graph-ui/src/components/*`.

## Stack (kesin — ACOS zaten React 19 + Vite)

```
three  ~0.183
@react-three/fiber        # three'nin React renderer'ı
@react-three/drei         # OrbitControls, Html (etiket/tooltip)
@react-three/postprocessing + postprocessing   # Bloom = galaksi parıltısı
```
Mevcut `apps/web` (Vite/React19/Tailwind/radix) içine kurulur. Cytoscape 2D yerine bu; renderer
değişikliği bir ADR ile sabitlenir (`docs/architecture/docs/adr/ADR-021-memory-graph-renderer.md`).

## Bileşen ağacı (`apps/web/src/features/memory/galaxy/`)

- `GalaxyScene.tsx` — `<Canvas>` + `<OrbitControls>` + `<EffectComposer><Bloom/></EffectComposer>` +
  `<CameraRig/>`. Sahne kökü; koyu uzay arka planı, hafif ambient + 1 point light.
- `NodeCloud.tsx` — düğümleri **InstancedMesh** ile çizer (tek draw call, 500+ düğüm 60fps).
  Her instance = bir memory. **Renk = scope** (company/project/agent), **boyut ∝ importance**,
  **parlaklık/opaklık ∝ confidence**. Şekil basit küre (gezegen/yıldız).
- `EdgeLines.tsx` — `memory_relations` kenarları `THREE.LineSegments` ile; kind'e göre renk
  (contradicts kırmızı, derived_from kalın, supports yeşil, supersedes gri, related_to ince).
- `NodeLabels.tsx` / `NodeTooltip.tsx` — `drei` `Html`; yalnız yakın/hover düğümde başlık, hover'da
  özet + evidence chip. (Uzaktakiler gizli — performans.)
- `CameraRig.tsx` — tıkla→düğüme uç (lerp), çift tıkla→komşuları getir, boşluğa tıkla→galaksiye dön.
- `FilterPanel.tsx` — mevcut 12 §8.1 filtreleri (scope/type/importance/confidence/zaman); canlı uygular.

## Yerleşim — üç galaksi (scope'a göre)

- **company** = merkez çekirdek (yoğun, parlak).
- **project** = merkez etrafında halkalar; her proje ayrı bir "kol".
- **agent** = dış yörünge yıldızları.
- Konum: server-computed offset tercih (deterministik; her yenilemede aynı yer) — yoksa client'ta
  hafif bir kuvvet/rastgele-tohumlu dağılım. Node id → sabit konum (hash) ki düğümler zıplamasın.

## "Dalga" (galaxy wave) hareketi — istenen his

`useFrame(t)` içinde, kamera/sahneyi değil, **düğüm bulutunu** canlandır:
1. **Galaksi dönüşü**: tüm bulut y-ekseninde çok yavaş döner (ör. 0.02 rad/s).
2. **Dalga**: her düğümün y konumuna küçük sinüs ofseti — `y += A * sin(t*speed + phase(id))`,
   `A≈0.15`, `phase` = düğüm id'sinden türetilir. Bu, galaksinin "nefes alan dalga" hissidir.
3. **Yeni anı pop'u**: `memory.created` gelince o instance ölçeği 0→1'e ease-out + kısa **bloom pulse**
   (emissive intensity anlık artıp söner). Yıldız "doğuyor" hissi.
4. Bloom eşiği düşük tutulur ki yüksek-confidence (parlak) düğümler hâlelensin.

## Canlı besleme

`/ws` `memory.*` (RealtimeDispatcher zaten `memory.created` alıyor) → store güncellenir → NodeCloud
instance ekler, EdgeLines kenar ekler; pop animasyonu tetiklenir. Veri kaynağı gerçek API (mock yok).

## Tek motor, iki kaynak (opsiyonel ama mimariye uygun)

Aynı `GalaxyScene` bir `source: 'memory' | 'code'` prop'u alsın; `code` kaynağında düğüm/kenar
tipografisi CodeIndexPort verisine göre değişir (File/Function… ve CALLS/IMPORTS…). Motor aynı,
sadece renk/stil şeması ve etiketler kaynağa göre.

## Performans / kabul

- 500 düğüm + kenarlarda **60fps** (InstancedMesh + LineSegments + uzak etiket gizleme).
- Bloom + OrbitControls + tıkla-uç + hover-tooltip + filtre + canlı pop çalışır.
- 500 düğüm üstü: server cap + cluster fallback (12 §8.2/§8.4) — yeni düğüm eklenmez, uyarı gösterilir.
- `pnpm build && typecheck && lint` yeşil; ADR-021 yazılır; PROGRESS-UI güncellenir.
- Kapsam dışı: backend/hafıza modeli, retrieval, tetikleyiciler — bu iş yalnız görselleştirme.

## Sıra
Önce kısa plan (bileşen dosyaları + veri adaptörü + ADR-021 taslağı), sonra uygulama.
