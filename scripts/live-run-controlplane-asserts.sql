-- VENDORED COPY — do not edit here.
--   source : hive/agents/oscar-mt0b6hjy/E4-LIVE-RUN-CONTROLPLANE-ASSERTS.sql (Oscar)
--   vendored: 2026-08-20
--   sha256  : fc72741830be9158 (of everything below this header)
--
-- Why a copy at all: the harness must be versioned WITH the code it
-- checks, so "which assert set proved this run" has an answer. Why the
-- hash: this copy went stale once and the stale part (4d requiring
-- cost_cents > 0) would have failed a CORRECT run — a rotting assert set
-- is worse than none, because it fails honest work. Oscar notifies on
-- change; this line is the check that does not rely on anyone remembering.

-- E4 CANLI WORKLOAD RUN — KONTROL DÜZLEMİ DOĞRULAMA SETİ (Oscar)
-- Yerleşim Jim'in lane'i (scripts/e2e-*). Bu dosya ASSERT KAYNAĞIDIR.
--
-- Kullanım:
--   psql "$DATABASE_URL" -v company="'<company-uuid>'" -f E4-LIVE-RUN-CONTROLPLANE-ASSERTS.sql
--
-- Her sorgu TEK satır döner: (id, claim, verdict, detail).
-- verdict='PASS' değilse koşu BAŞARISIZDIR. 'detail' her zaman kanıtı taşır.
--
-- NOT (kapsam dürüstlüğü): 1d, 4b ve INV-2'nin prompt tarafı SQL DEĞİLDİR —
-- §SON'daki "SQL OLMAYAN ASSERT'LER" bölümüne bakın. Onları buraya sahte
-- sorgu olarak koymaktansa açıkça dışarıda bırakıyorum.

\set ON_ERROR_STOP on

-- ============================================================ İDDİA 1 (T40)
-- 1a — delege edilen çocuk görevin sahibi, delege EDENİN aktif doğrudan raporu
SELECT '1a' AS id,
       'lead delegated to an ACTIVE direct report' AS claim,
       CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       coalesce(string_agg(format('TASK-%s owner=%s by=%s', t.number, o.name, d.name), '; '),
                'no task was delegated to a direct report') AS detail
FROM tasks t
JOIN task_assignments ta
  ON ta.company_id = t.company_id AND ta.task_id = t.id AND ta.unassigned_at IS NULL
JOIN agents o ON o.id = t.owner_agent_id
JOIN agents d ON d.id = ta.assigned_by_agent_id
JOIN org_edges e
  ON e.company_id = t.company_id
 AND e.from_agent_id = ta.assigned_by_agent_id
 AND e.to_agent_id = t.owner_agent_id
 AND e.kind = 'manages'
 AND e.ended_at IS NULL
WHERE t.company_id = :company
  AND t.owner_agent_id IS NOT NULL
  AND t.owner_agent_id <> ta.assigned_by_agent_id;

-- 1b — o görevlerde requiredCapabilities BOŞ DEĞİL
SELECT '1b' AS id,
       'delegated work carried non-empty requiredCapabilities' AS claim,
       CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       coalesce(string_agg(format('TASK-%s caps=%s', t.number, t.context->'requiredCapabilities'), '; '),
                'no delegated task declared requiredCapabilities') AS detail
FROM tasks t
WHERE t.company_id = :company
  AND jsonb_array_length(coalesce(t.context->'requiredCapabilities', '[]'::jsonb)) > 0;

