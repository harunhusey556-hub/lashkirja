# MASTER WORKER PLAN — LashKirja

> Ana uygulama planı. Worker bu dosyayı **tek çalışma kuyruğu** olarak kullanmalı.
> Repo: `harunhusey556-hub/lashkirja`. Kaynak branch: **`native`**.
> `main`, `development`, `test`, `feature/stripe-pos`, `feat/real-app-phase01` kaynak değildir; `native`'e merge edilmez.
> Son güncelleme: 2026-10-05.

## 0. Amaç

LashKirja'yı yeni alan ekleyerek büyütmek yerine mevcut native ürünü **bitir, sadeleştir, doğrula, sertleştir**:

1. Native SwiftUI uygulamadaki küçük ama güveni bozan etkileşim hatalarını kapat (OTP, dokunma geri bildirimi, klavye, sheet, çift gönderim).
2. Navigasyonu dört ana alana indir (Koti, Myynti, Kirjanpito, Raportit; Asetukset profil üzerinden).
3. Mevcut her akışı happy path + hata + tekrar deneme ile uçtan uca tamamla.
4. Her cihaz-özel davranışı gerçek iPhone'da doğrula; akıl yürütme veya Windows/Linux testi yetmez.
5. Canlıda çalışan sunucu fonksiyonlarını (banka, kuitti, fatura, ALV) bozma.

Ayrıntılı kabul kriterleri: `docs/superpowers/plans/2026-10-05-native-polish-master-plan.md` (bundan sonra **NP**). Bu dosya NP'nin yürütme sırasıdır. Çelişki varsa önce canlı kod + son doğrulanmış `docs/worker-reports/` raporu, sonra bu dosya esas alınır. Eski web/WebView planları (`docs/superpowers/plans/2026-09-*`, `docs/quality/*`) tarihsel bağlamdır; içlerindeki açık sunucu maddeleri §10'a taşındı.

---

## 1. Mevcut durum — 2026-10-05

### Tamamlanan ana parçalar

- **Native SwiftUI uygulama** (`ios-native/`): auth, kayıt + e-posta kodu, şifre sıfırlama, onboarding sohbeti, Koti, Myynti, Kirjanpito, Raportit, Asetukset, AI asistan, banka (Enable Banking), kuitti/ostolasku/myyntilasku, toistuvat, bildirimler, e-posta içe aktarma, passkey arayüzü.
- **Sunucu** (`app/`, Next.js API + Prisma/SQLite): production bu PC'de, Tailscale Funnel arkasında; `deploy-local.ps1` ile sağlık kontrolü + otomatik geri alma.
- **Production:** `1ce55c4` (2026-10-03). `native` HEAD `dfd6fcb`; aradaki fark yalnız iOS + doküman, sunucu kodu aynı.
- **CI:** `CI` ve `iOS native` (Linux `swift test` + simulator build/test + imzasız IPA) son commitlerde yeşil.
- Web/WebView dönemi (batch 1–3): banka gerçeği, Koti grafikleri, passkey sunucusu, push/pop geçişleri — sunucu tarafı canlıda.

### Dış kısıtlar (sahip kararları)

- **Apple Developer Program yok** (Team ID yok). Sonuçları: TestFlight yok; native passkey (associated domains) kapalı; Tap to Pay **park edildi**. Kurulum: imzasız IPA + Sideloadly.
- Sahip bu kararı değiştirmedikçe bu üç alana mühendislik zamanı harcanmaz.

### Güncel kritik açıklar

