# Ortak arayüz uygulaması

Kirjanpito sayfasının krem arka planı, gül tonu, beyaz 24 px kartları, yumuşak gölgeleri, başlık tipografisi ve yuvarlak ikon alanları uygulamanın ortak bileşenlerine taşındı.

Liste, rapor, ayar ve form sayfaları; giriş ekranları; alt pencereler ve sohbet penceresi aynı görsel kuralları kullanıyor. Form alanları kendi kenarlıklarını ve odak göstergelerini koruyor. Mevcut footer yapısı ve işlevleri korundu. Veri hesaplamaları ve API işlemleri değiştirilmedi.

## Kontroller

- 31 sayfada HTTP, görünür başlık, ortak stil ve yatay taşma kontrolü geçti.
- Ana sayfalar ve formlar 320, 430 ve 1024 px genişliklerde kontrol edildi.
- Profil, sohbet ve Lisää menüsü açılış/kapanış kontrolleri geçti.
- TypeScript ve değişen bileşenlerin ESLint kontrolleri geçti.
- 3 test dosyasında 21 test geçti.

Tarayıcı kontrolleri yerel demo hesabıyla gerçekleştirildi. Bu kontroller finansal işlemlerin tamamı için uçtan uca doğrulama değildir.

Ekran görüntüleri bu klasördedir. Yerel uygulama: http://localhost:3002

Üretim derlemesi başarıyla tamamlandı. Mevcut Next.js dosya izleme uyarıları ve ZIP kaynakta `.git` bulunmadığı için commit bilgisi uyarısı devam ediyor.