-- 1c — VAKUMLULUK NÖBETÇİSİ: o etiketlerin HİÇBİRİ eşleşme yüzeyini tutturmuyor.
-- (Eşleşme kuralı üretimdeki ile AYNI: ILIKE '%' || split_part(cap,' ',1) || '%'
--  org_units.slug / positions.title / skills.name üzerinde.)
-- Eşleşen çıkarsa iddia 1 VAKUMLUDUR: eski kod da geçerdi.
WITH caps AS (
  SELECT t.id AS task_id, t.number, jsonb_array_elements_text(t.context->'requiredCapabilities') AS cap
  FROM tasks t
  WHERE t.company_id = :company
    AND jsonb_array_length(coalesce(t.context->'requiredCapabilities', '[]'::jsonb)) > 0
), matched AS (
  SELECT c.number, c.cap
  FROM caps c
  WHERE EXISTS (SELECT 1 FROM org_units u WHERE u.company_id = :company
                  AND u.slug ILIKE '%' || split_part(c.cap, ' ', 1) || '%')
     OR EXISTS (SELECT 1 FROM positions p WHERE p.company_id = :company
                  AND p.title ILIKE '%' || split_part(c.cap, ' ', 1) || '%')
     OR EXISTS (SELECT 1 FROM agent_skills ask JOIN skills s ON s.id = ask.skill_id
                WHERE ask.company_id = :company
                  AND s.name ILIKE '%' || split_part(c.cap, ' ', 1) || '%')
)
SELECT '1c' AS id,
       'VACUITY GUARD: no declared capability matched unit/position/skill' AS claim,
       -- god (2026-08-21): nobetcinin kendisi bir kez daha derinlestirildi.
       -- "Eslesme yok" iddiasi, EŞLEŞME YUZEYININ de dolu olmasini gerektirir:
       -- org_units/positions BOS olsaydi "hicbiri tutmadi" onemsizce dogru olur
       -- ve 1c yanlis sebeple PASS verirdi. agent_skills'in bos olmasi TASARIM
       -- (fabrika onu hic yazmaz — yalniz okur), ama kadro yuzeyi DOLU olmali.
       CASE WHEN (SELECT count(*) FROM caps) > 0
             AND (SELECT count(*) FROM org_units u WHERE u.company_id = :company) > 0
             AND (SELECT count(*) FROM positions p WHERE p.company_id = :company) > 0
             AND count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       CASE WHEN (SELECT count(*) FROM caps) = 0
            THEN 'NOTHING TO SCAN: no task declared capabilities — this guard cannot vouch for anything'
            WHEN (SELECT count(*) FROM org_units u WHERE u.company_id = :company) = 0
              OR (SELECT count(*) FROM positions p WHERE p.company_id = :company) = 0
            THEN 'NOTHING TO SCAN: the match surface (org_units/positions) is empty — "no match" would be trivially true'
            WHEN count(*) = 0
            THEN format('%s capability label(s) scanned, none matched — the relaxed path was genuinely required',
                        (SELECT count(*) FROM caps))
            ELSE 'MATCHED (claim 1 is vacuous, old code would pass too): '
                 || string_agg(format('TASK-%s:%s', number, cap), ', ')
       END AS detail
FROM matched;

-- 1e — koşu boyunca NO_ELIGIBLE_DELEGATE hiç üretilmedi
SELECT '1e' AS id,
       'no NO_ELIGIBLE_DELEGATE anywhere in the run' AS claim,
       CASE WHEN (SELECT count(*) FROM agent_steps x WHERE x.company_id = :company) > 0
             AND count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       CASE WHEN (SELECT count(*) FROM agent_steps x WHERE x.company_id = :company) = 0
            THEN 'NOTHING TO SCAN: the run produced no agent steps'
            ELSE coalesce(string_agg(format('step %s task=%s', s.step_no, s.task_id), '; '),
                          format('none across %s steps — every delegation found a target',
                                 (SELECT count(*) FROM agent_steps x WHERE x.company_id = :company)))
       END AS detail
FROM agent_steps s
WHERE s.company_id = :company
  AND s.observation::text LIKE '%NO_ELIGIBLE_DELEGATE%';

