# Kontrollü arama ve güvenlik testleri

Asistan son beş kayıt yerine filtrelenmiş kayıt sorgularını kullanır. Örnekler:

- `2026-09 tarihindeki faturalarım`
- `2026-09-01 – 2026-09-30 arasındaki fişler`
- `Geçen ay faturalarım` / `viime kuun laskut`
- `customer "Anna" invoice #42 2026-09`

Açık müşteri adları tırnak içinde yazılır. Tarihler belge tarihi/fiş tarihine uygulanır. Geçersiz tarihte geniş sorgu yapılmaz; kullanıcıdan düzeltme istenir. Sorgu sahibini yalnızca sunucu oturumu belirler. Prisma parametreli sorguları kullanılır; kullanıcı/model SQL, kod veya hesap sahibi belirleyemez.

Her kayıt türü için tüm eşleşmeler sayılır ve en fazla 20 kayıt bağlama alınır. Kesilmiş sonuçlardan genel toplam üretilmemesi istenir. Bu kapsam finansal toplam hesaplama motoru veya sınırsız veri erişimi değildir.

Yeni testler sahte işlem onaylarını (Türkçe dahil), uydurma tutarları, zararlı/harici bağlantıları, başka hesabın kayıt bağlantılarını, müşteri adı içine yerleştirilmiş talimatları, hesap izolasyonunu ve sonuç sınırlarını kapsar. Akış sırasında metindeki bağlantılar sunucunun doğruladığı mesaj kaynaklarında yer almadan aktif olmaz. Testler modelin her olası çıktısının güvenli olduğunu kanıtlamaz; erişim ve çıktı kontrollerini doğrular.

Gerçek banka akışının koşullu testi ve çalıştırma adımları: `tests/e2e-bank-live/README.md`. Test özel hesap, etkin Enable Banking yapılandırması ve açık kullanıcı rızası gerektirir. Banka parolası/onayı otomatikleştirilmez. Kayıt, video ve ekran görüntüsü kapalıdır. Normal CI'da atlanır; bu ortamda gerçek bankayla yetkilendirme yapılmadı.

Doğrulama: 41 birim testi, 21 entegrasyon testi, TypeScript ve ESLint geçti. Gerçek banka testi yapılandırma/izin nedeniyle atlandı.
