# AI sohbeti: uygulama bağlamı ve eylem etiketleri

Gemini bağlantısı korunarak her model isteğine uygulamanın gerçek ekran rehberi ve oturumdaki kullanıcıya ait güncel bağlam eklendi. Bağlam işletme/VAT ayarlarını, banka bağlantı durumunu, hesap ve kayıt sayılarını, son beş fişi ve son beş faturayı içerir. Son kayıtlar finansal toplam olarak sunulmaz. Eksik veriler için asistanın tahmin üretmek yerine ilgili ekranı göstermesi istenir.

Veri sorguları sunucuda oturumdaki userId ile sınırlandırılır. Parola hashleri, API anahtarları ve banka kimlik bilgileri modele verilmez. Muhasebe tutarları, kayıt kimlikleri, bağlantılar ve tamamlanmış işlem iddiaları mevcut dürüstlük denetiminden geçer. Asistan muhasebe değişikliği veya banka yetkilendirmesi yapmış gibi konuşamaz.

Banka, yeni fatura, faturacı bilgileri, fişler, işlemler, ALV, raporlar ve ayarlar için sunucunun tanımladığı bağlantılar kullanılır. Eylem etiketleri hem akışlı yanıt hem de geçmişte korunur. Banka etiketi mevcut banka seçici/kurulum penceresini açar; banka izni kullanıcı tarafından verilir. Otomatik bağlantı etkin değilse mevcut hesap ekleme ve ekstre içe aktarma seçenekleri açılır ve asistan durumu açıklar.

Sohbetin başlangıç açıklaması ve hızlı soruları güncellendi. Eylem etiketleri yeşil, kaynak bağlantıları daha sakin renkte gösterilir. Etiketler uygulama içinde navigasyon yapar ve sohbet penceresini kapatır.

## Doğrulama

- 32 birim testi ve 16 entegrasyon testi geçti.
- Başka kullanıcının fişlerinin bağlama girmemesi ve gizli alanların dışarıda kalması kontrol edildi.
- Akışlı yanıtın eylem etiketlerini veritabanında saklaması kontrol edildi.
- Gerçek Gemini API'si, yalnızca yapay test hesabının işletme adı ve fiş sayısıyla doğrulandı; test hesabı ve fişi silindi.
- Tarayıcıda gerçek sohbet yanıtı, banka etiketi, uygulama içi navigasyon ve banka kurulum penceresi doğrulandı. Test konuşması silindi.
- TypeScript, değişen dosyaların ESLint kontrolü ve üretim derlemesi geçti.

Yerel ortamda otomatik banka bağlantısı kapalıdır; gerçek banka rızası akışı için mevcut Enable Banking yapılandırmasının etkin olması gerekir. Bu çalışma banka yapılandırmasını değiştirmedi.

Ekran görüntüleri: chat.png ve bank-action.png.