-- ============================================================ İDDİA 2 (T38)
-- 2a+2c — cevabın ARDINDAN yeni bir oturum açıldı (park etmiş sahibi uyandı).
-- Zincir: görev thread'ine mesaj -> aynı görevin SAHİBİ için mesajdan SONRA
-- başlayan oturum + mesajdan ÖNCE kapanmış bir oturum (yani ölü workflow hali).
WITH wake AS (
  SELECT t.number,
         m.created_at AS reply_at,
         s_new.started_at AS woke_at,
         EXTRACT(EPOCH FROM (s_new.started_at - m.created_at)) AS lag_sec
  FROM messages m
  JOIN channels c ON c.id = m.channel_id AND c.company_id = m.company_id
  JOIN tasks t ON t.id = c.task_id AND t.company_id = m.company_id
  JOIN agent_sessions s_new
    ON s_new.company_id = t.company_id
   AND s_new.agent_id = t.owner_agent_id
   AND s_new.task_id = t.id
   AND s_new.started_at > m.created_at
  WHERE m.company_id = :company
    AND c.kind = 'task_thread'
    AND (m.sender_agent_id IS NULL OR m.sender_agent_id <> t.owner_agent_id)
    AND EXISTS (
      SELECT 1 FROM agent_sessions s_old
      WHERE s_old.company_id = t.company_id
        AND s_old.agent_id = t.owner_agent_id
        AND s_old.task_id = t.id
        AND s_old.ended_at IS NOT NULL
        AND s_old.ended_at < m.created_at
    )
)
SELECT '2ac' AS id,
       'a reply on the task thread started a NEW session for the parked owner' AS claim,
       CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       coalesce(string_agg(format('TASK-%s woke %.1fs after the reply', number, lag_sec), '; '),
                'no parked owner was restarted by a reply') AS detail
FROM wake;

-- 2d — SWEEP ATFI NÖBETÇİSİ: uyanış cevaptan < 120 sn sonra.
-- 30 dk'lık sweep de uyandırırdı; bu nöbetçi olmadan iddia 2 VAKUMLUDUR.
WITH wake AS (
  SELECT t.number, EXTRACT(EPOCH FROM (min(s_new.started_at) - m.created_at)) AS lag_sec
  FROM messages m
  JOIN channels c ON c.id = m.channel_id AND c.company_id = m.company_id
  JOIN tasks t ON t.id = c.task_id AND t.company_id = m.company_id
  JOIN agent_sessions s_new
    ON s_new.company_id = t.company_id AND s_new.agent_id = t.owner_agent_id
   AND s_new.task_id = t.id AND s_new.started_at > m.created_at
  WHERE m.company_id = :company AND c.kind = 'task_thread'
  GROUP BY t.number, m.created_at
)
SELECT '2d' AS id,
       'VACUITY GUARD: the wake came from the REPLY, not the 30-min sweep' AS claim,
       CASE WHEN count(*) FILTER (WHERE lag_sec < 120) > 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       coalesce(string_agg(format('TASK-%s lag=%.1fs', number, lag_sec), '; '),
                'no wake observed at all') AS detail
FROM wake;

-- 2e — İKİNCİ SWEEP NÖBETÇİSİ: uyanan görev için stuck-task/sweep eskalasyonu YOK
SELECT '2e' AS id,
       'VACUITY GUARD: no stuck-task sweep escalation for the woken task' AS claim,
       CASE WHEN (SELECT count(*) FROM agent_sessions x WHERE x.company_id = :company) > 0
             AND count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       CASE WHEN (SELECT count(*) FROM agent_sessions x WHERE x.company_id = :company) = 0
            THEN 'NOTHING TO SCAN: the run opened no sessions'
            ELSE coalesce(string_agg(format('seq %s %s', e.seq, e.payload->>'guardFlag'), '; '),
                          'none — the sweep never touched this run')
       END AS detail
FROM events e
WHERE e.company_id = :company
  AND e.type = 'agent.escalated'
  AND e.payload->>'guardFlag' IS NOT NULL;

-- ============================================================ İDDİA 3 (T39)
-- 3a — açık çocuğu olmayan (LEAF) en az bir görev DONE
SELECT '3a' AS id,
       'at least one LEAF task reached DONE' AS claim,
       CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       coalesce(string_agg(format('TASK-%s (%s)', t.number, t.kind), '; '),
                'no leaf reached DONE — work did not finish') AS detail
