# Ortak UI kuralları

Ortak bileşenler üzerinden uygulanır:

- Ana eylem: `Button` / `buttonClass`, 48 px ve kapsül köşe.
- Yardımcı eylem: `tintedButtonClass` / `compactActionClass`, 36 px görünüm ve 44 px dokunma alanı.
- Sayfa oluşturma eylemi: `HeaderAddPill`; satır eylemi: `ActionPill`.
- İkonlar: Lucide `Icon`, 16/20/24/28 px; `IconTile` 40 px daire.
- Kartlar: ortak 24 px, beyaz yüzey ve yumuşak gölge.
- Alanlar: 14 px; özel `CustomSelect` uygulamadaki tüm seçim alanlarında.
- Aynı renkler sayfalar, sohbet, alt pencereler, giriş, ilk kurulum ve hata ekranlarında kullanılır.
- Footer önceki görünümünü korur. Belge önizleme koyu zeminini, grafikler veri çizimlerini korur.

Bu turda ortak buton geometrisi ve odak göstergeleri, kompakt yardımcı eylemler, ikon alanları, ilk kurulum ve hata yüzeyleri ile belge önizleme butonları birleştirildi.

TypeScript, değiştirilen dosyaların ESLint kontrolü ve 44 bileşen/form testi geçti.

Yeni ekran eklerken bu bileşenleri kullanın; sayfaya özel renk, ikon veya buton geometrisi tanımlamayın. Farklı işlevlerin ana, yardımcı ve tehlikeli eylem ayrımını koruyun.