1. **P0.1 OTP AutoFill** cihazda doğrulanmadı (`c05a341` olası nedeni düzeltti, rapor "not device-verified" diyor). Çift gönderim kapısı (`settled`) SwiftUI view içinde, birim testi yok.
2. **P0.2–P0.5** dokunma geri bildirimi, loading/hata durumları, klavye, sheet güvenliği için sistematik denetim yapılmadı.
3. **P1** navigasyon dokunuş sayıları ölçülmedi.
4. **P2** domain bazında uçtan uca doğrulama listesi açık.
5. **P3** 401/oturum döngüsü, offline, idempotency anahtarı tekrar kullanımı denetlenmedi.
6. **Cihaz doğrulama kanalı:** worker iPhone'a erişemez; her cihaz maddesi sahibin test etmesine bağlı. Bu yüzden her cihaz maddesi için kısa, Türkçe test kontrol listesi + IPA teslim edilir (§11 kural 9).
7. Eski açıklar (sunucu): live-test 2026-09-30 listesinden açık P1/P2'ler (`docs/quality/LIVE-TEST-2026-09-30.md`); OCR ve AI "ana beyin" sahip kararları bekliyor.

---

## 2. Çalışma sırası — ANA KUYRUK

Worker sırayı bozmasın. Bir madde bloklanırsa (ör. cihaz testi bekliyor) yalnız blokajı kaldıran işi yap veya **aynı faz içindeki** bir sonraki maddeye geç; başka büyük özelliğe sıçrama.

### P0 — Native etkileşim doğruluğu (NP §P0)

| ID | İş | Durum |
|---|---|---|
| P0.0 | Zemin: `native` HEAD, clean tree, CI durumu, prod commit'i ölç ve RUN'a yaz | her run |
| P0.1 | OTP AutoFill: 10 giriş şekli testli; çift gönderim kapısı core'a taşınıp testlendi; **cihazda kabul** | kod+test tamam (`5f3f1f5`); cihaz testi bekliyor |
| P0.2 | Dokunma geri bildirimi + uçuştaki isteği kilitleme (fatura/ödeme/silme/gönderme çift gönderilemez) | açık |
| P0.3 | Loading / boş / kısmi / hata / oturum bitti / offline / başarı durumları, ekran ekran | açık |
| P0.4 | Klavye ve form ergonomisi (klavye tipi, FocusState, kaydedilmemiş değişiklik uyarısı) | açık |
| P0.5 | Sheet, geri kaydırma, yıkıcı akış güvenliği | açık |

**Kabul:** NP P0 kabul kriterleri + her madde için sahip cihaz notu (model, iOS, build no).

## 3. P1 — Navigasyon ve bilgi mimarisi (NP §P1)

- Taze açılıştan şu işlerin dokunuş sayısını ölç ve tabloya yaz: fatura oluştur, gecikmiş faturayı aç, kuitti incele, eşleşmemiş banka satırını aç, banka hesabını aç/bağla, ALV durumunu aç, firma/profil değiştir, AI asistanı aç.
- 2'den fazla gereksiz iç içe geçiş varsa önce sadeleştir.
- **Kabul:** ölçüm tablosu + sadeleştirme commitleri + önce/sonra simulator ekran görüntüsü.

## 4. P2 — Mevcut özellik tamlığı (NP §P2)

Sırayla: Auth/onboarding → Koti → Myynti → Kirjanpito → Raportit → Asetukset. Her domain için NP'deki listeyi kontrol listesine çevir, eksikleri düzelt, kalanını §10'a yaz. Para hesaplarını SwiftUI'da yeniden yapma; sunucu temelini göster.

## 5. P3 — Güvenilirlik ve offline (NP §P3)

401 → bir kez temizle → login (döngü yok); logout sonrası eski ekran veri tutmaz; GET 502/503/504 sınırlı retry, POST körlemesine retry yok; aynı kullanıcı aksiyonunun retry'ı aynı idempotency anahtarını kullanır; hata metni Fince ve "ne kaydedildi / ne yapabilirsin" der.

## 6. P4 — AI asistan cilası (NP §P4)

Markdown, streaming, durdur/tekrar dene, kaynak linkleri doğru ekrana, öneri ≠ yapılmış aksiyon, sunucu onayı olmadan "yapıldı" denmez. Yeni AI yeteneği eklenmez.

