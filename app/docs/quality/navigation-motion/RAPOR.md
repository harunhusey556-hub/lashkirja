# iOS 0.9.3: başlık örtüşmesi ve geçiş koordinasyonu

İncelenen kayıt: Downloads/IMG_0235.MP4 (en yeni kayıt, 5,85 saniye,
60 kare/s). Kullanıcının netleştirdiği hata: yeni sayfa açılırken önceki
sayfanın başlığı yeni header ile iç içe görünüyor, geçiş sonunda düzeliyor.

## Neden ve düzeltme

Ana sekmelerin büyük başlığı `.app-page` içinde, alt sayfaların geri
butonu ve aksiyonları ayrı `.app-header-row` içinde çiziliyor. Ana
sayfanın görüntüsü geçiş sırasında korunuyor; yeni header şeffaf olduğu
ve ayrıca sayfadan iki animation frame önce başladığı için eski büyük
başlık yeni header'ın arkasından görünüyordu.

`AppShell.tsx` artık header'a geçiş süresince opak bir yüzey veriyor.
Ana sayfadan gelen header bu yüzeyi soluklaştırmadan taşıyor. Header
animasyonları `playNavTransition` ile aynı hazırlık ve zaman çizelgesini
kullanıyor. İşlem bitince geçici yüzey temizleniyor. Sayfa geçişinin
420 ms süresi ve mevcut spring eğrisi korundu; yeni animasyon kütüphanesi
kurulmadı.

Geri kaydırmada ayrıca şu koordinasyon hataları giderildi:

- Sabit 190 ms rota zamanlayıcısı yerine gerçek animasyon bitişi kullanılıyor.
- Bitiş süresi kalan mesafeye ve parmağın son hızına bağlı (120–320 ms).
- Dokunma hareketi frame başına bir kez çiziliyor; genişlik her harekette
  tekrar okunmuyor.
- Parmak bekletilince eski hız kullanılmıyor; ters yöndeki son hareket
  geri dönüş kararına katılıyor.
- `touchcancel` geri dönüşü onaylamıyor.
- Kaydırmayı yeni navigasyon keserse eski kapak, önizleme ve katman ipuçları
  temizleniyor; yeni geçişin transform/z-index değeri bozulmuyor.

## IPA boyutu ve paketleme

2,7 MB tek başına eksik arayüz kanıtı değildir. Uygulama Capacitor/WKWebView
kullanır; tarayıcı motoru iOS tarafından sağlanır. Güncel mobil export
475 dosya / yaklaşık 5,57 MiB sıkıştırılmamış arayüz içeriyor.
İndirilen LashKirja IPA bu bilgisayarda bulunmadığından o IPA'nın içeriği
incelenmedi.

Başlangıçta yerelde `ios/App/App/public` yalnızca eski shell dosyalarını
(68 KB) içeriyordu; güncel export ile eşleşmiyordu. `cap copy ios` ile
şimdi export kopyalandı ve doğrulandı. Bu **yerel test derlemesi**
`http://localhost:3002` API adresini kullanır; telefona dağıtılacak paket,
mevcut IPA workflow'unda gerçek HTTPS API adresiyle yeniden derlenmelidir.

`scripts/assert-ios-web-assets.ts` tüm export dosyalarının paketlenen
public dizininde bulunduğunu ve SHA-256 içeriklerinin aynı olduğunu
kontrol eder. Yerel IPA script'ine sync ve archive sonrası, GitHub IPA
workflow'una sync ve paketleme öncesi kontrol eklendi. Eski yalnızca
"en az 2 MB" kontrolü yerine içerik doğrulaması kullanılır.

## Doğrulama ve sınırlar

- Mobil production export başarılı.
- TypeScript ve ilgili ESLint kontrolleri temiz.
- Gesture, page-transition ve nav-direction: 28 unit test geçti.
- WebKit / 390×844 / iPhone safe-area ile statik mobil export üzerinde:
  header-sayfa ortak saati ve opak yüzeyi; push/pop temizliği; bekletilen
  kısa drag iptali; touchcancel; onaylı geri dönüş; kaydırma iptalini kesen
  yeni push: 4 tarayıcı testi geçti.
- Paket kontrolü, başlangıçtaki eksik shell'i reddetti; güncel kopyadaki
  475 dosyayı doğruladı.

WebKit testleri iPhone donanımında FPS ölçümü değildir. Bu Linux ortamında
Xcode/gerçek cihaz IPA derlemesi veya TestFlight dağıtımı yapılmadı.
Düzeltmenin kurulu 0.9.3 uygulamasına gelmesi için yeni IPA gerekir.

Kaynaklar:
- https://capacitorjs.com/docs/config (webDir / server.url)
- https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/
  (layout/paint ve transform/opacity animasyonları)