FROM tasks t
WHERE t.company_id = :company
  AND t.status = 'DONE'
  AND t.kind IN ('task', 'subtask')
  AND NOT EXISTS (SELECT 1 FROM tasks ch
                  WHERE ch.company_id = t.company_id AND ch.parent_id = t.id);

-- 3b — INV-14: o görevin incelemecisi YAZAR DEĞİL
SELECT '3b' AS id,
       'INV-14: the reviewer of the finished leaf is not its author' AS claim,
       CASE WHEN count(*) FILTER (WHERE rev.agent_id = own.agent_id) = 0
             AND count(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       coalesce(string_agg(format('TASK-%s owner=%s reviewer=%s', t.number, own.agent_id, rev.agent_id), '; '),
                'no review assignment found for a DONE leaf') AS detail
FROM tasks t
JOIN task_assignments own ON own.company_id = t.company_id AND own.task_id = t.id AND own.role = 'owner'
JOIN task_assignments rev ON rev.company_id = t.company_id AND rev.task_id = t.id AND rev.role = 'reviewer'
WHERE t.company_id = :company AND t.status = 'DONE';

-- 3c — teslimat MADDİ: task.completed olayı + artifact
SELECT '3c' AS id,
       'the finished work produced task.completed AND a material artifact' AS claim,
       CASE WHEN (SELECT count(*) FROM events e
                  WHERE e.company_id = :company AND e.type = 'task.completed') > 0
             AND (SELECT count(*) FROM artifacts a WHERE a.company_id = :company) > 0
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       format('task.completed=%s artifacts=%s',
              (SELECT count(*) FROM events e WHERE e.company_id = :company AND e.type = 'task.completed'),
              (SELECT count(*) FROM artifacts a WHERE a.company_id = :company)) AS detail;

-- ============================================================ İDDİA 4
-- 4a — INV-3: araç çağrısı VAR ve hepsinin denetim satırı tam
SELECT '4a' AS id,
       'INV-3: every tool invocation has a complete audit row' AS claim,
       CASE WHEN count(*) > 0
             AND count(*) FILTER (WHERE decision IS NULL OR status IS NULL OR tool_name IS NULL) = 0
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       format('rows=%s incomplete=%s tools=%s',
              count(*),
              count(*) FILTER (WHERE decision IS NULL OR status IS NULL OR tool_name IS NULL),
              coalesce(string_agg(DISTINCT tool_name, ','), '-')) AS detail
FROM tool_invocations
WHERE company_id = :company;

-- 4c' — INV-2 (SQL'in görebildiği kadarıyla; prompt metni HİÇBİR tabloda tutulmuyor,
-- bkz. SQL OLMAYAN ASSERT'LER). Burada sızıntının AŞAĞI AKIŞTA görünen izini arıyoruz:
-- ajan aksiyonları, araç gözlemleri ve mesaj gövdeleri.
WITH pat AS (SELECT unnest(ARRAY['acos_pat_', 'ghp_', 'github_pat_', 'INTERNAL_API_TOKEN', 'ACOS_BROKER_SECRET']) AS p)
SELECT '4c' AS id,
       'INV-2 (downstream surface): no secret material in steps/observations/messages' AS claim,
       CASE WHEN (SELECT count(*) FROM agent_steps x WHERE x.company_id = :company)
               + (SELECT count(*) FROM messages x WHERE x.company_id = :company)
               + (SELECT count(*) FROM tool_invocations x WHERE x.company_id = :company)
               + (SELECT count(*) FROM events x WHERE x.company_id = :company)
               + (SELECT count(*) FROM artifacts x WHERE x.company_id = :company) > 0
             AND count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
       CASE WHEN (SELECT count(*) FROM agent_steps x WHERE x.company_id = :company)
                + (SELECT count(*) FROM messages x WHERE x.company_id = :company)
                + (SELECT count(*) FROM tool_invocations x WHERE x.company_id = :company)
                + (SELECT count(*) FROM events x WHERE x.company_id = :company)
                + (SELECT count(*) FROM artifacts x WHERE x.company_id = :company) = 0
            THEN 'NOTHING TO SCAN: no steps, messages, tool rows, events or artifacts — INV-2 is NOT vouched for'
            ELSE coalesce(string_agg(hit, '; '),
                          format('clean across %s scannable rows',
                                 (SELECT count(*) FROM agent_steps x WHERE x.company_id = :company)
                               + (SELECT count(*) FROM messages x WHERE x.company_id = :company)
                               + (SELECT count(*) FROM tool_invocations x WHERE x.company_id = :company)
                               + (SELECT count(*) FROM events x WHERE x.company_id = :company)
                               + (SELECT count(*) FROM artifacts x WHERE x.company_id = :company)))
       END AS detail
FROM (
  SELECT format('agent_steps#%s:%s', s.id, pat.p) AS hit
  FROM agent_steps s, pat
  WHERE s.company_id = :company
    AND (s.action::text LIKE '%' || pat.p || '%' OR s.observation::text LIKE '%' || pat.p || '%')
  UNION ALL
  SELECT format('messages#%s:%s', m.id, pat.p)
  FROM messages m, pat
  WHERE m.company_id = :company AND m.body LIKE '%' || pat.p || '%'
  UNION ALL
  SELECT format('tool_invocations#%s:%s', ti.id, pat.p)
  FROM tool_invocations ti, pat
  WHERE ti.company_id = :company AND ti.input::text LIKE '%' || pat.p || '%'
  UNION ALL
  -- Kevin (2026-08-21): olay yükleri ve teslimat metni de ajanın ürettiği yüzeydir
  SELECT format('events#%s:%s', e.seq, pat.p)
  FROM events e, pat
  WHERE e.company_id = :company AND e.payload::text LIKE '%' || pat.p || '%'
  UNION ALL
  SELECT format('artifacts#%s:%s', a.id, pat.p)
  FROM artifacts a, pat
  WHERE a.company_id = :company AND coalesce(a.content_md, '') LIKE '%' || pat.p || '%'
) leaks;

-- 4d — broker metering: CLI oturumlarının çağrıları oturuma atıflı, ücretli ve roll-up tutuyor
-- DÜZELTME (Kevin, 2026-08-21): ilk sürümde `cost_cents > 0` şartı vardı — YANLIŞ.
-- CLI oturumlarının llm_calls satırları TASARIM GEREĞİ cost_cents=0 (claude-cli
-- fiyatlandırması T5'te AÇIK kart: abonelik harcaması ÖLÇÜLÜR, fiyatlanmaz).
-- O şart DOĞRU bir koşuyu FAIL ettirirdi. Metering kanıtı bu yüzden TOKEN
-- tabanlı: (a) oturuma atıflı satır VAR, (b) ÖKSÜZ satır YOK (var olmayan bir
-- oturuma atıf), (c) roll-up mutabakatı 4d2'de. Tutar bilgi olarak raporlanır,
-- iddia edilmez.
SELECT '4d' AS id,
       'broker metering: session-attributed with no orphan rows (tokens, not price)' AS claim,
       CASE WHEN count(*) FILTER (WHERE l.agent_session_id IS NOT NULL) > 0
             AND count(*) FILTER (
                   WHERE l.agent_session_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM agent_sessions s
                                     WHERE s.company_id = l.company_id AND s.id = l.agent_session_id)
                 ) = 0
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       format('session-attributed=%s orphan=%s tokens_in=%s tokens_out=%s cost_cents=%s (0 expected for CLI, T5)',
              count(*) FILTER (WHERE l.agent_session_id IS NOT NULL),
              count(*) FILTER (
                   WHERE l.agent_session_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM agent_sessions s
                                     WHERE s.company_id = l.company_id AND s.id = l.agent_session_id)),
              coalesce(sum(l.tokens_in), 0), coalesce(sum(l.tokens_out), 0),
              coalesce(sum(l.cost_cents), 0)) AS detail
