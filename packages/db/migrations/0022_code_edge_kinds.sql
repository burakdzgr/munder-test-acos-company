-- LIFECYCLE TASK 4: kenar türleri genişler — implements / extends.
-- (called_by = call'ın, tested_by = tests'in ters sorgusudur; ayrı saklanmaz.
--  defines = code_symbols.file_id ilişkisinin kendisidir.)
ALTER TABLE "code_edges" DROP CONSTRAINT "code_edges_kind_check";
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_kind_check"
  CHECK ("kind" IN ('import','reference','call','tests','implements','extends'));
