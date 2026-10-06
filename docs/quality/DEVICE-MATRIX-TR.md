Önce yaz: iPhone modeli, iOS sürümü, IPA build numarası (CI run numarası). Her satır: ne yap, ne olmalı.
1. Kur ve aç, sonra giriş/kayıt yap, e-postadaki OTP kodunu gir: giriş tamamlanmalı, çökme olmamalı.
2. Uygulamayı kapat (yukarı kaydır) ve aç: oturum devam etmeli, tekrar giriş istememeli.
3. Arka plana al, 1 dakika sonra dön: ekran aynı kalmalı; Face ID/PIN açıksa kilit istemeli, doğru yüzle açılmalı.
4. VisionKit tarayıcı: Kuitit > kamera, fişi çerçeveye al: sayfa otomatik kırpılmalı, fiş listede görünmeli.
5. Galeriden bir fotoğraf, dosyalardan bir PDF yükle: ikisi de yüklenmeli, PDF QuickLook'ta açılıp kapanmalı.
6. Ana ekran hızlı eylemleri: simgeye uzun bas, "Kuvaa kuitti", "Uusi lasku", "Avustaja": her biri doğru ekranı açmalı.
7. Siri: "Kuvaa kuitti LashKirja", "Uusi lasku LashKirja", "Avaa avustaja LashKirja" de: uygulama ilgili ekranda açılmalı.
8. Spotlight: ana ekranı aşağı çek, müşteri adı veya fatura numarası yaz: sonuç çıkmalı, dokununca o kayda gitmeli.
9. Uçak modunu aç: üstte çevrimdışı şeridi çıkmalı. Kapat: şerit kaybolmalı, hatalı ekran kendiliğinden yenilenmeli.
10. Ayarlar > Erişilebilirlik > Yazı boyutu en büyük: Koti, fatura formu, Avustaja okunmalı, metin kesilmemeli.
11. VoiceOver aç: simge düğmeleri ad söylemeli (ör. kamera, ekle); ana ekran ve fatura formunda gezinilebilmeli.
12. Fatura formunda yaz: alanlar klavyenin altında kalmamalı; soldan kaydırarak geri dön, sheet'i aşağı çek: çalışmalı.
13. Banka bağla (hesap bilgisi varsa): tarayıcıdan uygulamaya dönünce bağlantı tamamlanmalı, uygulama açık kalmalı.
14. Ayarlar > Pääsyavaimet ve Maksut: "ei määritetty" / "Puuttuu tästä versiosta" yazmalı (bu sürümde kapalı), çökme olmamalı.
15. Sonunda sorun varsa ekran görüntüsü + saat + hangi madde olduğunu yaz; build numarasını mutlaka ekle.