FROM llm_calls l
WHERE l.company_id = :company;

-- 4d2 — roll-up mutabakatı: agent_sessions sayaçları llm_calls toplamıyla uyuşuyor
WITH per_session AS (
  SELECT s.id,
         s.tokens_in AS s_in, s.tokens_out AS s_out,
         coalesce(sum(l.tokens_in), 0) AS l_in,
         coalesce(sum(l.tokens_out), 0) AS l_out
  FROM agent_sessions s
  LEFT JOIN llm_calls l ON l.company_id = s.company_id AND l.agent_session_id = s.id
  WHERE s.company_id = :company
  GROUP BY s.id, s.tokens_in, s.tokens_out
)
SELECT '4d2' AS id,
       'agent_sessions token roll-up reconciles with llm_calls' AS claim,
       CASE WHEN count(*) > 0 AND count(*) FILTER (WHERE s_in <> l_in OR s_out <> l_out) = 0
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       CASE WHEN count(*) = 0 THEN 'NOTHING TO SCAN: the run opened no sessions'
            ELSE coalesce(string_agg(format('session %s session(%s/%s) vs calls(%s/%s)', id, s_in, s_out, l_in, l_out), '; ')
                          FILTER (WHERE s_in <> l_in OR s_out <> l_out),
                          format('all %s session(s) reconcile', count(*)))
       END AS detail