## 7. P5 — Erişilebilirlik, performans, görsel tutarlılık (NP §P5)

Dynamic Type, ikon butonlarına VoiceOver etiketi (görsel zemin **eklenmez**: sahip 2026-10-01'de "A" seçti), ~44pt dokunma alanı, Reduce Motion; önce ölç sonra optimize et.

## 8. P6 — Yayın sertleştirme (NP §P6)

CI kapıları yeşil; gerçek cihaz matrisi (NP listesi); yayın kontrol listesi. Passkey ve Tap to Pay "kapalı ve açıkça gated" olarak listelenir.

## 9. PARK — Stripe POS / Tap to Pay, native passkey

Sahip açıkça "aç" demedikçe: yeni özellik yok, yeniden tasarım yok, imza/entitlement işi yok. Paylaşılan koda dokunulursa POS testleri (`stripe-pos.test.ts`) ve passkey integration testleri çalıştırılır.

---

## 10. Teknik borç kuyruğu — ana akışı bloklamıyorsa P0–P2'yi geciktirme

### Yüksek
- Live-test 2026-09-30 açık P1'leri arasında sunucu kaynaklı olanlar (banka bağlantı durumları G30–G35, offline kurtarma F31–F34, hesap/gizlilik F53–F57).
- Sahip kararı bekleyen: production OCR yolu; AI "ana beyin" (yerel vs bulut); hatırlatma bekleme süresi.

### Orta
- Windows'ta bilinen 5 unit test hatası (backup-script, db-permissions, db-upgrade) — Windows'a özgü, ama yeşil sinyali bulanıklaştırıyor.
- Eski worktree'ler (`.claude/worktrees/agent-*`, her biri ~1 GB) ve `feat/real-app-phase01` dalı temizlenmeli (sahip onayıyla).

### Düşük
- Web arayüzündeki ikon-only buton zemin taraması kapandı (sahip "A"); yeniden açılmaz.

---

## 11. Worker çalışma kuralları

1. **Önce ölç, sonra değiştir.** `native` HEAD, CI, prod commit'i ve ilgili davranış yazılmadan "tamam" denmez.
2. **TDD:** mantık değişikliğinde önce kırmızı test (`LashKirjaCore` → `swift test`, sunucu → vitest/integration).
3. **Küçük commit:** tek mantıksal değişiklik + test. Branch adı NP örneklerine uyar (`fix/otp-autofill-device` gibi).
4. **Swift Windows'ta derlenmez:** her Swift değişikliği push sonrası `iOS native` CI'da yeşil olmadan kapanmaz.
5. **Para:** SwiftUI para toplamı üretmez; sunucu değeri gösterilir.
6. **Migration:** geriye uyumlu; production'a yalnız `deploy-local.ps1` ile.
7. **No fake success:** sunucu onayı yoksa UI "tehty/lähetetty" demez.
8. **Cihaz maddesi** yalnız sahip cihaz notu (model, iOS, build no, gözlenen davranış) ile kapanır.
9. **Sahip teslimi:** cihaz doğrulaması gereken her run sonunda CI'dan imzasız IPA + en fazla 10 maddelik Türkçe test listesi gönderilir.
10. **Commit/push/deploy:** sahip bu planla devam etmeyi istedi; `native`'e commit + push serbest, production deploy ve şema değişikliği öncesi sahibe sorulur.
11. Her run sonunda bu dosyanın §12 RUN günlüğüne kayıt ekle ve gerekirse `docs/worker-reports/YYYY-MM-DD-<iş>.md` yaz.
12. Yeni kalıcı risk §10'a eklenir; çözülünce kapatılır.

---

## 12. Her run için zorunlu rapor formatı

```md
## RUN — YYYY-MM-DD HH:MM

### Hedef
### Başlangıç ölçümü
### Yapılan
### Değişen dosyalar / commitler
### Test / gates
- Core (swift test): ...
- iOS native CI: ...
- Sunucu: ...
### Cihaz / canlı doğrulama
### Kalan risk / blocker
### Sıradaki tek iş
```

### RUN günlüğü

## RUN — 2026-10-05 16:40

### Hedef
Planı oluştur; P0.1 OTP'nin cihazsız yapılabilecek kısmını kapat ve sahibe cihaz testi teslim et.

### Başlangıç ölçümü
- `native` HEAD `dfd6fcb`, tree temiz, `CI` + `iOS native` yeşil (`c05a341`, `dfd6fcb`).
- Production `1ce55c4`; `git diff 1ce55c4..HEAD -- app` boş (sunucu güncel).
- `AccountCodeTests.swift`: NP P0.1 giriş şekilleri 1–9 core seviyesinde testli; şekil 10 (write-back sonrası tek gönderim) `AccountCodeField.swift` içindeki `@State settled` ile, testsiz.

### Yapılan
- Bu plan dosyası oluşturuldu (`84ab561`).
- P0.1: tamamlama kararı (`settled` + write-back) view'dan core'a taşındı: `AccountCodeGate` (`LashKirjaCore/Auth/AccountCodeGate.swift`). `AccountCodeField` artık sadece gate sonucunu uyguluyor. Davranış değişmedi.

### Değişen dosyalar / commitler
- `84ab561` docs(plans): MASTER-WORKER-PLAN
- `5f3f1f5` fix(ios): OTP completion decided in core and tested (P0.1) — `AccountCodeGate.swift`, `AccountCodeField.swift`, `AccountCodeGateTests.swift`

### Test / gates
- Core (swift test, Linux CI): yeşil; 7 yeni gate testi (6 hane elle, AutoFill çift ekleme + write-back, 1–2 hane sonrası öneri, 7. hane reddi, temizle + tekrar yaz, uzun basma yapıştırma, 7 hane).
- iOS native CI: run 37316830020 yeşil (simulator build/test + imzasız IPA).
- Sunucu: değişiklik yok.

### Cihaz / canlı doğrulama
- IPA + Türkçe test listesi sahibe gönderildi (2026-10-05). **Sonuç bekleniyor** — P0.1 bu not gelmeden kapanmaz.

### Kalan risk / blocker
- Gerçek iPhone'da AutoFill'in ne eklediği hâlâ gözlenmedi.
- `onPasteOther` (sıfırlama linki yapıştırma) yolu gate testlerinde yok.
- Testler implementasyonla aynı commit'te yazıldı (önce-kırmızı kanıtı yok).

### Sıradaki tek iş
- Sahip OTP sonucu: geçti → P0.1 kapat, P0.2 (dokunma geri bildirimi + çift gönderim kilidi) başla. Kaldı → geçici debug enstrümantasyonu (yalnız uzunluk/desen).

---

## 13. Worker'ın şimdi başlayacağı iş

**P0.1 OTP AutoFill — cihazsız kısım, sonra cihaz kabulü.**

1. `AccountCodeField.swift` içindeki tamamlama kararını (`settled` + `kept` mantığı) `LashKirjaCore/Auth` altında saf bir tipe taşı (ör. `AccountCodeGate`); view yalnız onu çağırsın. Davranış değişmesin.
2. Testler: elle 6 hane → 1 gönderim; AutoFill çift ekleme + write-back → 1 gönderim; 7. hane reddi → yeniden gönderim yok; yanlış kod sonrası `""` → tekrar yazınca yeniden gönderim; 1–2 hane sonrası öneri → 1 gönderim.
3. Push → `iOS native` CI yeşil → IPA artifact.
4. Sahibe IPA + Türkçe OTP test listesi (NP P0.1 kabul maddeleri).
5. Cihaz sonucu gelince: geçti → P0.1 kapanır, P0.2 başlar. Kaldı → NP'deki geçici debug enstrümantasyonu (yalnız uzunluk/desen, rakam değil) eklenir.

**P0 bitmeden P1'e geçme.**
