-- _DECISIONS A5: şirkete dönük çıktı dili bir AYARDIR; burada değişen yalnız
-- VARSAYILAN. Founder kararı (2026-08-16): bu kurulumda Founder Türkçe
-- çalışıyor, her yeni şirkette ayarı elle çevirmek zorunda kalıyordu.
--
-- Mevcut satırlara dokunulmuyor: ayarı bilerek başka bir dile çekmiş bir
-- şirketi migration'ın geri çevirmesi, ayarın anlamını yok ederdi.
ALTER TABLE "company_settings" ALTER COLUMN "output_language" SET DEFAULT 'tr';