FROM per_session;

-- ============================================================ İŞ DURUMU ÖZETİ
-- Zorunlu (plan §3.3): "hata yok" ile "iş ilerledi" aynı şey değildir.
-- Bu bir PASS/FAIL değil, koşunun DÜRÜST resmidir — DRAFT/WAITING'de kalan
-- her görev burada görünür ve raporda AÇIKÇA yer alır.
SELECT 'SUMMARY' AS id,
       format('TASK-%s', t.number) AS claim,
       t.status AS verdict,
       format('kind=%s owner=%s parent=%s caps=%s', t.kind,
              coalesce(a.name, '-'),
              coalesce((SELECT format('TASK-%s', p.number) FROM tasks p WHERE p.id = t.parent_id), '-'),
              coalesce(t.context->'requiredCapabilities', '[]'::jsonb)) AS detail
FROM tasks t
LEFT JOIN agents a ON a.id = t.owner_agent_id
WHERE t.company_id = :company
ORDER BY t.number;

-- ============================================================================
-- SQL OLMAYAN ASSERT'LER (kasıtlı olarak dışarıda — sahte sorgu yazmıyorum)
--
-- 1d  Gevşetilmiş delegasyon yolunun DOĞRUDAN kanıtı: agent-worker stdout'unda
--     `delegate pool: no candidate matched requiredCapabilities` satırı, 1c'deki
--     görevle AYNI taskId ile. (Jim: worker log grep'i.) 1c "eşleşme yoktu" der;
--     1d "kod gerçekten fallback dalından geçti" der. İkisi FARKLI iddialardır.
--
-- 4b  INV-3 bypass nöbetçisi: CLI oturumunun PTY/broker log'undaki kabuk+dosya
--     eylem sayısı ile `tool_invocations` satır sayısının tutarlılığı.
--     (Kevin: runtime tarafı.) DB tek başına "kaydedilmeyen eylem"i göremez.
--
-- INV-2 (prompt tarafı) — ÖNEMLİ KAPSAM DÜZELTMESİ: planın ilk taslağında
--     "llm_calls prompt içeriğini tara" yazmıştım; ŞEMAYA BAKINCA YANLIŞ olduğu
--     ortaya çıktı — `llm_calls` yalnız telemetri tutuyor (tokens/cost/latency/
--     context_telemetry), prompt METNİ hiçbir tabloda saklanmıyor. Bu yüzden
--     yukarıdaki 4c YALNIZCA aşağı akış yüzeyini (agent_steps.action/observation,
--     messages.body, tool_invocations.input) tarar. Gerçek INV-2 iddiası —
--     "hiçbir sır kurulan prompt'ta görünmez" — runtime lane'inde kanıtlanmalı:
--     CLI brief'i/ilk prompt (Kevin üretir) + konteyner env dump'ı (4e).
-- ============================================================================
