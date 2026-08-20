-- VENDORED COPY — do not edit here.
--   source : hive/agents/oscar-mt0b6hjy/E4-LIVE-RUN-PRECONDITION-GATE.sql (Oscar)
--   vendored: 2026-08-20
--   sha256  : eee768f547269dba (of everything below this header)
--
-- Why a copy at all: the harness must be versioned WITH the code it
-- checks, so "which assert set proved this run" has an answer. Why the
-- hash: this copy went stale once and the stale part (4d requiring
-- cost_cents > 0) would have failed a CORRECT run — a rotting assert set
-- is worse than none, because it fails honest work. Oscar notifies on
-- change; this line is the check that does not rely on anyone remembering.

-- E4 CANLI RUN — ÖN KOŞUL KAPISI (Oscar, kontrol düzlemi)
-- Jim'in `scripts/e2e-live-run.mjs --dry` akışında, CANLI KOŞU ATEŞLENMEDEN ÖNCE koşulur.
--
--   psql "$DATABASE_URL" -v company="'<company-uuid>'" -f E4-LIVE-RUN-PRECONDITION-GATE.sql
--
-- Herhangi biri 'FAIL' ise KOŞU ATEŞLENMEZ. Sebep: aşağıdaki şekil sağlanmazsa
-- assert setindeki vakumluluk nöbetçileri (1c/1d, 2d/2e) YANLIŞ SEBEPLE geçer ve
-- koşu "yeşil" görünürken hiçbir şeyi kanıtlamamış olur.
--
-- NEDEN SAYI DEĞİL ŞEKİL: kadro büyüklüğü bir parametre DEĞİL — staffingPlan'ı
-- model öneriyor ve hire onayıyla uygulanıyor (Kevin'in 20 Ağustos koşusu 3 ajan
-- üretti: CEO + Lead + 1 üye). "Tam 4 ajan" dayatmak, ajanları yapay olarak
-- seed'lemek demektir; bu da koşunun kanıtladığı şeyi zayıflatır. Assert'lerin
-- GERÇEKTEN ihtiyacı olan şey bir sayı değil, bir YAPIDIR: en az bir lead ve o
-- lead'in en az bir AKTİF doğrudan raporu.

\set ON_ERROR_STOP on

-- SESSION CAP = 2 (god karari, 2026-08-21). Gerekce: (1) kadro 3 de ciksa 4 de
-- ciksa kapi KESIN devreye girer, boylece T38'in "tavanda gorevi ASSIGNED'da
-- BEKLETIR, DUSURMEZ" alt-iddiasi CANLI kanitlanir; (2) es zamanli oturum
-- azalir, host yuku duser (host bir kez cokmustu); (3) kuyruk Founder'a
-- gorunur hale gelir. Deger PARAMETRE olarak kaliyor (`-v cap=N` ile ezilebilir)
-- ama VERILMEZSE 2 kabul edilir — Jim `-v cap=` gecmeyi unutursa sessizce
-- patlamak yerine kararlastirilmis degerle calissin.
\if :{?cap}
\else
\set cap 2
\endif

-- P1 — En az bir lead'in AKTİF doğrudan raporu var (iddia 1'in ön koşulu).
-- Bu sağlanmazsa 1a zaten FAIL eder; ama kapıda yakalamak, canlı token ve host
-- yükü harcamadan önce durdurur.
SELECT 'P1' AS id,
       'a lead has at least one ACTIVE direct report' AS claim,
       CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       coalesce(string_agg(format('%s -> %s', mgr.name, rep.name), '; '),
                'NO lead/report pair — claim 1 (T40) cannot be tested at all') AS detail
FROM org_edges e
JOIN agents mgr ON mgr.id = e.from_agent_id AND mgr.status = 'active'
JOIN agents rep ON rep.id = e.to_agent_id AND rep.status = 'active'
JOIN positions p ON p.id = mgr.position_id
WHERE e.company_id = :company
  AND e.kind = 'manages'
  AND e.ended_at IS NULL
  AND p.default_role IN ('lead', 'manager');

-- P2 — Eşleşme YÜZEYİ dolu (org_units + positions), agent_skills ise BOŞ.
-- agent_skills'in boş olması TASARIM: Agent Factory onu hiç YAZMAZ, yalnız
-- okur (staffing/service.ts availability sorgusu). Yani bunu "parametre" olarak
-- ayarlamaya gerek yok; ama DOĞRULAMAK gerek — biri elle skill seed'lerse
-- 1c/1d nöbetçileri sessizce vakumlu PASS verirdi.
SELECT 'P2' AS id,
       'match surface populated (units+positions) while agent_skills is empty' AS claim,
       CASE WHEN (SELECT count(*) FROM org_units u WHERE u.company_id = :company) > 0
             AND (SELECT count(*) FROM positions p WHERE p.company_id = :company) > 0
             AND (SELECT count(*) FROM agent_skills a WHERE a.company_id = :company) = 0
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       format('org_units=%s positions=%s agent_skills=%s (skills MUST be 0: seeded skills make guard 1c vacuous)',
              (SELECT count(*) FROM org_units u WHERE u.company_id = :company),
              (SELECT count(*) FROM positions p WHERE p.company_id = :company),
              (SELECT count(*) FROM agent_skills a WHERE a.company_id = :company)) AS detail;

-- P3 — Eşzamanlılık kapısının devreye girebilmesi için cap < aktif ajan sayısı.
-- Kapı hiç devreye girmezse T38'in "tavanda görevi ASSIGNED'da BEKLETİR,
-- DÜŞÜRMEZ" davranışı kanıtlanamaz (o alt-iddiayı düşürmek de meşru bir karar,
-- ama SESSİZCE düşmemeli — burada görünür olur).
-- :cap değeri MAX_LIVE_SESSIONS_PER_COMPANY ile aynı verilmeli.
SELECT 'P3' AS id,
       'session cap is strictly below the active headcount (gate can engage)' AS claim,
       CASE WHEN (SELECT count(*) FROM agents a WHERE a.company_id = :company AND a.status = 'active') > :cap
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       format('active_agents=%s cap=%s%s',
              (SELECT count(*) FROM agents a WHERE a.company_id = :company AND a.status = 'active'),
              :cap,
              CASE WHEN (SELECT count(*) FROM agents a WHERE a.company_id = :company AND a.status = 'active') > :cap
                   THEN '' ELSE ' — the gate will never engage; drop that sub-claim EXPLICITLY or lower the cap' END) AS detail;

-- P4 — Kadro şekli (bilgi + insan gözü için). PASS/FAIL değil.
SELECT 'P4' AS id,
       format('%s', a.name) AS claim,
       coalesce(p.default_role, '?') AS verdict,
       format('unit=%s status=%s', coalesce(u.slug, '-'), a.status) AS detail
FROM agents a
LEFT JOIN positions p ON p.id = a.position_id
LEFT JOIN org_units u ON u.id = a.org_unit_id
WHERE a.company_id = :company
ORDER BY a.employee_number;
