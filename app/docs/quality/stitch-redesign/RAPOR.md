Koti ve Kirjanpito tasarım uygulama raporu — 2 Ekim 2026

Değişiklikler yerelde çalışan uygulamada: http://localhost:3002/dashboard ve http://localhost:3002/kirjanpito. Dışarıdaki bir sunucuya dağıtım yapılmadı.

Referans olarak Downloads klasöründeki ikinci indirme, `stitch_canl_tasar_m_geli_tirme_nerileri (1).zip`, kullanıldı. Bu ZIP Koti'nin görevli ve tamamlanmış durumlarını içeriyor. Kirjanpito düzeni kullanıcının eklediği tasarım metninden uygulandı.

- Koti: krem/rose arka plan, beyaz yuvarlak kartlar, gerçek veriden ilerleme halkası, gelir/gider kartları ve küçük trend çizgileri, görev listesi, yeşil otomasyon kartı ve veri güncelleme zamanı.
- Kirjanpito: ilerleme durumu; Tapahtumat ja kuitit, Pankki, Ilmoitukset ja kaudet grupları. Her satır mevcut işlevsel sayfaya gider. ALV dönemi/tutarı, açık ostolaskut sayısı ve kapatılmış dönemler mevcut API'lerden gelir.
- Ortak footer'ın kodu ve aksiyonları önceki sürümle karşılaştırılarak aynı kaldığı doğrulandı. Ortak header'daki chat simgesi ve rose profil avatarı yenilendi; ana sayfalarda başlık satırına taşındı. Her ekranda bir chat ve bir profil düğmesi var; mevcut pencereleri açıyorlar.
- Koti'deki ay seçimi, kuitti onaylama/geri alma, kamera, eşleştirme, ay kapatma ve mevcut finansal ayrıntılara erişim korundu.

Tasarımın örnek sayıları uygulamaya sabitlenmedi. İlerleme Koti ve Kirjanpito'da aynı dashboard verisinden hesaplanır. Aylık karşılaştırma sadece önceki ayın verisi mevcutsa, başlangıç tutarı sıfır değilse ve iki ayın hesaplama temeli aynıysa gösterilir. Banka nakit tutarları belge gelirleriyle karşılaştırılmaz. Küçük grafikler gerçek aylık geçmişi kullanır. Boş hesap tamamlanmış gibi gösterilmez. Tamamlanma ekranı yalnızca olaylar tamamlandığında, bekleyen iş/hata kalmadığında ve banka verisi bulunduğunda çıkar.

Otomasyon kartı mevcut son 7 günlük gerçek kayıtları kullanır; işlem yoksa kart çıkmaz. Güncelleme satırı verinin çekilme zamanını belirtir; banka senkronizasyonu yapılmış gibi bir iddia üretmez. Bağlantı hatasında önbellekteki değerler korunur, eski veri uyarısı ve yeniden deneme gösterilir. İlk yükleme hatasında tutar/sayı uydurulmaz.

İşlev kontrolünde bulunan kamera bağlantısı da düzeltildi: Koti'deki “Kuvaa kuitti” seçilen banka işlem kimliğini kuitti editörüne taşır. Kaydedilen kuitti mevcut, yetki ve dönem kontrollerini yapan eşleştirme API'siyle o işleme bağlanır. Eşleştirme başarısız olursa kaydedilmiş kuitti korunur ve hata gösterilir; kullanıcı tekrar yeni kuitti oluşturan formda bırakılmaz.

Doğrulama sonuçları:

| Kontrol | Sonuç |
|---|---|
| TypeScript | Başarılı |
| İlgili birim testleri | 44/44 başarılı |
| Koti/banka/onay/eşleştirme entegrasyon testleri | 23/23 başarılı |
| Son üretim derlemesi | Başarılı, çıkış kodu 0 |
| Gerçek kuitti onayı | Tamamlanan olay sayısı arttı; Kirjanpito güncel sayıyı gösterdi |
| Kamera → editör → kayıt → banka işlemine eşleştirme | Başarılı; dosya seçici ve kayıt/eşleştirme API'leri gerçek, OCR yanıtı kontrollü test verisi |
| Profil/chat pencereleri ve Kirjanpito bağlantıları | Başarılı |
| Ay değiştirme, boş/tamamlanmış hesap, eski veri ve toparlanma | Başarılı |
| 320, 393, 430 ve 1024 px genişlik | Yatay taşma yok |

Değişen dosyaların ESLint kontrolünde ReceiptEditor dışındaki dosyalar temiz. ReceiptEditor'da önceden mevcut olan `react-hooks/set-state-in-effect` hatası bulunuyor; yeni kamera/eşleştirme satırlarında ek lint hatası yok. Üretim derlemesi mevcut dosya izleme/NFT uyarılarıyla tamamlanıyor. Entegrasyon testlerinin bu ortamda çalışması için geçici SQLite dosyasının migrasyondan önce oluşturulması düzeltildi.

Testler ayrı bir geçici hesapla yapıldı; demo ve mevcut kullanıcı kayıtları test verileriyle doldurulmadı. Gerçek bankaya bağlantı ve dış AI hizmeti bu yerel testte kullanılmadı; bu hizmetlerin arayüz açılışı ve mevcut bağlantı/kurulum akışları kontrol edildi. iOS cihaz testi yapılmadı.

Ekran görüntüleri aynı klasörde: `koti-tasks.png`, `koti-complete.png`, `koti-empty.png`, `kirjanpito-data.png`, `kirjanpito-empty.png`, `koti-stale.png`, `kirjanpito-stale.png` ve farklı ekran genişlikleri için örnekler.
