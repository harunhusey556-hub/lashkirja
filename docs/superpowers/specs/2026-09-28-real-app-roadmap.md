# LashKirja: link kabuğundan gerçek uygulamaya — yol haritası

Tarih 2026-09-28. Araştırma: `docs/superpowers/research/2026-09-28-real-app-findings.md`.

## Sahibin kararları

- Dağıtım önce sadece sahibin telefonuna TestFlight ile yapılacak, sonra App Store'a çıkılacak. Bu yüzden şimdi **A** (aynı uygulama sabit bir sunucuda ve native cilayla), App Store'dan önce **B** (arayüz IPA'nın içinde) yapılacak. Apple 4.2 kuralıyla sadece web sitesini saran uygulamaları reddediyor.
- Sahibin Apple Developer hesabı var.
- Sunucu şimdilik sahibin kendi Windows bilgisayarı olacak. Sabit adres Tailscale Funnel (`https://<makine>.<tailnet>.ts.net`) üzerinden verilecek.
- İsim her yerde **LashKirja**. Native tarafta şu an "Tilikirja" yazıyor.
- Görülen hata şu: çıkış yapınca Capacitor'ın "yüklenemedi" sayfası çıkıyor ve "tekrar dene" butonu sadece kendini yeniliyor.

## Başarı ölçütleri

1. Telefonda soğuk açılıştan Koti'nin görünmesine kadar ≤ 1,5 s geçer (4G, ilk kurulumdan sonra). Sekme geçişi ≤ 0,5 s sürer.
2. Çıkış, oturumun başka yerden kapatılması, internetin kopması ya da sunucunun kapalı olması uygulamayı kilitlemez. Her durumda kullanıcı bir düğmeyle çalışan bir ekrana döner.
3. Uygulama TestFlight'tan kurulur, "LashKirja" adıyla ve yeni ikonla görünür. Yeni bir sürüm tek bir GitHub Actions çalıştırmasıyla TestFlight'a gider.
4. Gerçek veriler demo veritabanından ayrıdır, her gün bilgisayar dışına yedeklenir ve geri yükleme denenmiştir.
5. Eksik fiş için telefona push bildirimi gelir. Bu, ürün vizyonundaki 3. alt proje.

## Faz 0 — Sabit ve gerçek sunucu (bu bilgisayarda)

Hedef: IPA hiçbir zaman `next dev`'e ya da geçici tünele bağlanmayacak.

- **Ayrı bir production kopyası:** `C:\LashKirja\prod` klasörü, `git pull`, `npm ci` ve `next build` ile güncellenir. Kendi `.env` dosyası, kendi veritabanı (`prod.db`) ve kendi `uploads/` klasörü olur. Geliştirme kopyası ve demo verisi bundan ayrı kalır.
- **Otomatik başlayan servisler:**
  - `next start` (port 3300);
  - `scripts/worker.ts` (10 dakikalık arka plan işleri);
  - cron uçları.
  - Windows açılınca kendiliğinden başlarlar ve çökerlerse yeniden başlatılırlar (NSSM servisi ya da Görev Zamanlayıcı ile). Sağlık kontrolü `/api/health` üzerinden yapılır.
- **Tailscale Funnel:** `tailscale funnel` ile 3300 portu dışarı açılır. `CAPACITOR_SERVER_URL`, `ALLOWED_DEV_ORIGINS` ve çerez ayarları (`COOKIE_SECURE=true`) bu sabit adrese göre ayarlanır.
- **Güvenli dağıtım:** `scripts/deploy-local.ps1` tek komutla şunları yapar:
  - kodu çeker;
  - build alır;
  - veritabanını yedekler;
  - migration çalıştırır;
  - servisi yeniden başlatır;
  - sağlık kontrolü yapar;
  - hata olursa önceki build'e döner.
- **Yedekleme:** Mevcut `backup-db.sh` mantığı Windows'a taşınır (sqlite `.backup`). `prod.db` ve `uploads/` her gün yedeklenir, 30 günlük döngüyle OneDrive ya da harici bir klasöre kopyalanır. Bir geri yükleme tatbikatı yapılır. Kirjanpitolaki gereği 10 yıllık arşiv için ayrıca aylık kapanış paketi alınır.
- **Güç ayarları:** Bilgisayar uykuya geçmez. Sunucu kapalıyken uygulamanın ne göstereceği Faz 1'de ele alınıyor.

Sahibin yapacakları: bir Tailscale hesabı açıp bu bilgisayara Tailscale'i kurmak (bir kez), gerçek verilerle ilk girişi yapmak.

## Faz 1 — Kilitlenmeyen uygulama (çıkış ve hata yolları)

- **Çıkış:**
  - Tek bir yönlendirme yapılır.
  - `signing-out` soluklaşması için bir güvenlik zaman aşımı eklenir (yönlendirme 3 saniyede olmazsa soluklaşma kaldırılır ve `/login` tekrar denenir).
  - `leaveAfterSignOut` test edilir.
- **Native taraf:**
  - İptal edilen yönlendirmeler (`NSURLErrorCancelled`) "yüklenemedi" sayılmaz.
  - `offline.html`'deki "Yritä uudelleen" butonu kendini değil, sunucu adresini yeniden yükler.
  - Sunucuya ulaşılamazsa sayfa kendiliğinden tekrar dener ve "Sunucuun ei saatu yhteyttä" gibi anlaşılır bir mesaj gösterir.
- **İptal edilmiş oturum:** `proxy.ts` iptal edilmiş oturumu tanır ve çerezi siler. Böylece `/login` ile `/dashboard` arasındaki sonsuz döngü biter. Herhangi bir 401'de çerez temizlenir. Bunlar için entegrasyon testi yazılır.
- **Native ayarlar:**
  - Info.plist: `armv7` kaldırılır, bölge `fi` yapılır, `ITSAppUsesNonExemptEncryption=false` eklenir, kamera ve fotoğraf izin metinleri Fince yazılır.
  - Uygulama adı her yerde LashKirja olur.

## Faz 2 — Hız (production'da da kalan 4 sorun)

- **A1+A5:** Oturum kontrolü sunucuda yapılır (proxy ya da layout). Kabuk, "Tarkistetaan istuntoa…" ekranını beklemeden sayfayı çizer. Sayfa verileri paralel başlar.
- **A2:** `/api/auth/me` tek bir istekte paylaşılır.
- **A3:** Her tam yüklemede giden 7 ilgisiz "ısınma" isteği kaldırılır ya da boşta beklerken yapılır.
- **A4:** Sekmeler `<Link>` olur ve önceden yüklenir.
- **A6:** Kalıcı önbellek eklenir (IndexedDB): uygulama açılınca son veri anında görünür, arka planda yenilenir. Bu adım B için de temel oluşturur.
- **Ölçüm:** Throttled 4G senaryosunda başarı ölçütü 1 doğrulanır. `app/docs/perf-budgets.md` güncellenir.

### Faz 2b — Apple hissi: algılanan hız ve hareket

Sahibin isteği (2026-09-28) şu: uygulama "Apple hissi" vermeli ve hızlı *hissettirmeli*. Geçiş efektleri, dokunma geri bildirimi ve yükleme animasyonları ayrı bir özenle ele alınacak. Kurallar `design-taste` skill'inin `reference/motion.md` dosyasından gelir:
- Arayüz animasyonları 300 ms'nin altında kalır.
- Giriş ve çıkışlarda güçlü ease-out eğrisi kullanılır.
- Sadece `transform` ve `opacity` animasyonu yapılır.
- `prefers-reduced-motion` açıkken hareketler anında ya da crossfade ile yapılır.
- Klavyeyle başlatılan işlemler animasyonsuzdur.

- **Sayfa geçişleri:**
  - Detay sayfaları iOS'taki gibi sağdan kayarak açılır ve geri gidince sola kayarak kapanır.
  - Sekmeler arasında kısa bir crossfade olur.
  - Başlık, büyük başlıktan küçük başlığa yumuşakça geçer.
  - Bunun için View Transitions API kullanılır (iOS 18 WKWebView). Desteklenmeyen yerde animasyonsuz geçilir.
- **Dokunma geri bildirimi:**
  - Mevcut `active-press` ölçeklemesi bütün dokunulabilir öğelerde tutarlı hâle gelir.
  - Capacitor Haptics eklenir:
    - chip ve seçim değişiminde `selection`;
    - birincil işlemlerde `light impact`;
    - kaydetme, onaylama ve ödeme kaydında `success`;
    - hatada `error` titreşimi.
- **Yükleme durumları:**
  - Sayfa yüklemelerinde spinner yerine son düzenle aynı şekilde iskelet ekranlar (skeleton) gösterilir, ince bir shimmer ile.
  - Kalıcı önbellekteki veri anında gösterilir, yenilenen veri titremeden yerine oturur.
  - Butonlar kendi içinde yükleme göstergesi taşır ve genişlikleri değişmez.
- **İyimser arayüz (optimistic UI):** Tek dokunuşla onay, ödeme kaydı ve bağlantı işlemleri anında görünür. Hata olursa geri alınır ve ekranda açıklanır. Geri alınabilir işlemlerde onay penceresi yerine "Kumoa" (geri al) bildirimi (toast) kullanılır.
- **Sheet'ler ve listeler:**
  - Alt sheet'ler yay (spring) hissiyle açılıp kapanır, sürükleyerek ve hızına göre kapatılabilir.
  - Liste satırı eklenip silinirken yumuşakça yer açılır ya da kapanır.
  - Aşağı çekince yenileme (pull-to-refresh) native hissiyle çalışır.
- **Açılış:** Açılış ekranından iskelet ekrana aynı arka plan rengiyle kesintisiz geçilir, beyaz flaş olmaz.
- **Ölçüm:** Uzun işlemler (long task) ve INP ölçülür. Animasyonlar telefonda 60 fps'te kalır. Her yeni hareket için azaltılmış hareket (reduced motion) karşılığı test edilir.

## Faz 3 — TestFlight ile gerçek iOS uygulaması

- **İmzalı build:** GitHub Actions'ta imzalı build alınır:
  - App Store Connect API anahtarı ve dağıtım sertifikası GitHub secret olarak saklanır;
  - build numarası otomatik artar;
  - `build-testflight.yml` IPA'yı TestFlight'a yükler.
  
  Mac gerekmez.
- **Görsel ve gizlilik:** Uygulama ikonu setinin ve açılış ekranının son hâli yapılır. Uygulama için `PrivacyInfo.xcprivacy` eklenir. Bir gizlilik politikası sayfası hazırlanır.
- **Push bildirimleri (APNs):**
  - Capacitor Push plugin'i eklenir, cihaz token'ı kaydedilir.
  - Sunucu `.p8` anahtarıyla APNs'e gönderim yapar.
  - İlk bildirim şu olur: banka hareketi var ama fişi yok, "Kuva kuitista" hatırlatması.
  - Sıklık ayarlardan seçilir.
- **Native kamera:** Fiş için native kamera açılır (fotoğrafı çek, kırp, yükle).
- **Hata raporlama:** Native ve web çökmeleri (Sentry ya da benzeri, ücretsiz katman) raporlanır.

Sahibin yapacakları: App Store Connect'te uygulama kaydını açmak (bundle id `fi.tiyouba.lashkirja`), bir API anahtarı oluşturup bana güvenli şekilde vermek (GitHub secret olarak), APNs anahtarı oluşturmak.

## Faz 4 — App Store'a hazırlık (B'nin temeli)

- Çerezin yanında token ile giriş (Keychain'de saklanır), tek bir API adresi (`API_BASE_URL`), CORS ve imzalı dosya linkleri eklenir.
- Arayüz statik olarak derlenip IPA'nın içine konur. Bunu engelleyen yerler değişir: `/`, `/dashboard`, dört `[id]` sayfası, proxy ve `headers()`/`redirects()` kullanımı.
- Banka OAuth dönüşü ve e-posta linkleri için universal links eklenir.
- Çevrimdışı fiş kuyruğu: internet yokken çekilen fotoğraf sıraya girer, bağlantı gelince yüklenir.
- App Store'a çıkmadan önce sunucu bu bilgisayardan gerçek bir sunucuya taşınır (örneğin Hetzner Helsinki). Herkese açık bir uygulama ev bilgisayarına bağlı olamaz.

## Sıra ve tahmini süre

| Faz | Bağımlılık | Emek |
|---|---|---|
| 0 Sabit sunucu | Tailscale hesabı | Küçük (1 oturum) |
| 1 Kilitlenmeyen uygulama | — | Küçük |
| 2 Hız | Faz 1 | Orta |
| 2b Apple hissi (hareket, haptik, iskelet, iyimser arayüz) | Faz 2 | Orta |
| 3 TestFlight ve push | Faz 0, Apple anahtarları | Orta |
| 4 App Store temeli | Faz 2, 3 | Büyük |

Faz 0 ve 1 birlikte yapılır, sonunda yeni bir IPA çıkar. Bu IPA henüz imzasızdır. İmzalı ve TestFlight'lı sürüm Faz 3'te gelir. Her faz kendi uygulama planıyla (`docs/superpowers/plans/`) yürütülür, en sonda tek bir review yapılır.

## Kapsam dışı

- Cihazda tam yerel veritabanı (C yolu): banka, e-posta ve AI yine sunucu istediği için getirisi düşük, riski yüksek.
- Android.
- Çok kullanıcılı kayıt, fatura ve abonelik: App Store kararıyla birlikte ayrıca ele alınacak.
