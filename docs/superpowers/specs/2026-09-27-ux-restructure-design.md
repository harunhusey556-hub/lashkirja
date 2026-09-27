# LashKirja: sade gezinme ve "tek dokunuşla onay" tasarımı

_Tarih: 2026-09-27. Durum: kullanıcı onayı bekliyor. Görseller: [`2026-09-27-ux-restructure/`](./2026-09-27-ux-restructure/)._

## 1. Amaç

Uygulama şu an labirent gibi: aynı iş birden fazla yerden açılıyor (fiş ↔ banka eşleştirmesi 5 yerde, fiş onayı 2 yerde, banka bağlama hem Pankki'de hem Asetukset'te), menü etiketleri gittiği sayfayla uyuşmuyor, bazı sayfalardan geri çıkılamıyor. Hedef kullanıcı muhasebe bilmeyen tek kişilik ya da az çalışanlı işletmeler (kirpik teknisyeni, evden çalışan hizmet işletmeleri).

Bu tasarımın sonunda:

1. **Her işin tek evi var.** Bir işlevin kalıcı menü yolu birden fazla olamaz.
2. **Uygulama açılınca üç soruya tek ekranda cevap verir:** Bu ay ne kadar hazır? Benden ne lazım? Sıradaki son tarih ne?
3. **Otomatik çözülemeyen her şey Koti'de tek dokunuşla cevaplanabilir bir görev olur.** Her onay geri alınabilir.
4. **Ay sonunda eksik kalmaz:** ilerleme göstergesi ay kapanana kadar ne kaldığını gösterir.

`PRODUCT_PLAN.md` §4, §12 ve §15'teki "istisna odaklı ana ekran" fikri bu tasarımın temelidir; ayrı bir kavram icat edilmez.

### Kapsam dışı (sonraki alt projeler)

- **3. Eksik fiş bildirimi (push).** Bu tasarım görevlere kalıcı kimlik verir ve her görevin bir detay sayfası olur; bildirim oraya bağlanacak. Bildirimin kendisi burada yok.
- **4. AI asistan geliştirmesi.** Başlıktaki asistan butonu yerinde kalır, davranışı değişmez.

## 2. Bilgi mimarisi

### 2.1 Ana menü

| Mobil sekme | Masaüstü kenar çubuğu | Yol | İçerik |
|---|---|---|---|
| Koti | Koti | `/dashboard` | Ay durumu, görevler, otomatik yapılanlar |
| Myynti | Myynti | `/laskut` | Satış faturaları, müşteriler, tekrarlayan faturalar |
| **+** (ortada) | "Lisää" butonu (üstte) | sayfa değil, alt sayfa (sheet) | Fiş çek, dosya seç, yeni fatura, e-postadan getir |
| Kirjanpito | Kirjanpito | `/kirjanpito` | Tek işlem listesi, ALV, alış faturaları, banka hesapları, kapalı dönemler |
| Raportit | Raportit | `/raportit` | Değişmez |

- **Asetukset** profil resminin arkasına taşınır (başlıktaki avatar → Asetukset). Mobilde "Muut" menüsü kalkar.
- Kök sayısı 7'den 4'e iner (`Etusivu, Pankki, Kuitit, Myynti, Kirjanpito, Raportit, Asetukset` → `Koti, Myynti, Kirjanpito, Raportit`). "Etusivu" etiketi "Koti" olur.
- Pankki ve Kuitit kök olmaktan çıkar: banka işlemleri ve fişler Kirjanpito'daki tek listede birleşir.

### 2.2 Gezinme kuralları (`app/docs/navigation.md` güncellenir)

Mevcut on kural korunur; şunlar değişir veya eklenir:

1. Kökler: Koti, Myynti, Kirjanpito, Raportit. Asetukset kök değildir, avatardan açılır.
2. Filtreler sayfa değiştirmez; sayfa değiştiren sekme/çip satırı kullanılmaz. Bir sayfada en fazla **bir** filtre satırı olur (bkz. Myynti).
3. Detay sayfasında **tek geri butonu** vardır ve üst seviyenin adını taşır ("‹ Kirjanpito", "‹ Myynti"). Kırıntı yolu (breadcrumb) ve ikinci "Takaisin" yoktur. Geri butonu `router.back()` kullanır; geçmiş yoksa üst seviyeye `replace` eder (bugünkü `push` davranışı geri hareketini bozuyor).
4. Detay sayfalarında alt sekme çubuğu gizlenir, yerine sabit ana aksiyon alanı gelir.
5. Oluşturma işlemleri tek kapıdan girer: "+" sayfası. İstisna: Myynti'deki "Uusi lasku" kısayolu, çünkü fatura yazmak o ekranın asıl işi (+ sayfasındaki "Uusi myyntilasku" aynı rotaya gider, ayrı bir akış değildir).

`navigationViolations()` ve `navigation.test.ts` bu kuralları kontrol edecek şekilde güncellenir.

## 3. Ekranlar

Görsel dil: uygulamanın mevcut renk tokenları (`--color-accent #9a5650`, `--color-charcoal`, `--color-success`), mevcut ikon seti, iOS tarzı gruplu listeler, büyük başlık. Kart içinde kart yok; filtre çipleri dışında pill kullanılmaz.

### 3.1 Koti — [`01-koti.png`](./2026-09-27-ux-restructure/01-koti.png)

Yukarıdan aşağıya:

1. **Büyük başlık:** ayın adı ("Syyskuu"), altında işletme adı. Başlık satırında asistan butonu ve avatar.
2. **Ay kartı:** "3 asiaa ennen kuun loppua", "38 / 41 tapahtumaa on kunnossa", parçalı ilerleme çubuğu, alt satırda sıradaki son tarih ("ALV-ilmoitus 12.10." ve "184,20 € maksettavaa").
   - Görev yoksa: "Kaikki kunnossa" ve çubuk tam dolu.
   - Ay seçici yok; Koti her zaman içinde bulunulan ayı gösterir. Geçmiş aylar Kirjanpito'dan görülür.
3. **"Tarvitaan sinulta":** görev listesi (bkz. §5.1). Her satır: ikon, karşı taraf, tutar, nedeni, sağda tek dokunuşluk aksiyon ("Lisää kuva", "Hyväksy", "Kohdista", "Muistuta"). Satırın aksiyon dışındaki kısmına dokununca ilgili detay/onay sayfası açılır. En fazla 5 satır, fazlası için "Näytä kaikki N".
4. **"Hoidettu automaattisesti":** tek satır özet ("14 tapahtumaa tällä viikolla", "Vuokra, Elisa ja 12 kuittia sähköpostista"). Dokununca otomatik işlemler listesi açılır (`/dashboard/automaattiset`), her satırda "Kumoa".
5. İşlem sürüyorsa (fiş okunuyor, banka senkronu) ay kartının altında ince bir durum satırı; başarısız arka plan işi bir görev olarak listeye düşer. Ayrı "Työt" sayfası kalkar.

### 3.2 Kirjanpito — [`02-kirjanpito.png`](./2026-09-27-ux-restructure/02-kirjanpito.png)

- Büyük başlık, altında ay seçici ("‹ Syyskuu 2026 ›").
- **"Tapahtumat"** bölümü: o ayın kayıtları, en yeni üstte, ilk 5 satır ve "Kaikki N" bağlantısı (`/kirjanpito/tapahtumat?kk=2026-09`). Her satır: karşı taraf, tutar (gider "−", gelir yeşil "+"), tarih ve **belge durumu**:
  - "Kuitti puuttuu" (vurgu rengi, uyarı ikonu)
  - "Kuitti" (yeşil onay ikonu)
  - "Lasku 3" / "Lasku 3?" (satış faturasına bağlı / öneri)
  - "Ei kuittia tarvita" (banka masrafı, kendi transferi gibi)
- **"Ilmoitukset ja kaudet"** bölümü, her biri bir satır ve detay sayfası:
  - ALV-ilmoitus (tutar, eräpäivä) → `/kirjanpito/alv`
  - Ostolaskut (açık sayısı) → `/kirjanpito/ostolaskut`
  - Pankkitilit (banka adı) → `/kirjanpito/pankkitilit` (hesaplar, bağlantı durumu, "Yhdistä pankki", içe aktarılan ekstre dosyaları)
  - Suljetut kaudet ("Elokuu asti") → `/kirjanpito/kaudet`

**Tek işlem listesi (kayıt = entry).** Listede iki tür satır vardır, ikisi de aynı görünür:
- **Banka işlemi** (`Transaction`, türü `tulo` veya `meno`), bağlı fişi ya da faturası varsa onunla birlikte.
- **Bankası olmayan fiş** (`Receipt`, bağlı işlemi yok): nakit alım veya henüz eşleşmemiş belge. Belge durumu yerine "Ei pankkitapahtumaa" gösterilir; eşleşme önerisi varsa görev olarak Koti'ye düşer.

`oma_siirto` ve `palkka` türleri listede görünür ama belge istemez ("Ei kuittia tarvita").

### 3.3 Myynti — [`03-myynti.png`](./2026-09-27-ux-restructure/03-myynti.png)

- Başlık satırında "Uusi lasku" butonu ve avatar.
- Özet kartı: "Avoinna 683,98 €", altında "602,40 € myöhässä".
- **Tek filtre satırı**, sayılarla: Kaikki, Myöhässä, Luonnokset, Avoimet, Maksetut. Hyvitetyt (alacak dekontu verilmiş faturalar) ayrı bir çiptir ve yalnız böyle bir fatura varsa görünür.
- "Kaikki" seçiliyken fatura listesi duruma göre gruplanır, önce harekete geçilmesi gerekenler: Myöhässä ("Muistuta"), Luonnokset ("Lähetä"), Odottaa maksua, Maksetut. Başka bir filtre seçilince yalnız o grup.
- Listenin altında iki satır: Asiakkaat (sayı) → `/asiakkaat`, Toistuvat laskut (sayı) → `/toistuvat`.
- Alış faturaları (Ostolaskut) buradan çıkar, Kirjanpito'ya taşınır.

### 3.4 "+" sayfası — [`04-lisaa-sheet.png`](./2026-09-27-ux-restructure/04-lisaa-sheet.png)

Alttan açılan sayfa, her ekrandan:

1. **Kuvaa kuitti** (büyük birincil buton): iOS'ta doğrudan kamera, web'de dosya/kamera seçici. Fotoğraf yüklenir, arka planda okunur (mevcut `document-jobs`), sonuç Koti'ye "Hyväksy" görevi olarak düşer. Kullanıcı yüklemeden sonra hiçbir formu beklemez.
2. **Valitse tiedosto:** PDF veya görsel; **ekstre dosyası da buradan** (CSV/XLSX/camt/PDF). Tür otomatik ayırt edilir: ekstre ise banka hesabına aktarılır, fiş ise okunur.
3. **Uusi myyntilasku** → `/laskut/uusi`
4. **Hae sähköpostista:** e-posta bağlıysa senkronu başlatır ve son alım zamanını gösterir; bağlı değilse Asetukset → Sähköposti sayfasına götürür.

### 3.5 Detay sayfası kalıbı — [`05-tapahtuma-detail.png`](./2026-09-27-ux-restructure/05-tapahtuma-detail.png), [`07-lasku-detail.png`](./2026-09-27-ux-restructure/07-lasku-detail.png)

Tüm detay sayfaları aynı iskeleti kullanır:

1. Üst çubuk: "‹ Üst seviye" ve "···" (seyrek işler: PDF, kopyala, hyvityslasku, sil, eşleşmeyi kaldır).
2. Ortada büyük tutar, karşı taraf, tarih/açıklama, altında durum etiketi ("Kuitti puuttuu", "Myöhässä 15 päivää").
3. Bilgi satırları (anahtar-değer grubu).
4. Gerekirse açıklama kutusu ("Miksi tämä kysytään") veya geçmiş zaman çizelgesi ("Historia").
5. Altta sabit ana aksiyon ve en fazla bir ikincil metin aksiyon.

**İşlem detayı** (`/kirjanpito/tapahtuma/[id]`; bugünkü ekstre detayı yerine tek işlem): fiş eksikse "Kuvaa kuitti" ve "Kuittia ei ole". "Kuittia ei ole" seçilince kayıt tamamlanır ve ALV indirimi düşer. Kullanıcıya bu önceden tek cümleyle söylenir.

**Bankası olmayan fiş detayı** (`/kirjanpito/kuitti/[id]`): aynı kalıp; fişin görseli, satırlar, kategori, ALV; "Linkitä tapahtumaan" ikincil aksiyonu.

**Fatura detayı** (`/laskut/[id]`): duruma göre tek ana aksiyon: Luonnos → "Lähetä", Myöhässä → "Lähetä muistutus", Avoin → "Kirjaa maksu". Müşteri adı müşteri detayına bağlantıdır (bugün eksik).

### 3.6 Onay sayfası — [`06-hyvaksynta-sheet.png`](./2026-09-27-ux-restructure/06-hyvaksynta-sheet.png)

Koti'de bir "Hyväksy" görevinin satırına dokununca alttan açılır. Aksiyon butonuna doğrudan dokunmak bu sayfayı açmadan onaylar.

1. Başlık: satıcı ve tutar.
2. **"Kuitista luettu"** ve tarih: ürün satırları **alt alta**, her satırda ad, "adet × birim fiyat" ve satır tutarı; altta "Sis. ALV 25,5 %" ve tutarı. Satır okunamadıysa bu bölüm gösterilmez (OCR yolunda satır yok).
3. **"✦ Ehdotus" kartı:** yıldız ikonu (AI önerisi olduğunu gösterir), öneri tek satır ("Tarvikkeet, ALV 25,5 %"), altında gerekçeler ayrı satırlarda yeşil onay ikonuyla ("Kaikki rivit ovat ripsitarvikkeita", "4 aiempaa ostoa samalta myyjältä samaan kategoriaan").
4. **"Muista [satıcı] jatkossa"**: sağda onay kutusu, varsayılan işaretli. İşaretliyse `VendorCategoryRule` oluşturulur ve o satıcı bir daha sorulmaz.
5. Alt: "Muuta" (ikincil, kategori/ALV düzenleme) ve "Hyväksy" (birincil).

## 4. Rota haritası

| Bugün | Sonra | Not |
|---|---|---|
| `/dashboard` | `/dashboard` (Koti) | içerik yeniden yazılır |
| `/pankki`, `/pankki/tapahtumat`, `/pankki/taydennys` | → `/kirjanpito` | 308 yönlendirme |
| `/pankki/tapahtumat/[id]` (ekstre) | → `/kirjanpito/pankkitilit` | ekstre dosyaları hesabın altında |
| `/pankki/tilit` | → `/kirjanpito/pankkitilit` | |
| `/kuitit` | → `/kirjanpito/tapahtumat` | |
| `/kuitit/uusi` | → `/kirjanpito` | yükleme artık "+" sayfasında |
| `/kuitit/[id]` | → `/kirjanpito/kuitti/[id]` | |
| `/tyot` | → `/dashboard` | görevler Koti'de |
| `/alv-raportti` | → `/kirjanpito/alv` | |
| `/ostolaskut` | → `/kirjanpito/ostolaskut` | |
| `/asetukset/kirjanpito` | → `/kirjanpito/kaudet` | |
| `/asetukset/pankkiyhteys` | → `/kirjanpito/pankkitilit` | banka bağlantısının tek evi |
| `/laskut`, `/laskut/uusi`, `/laskut/[id]`, `/asiakkaat`, `/asiakkaat/[id]`, `/toistuvat` | değişmez | registry'de `myynti` altında |
| `/raportit`, diğer `/asetukset/*` | değişmez | |
| `/bank/callback` | değişmez | dönüş butonu metni "Takaisin pankkitileihin" olur ve `/kirjanpito/pankkitilit`'e gider |

Yönlendirmeler `next.config.ts` `redirects()` içinde, mevcut `/tiliotteet` yönlendirmelerinin yanında. `chat-honesty.ts` içindeki bilinen ekran listesi ve `proxy.ts` aynı değişiklikle güncellenir.

**Güvenlik düzeltmesi:** `proxy.ts` bugün korunan sayfaları bir izin listesiyle sayıyor ve `/tyot` bu listede yok. Liste ters çevrilir: herkese açık sayfalar (`/login`, `/unohtunut-salasana`, `/palauta-salasana`, `/vahvista-sahkoposti`) açıkça sayılır, geri kalan her sayfa korunur. `/bank/callback` bugün olduğu gibi korumalı kalır (oturum çerezi `SameSite=Lax` olduğu için banka dönüşünde gelir). Böylece yeni rota eklenince koruma unutulamaz.

## 5. Backend

### 5.1 Görev motoru: `lib/tasks.ts`

Mevcut `lib/work-queue.ts` genişletilir ve yeniden adlandırılır. Her görev:

```ts
type Task = {
  id: string;              // kalıcı: "<kind>:<kaynak id>", bildirimler için
  kind: TaskKind;
  month: string;           // "YYYY-MM", ay kapanışını bloke eden görevler için
  title: string;           // karşı taraf
  amountCents: number | null;
  reason: string;          // "Kuitti puuttuu, 24.9."
  action: { kind: TaskActionKind; label: string } | null; // tek dokunuş
  href: string;            // detay sayfası
  blocksMonthClose: boolean;
};
```

| Tür | Kaynak | Tek dokunuş | Ay kapanışını bloke eder |
|---|---|---|---|
| `missing_receipt` | `meno` işlemi, onaylı fişi yok, `ignored` değil | "Lisää kuva" (kamera, sonra fiş işleme bağlanır) | evet |
| `approve_document` | `reviewStatus = pending` fiş | "Hyväksy" (öneriyi uygular) | evet |
| `confirm_payment` | gelen işlem için fatura önerisi (yalnız tutar eşleşmesi) | "Kohdista" | evet |
| `ambiguous_match` | birden fazla aday | yok, detayda seçilir | evet |
| `unknown_income` | `tulo` işlemi, fatura veya fiş yok | yok, detayda "Myynti / Oma raha / Laina / Muu" | evet |
| `amount_mismatch` | bağlı fiş tutarı işlemden 0,50 €'dan fazla farklı | yok | evet |
| `overdue_invoice` | vadesi geçmiş, ödenmemiş satış faturası | "Muistuta" | hayır |
| `failed_job` | başarısız arka plan işi | "Yritä uudelleen" | hayır |

Sıralama: önce ay kapanışını bloke edenler, sonra tutara göre azalan.

### 5.2 Tek dokunuş ve geri alma

- `GET /api/tasks`: görev listesi.
- `POST /api/tasks/resolve` `{ taskId, action }`: görev türüne göre mevcut servisleri çağırır (fiş onayı, `confirmMatch`, `recordPayment`, hatırlatma, işi yeniden kuyruğa alma). Idempotent: görev artık yoksa 409 değil `{ alreadyResolved: true }`. Her çözüm bir `AutomationEvent` yazar (`previousValue`/`newValue`) ve yanıt `undoToken` döner.
- `POST /api/tasks/undo` `{ undoToken }`: event'teki önceki değeri geri yazar. Kapalı dönemde geri alma, düzenleme gibi `assertPeriodOpen` ile reddedilir.
- İstemci: aksiyon sonrası alt kısımda "Hyväksytty. Kumoa" bildirimi (5 sn).

### 5.3 Ay durumu: `lib/month-status.ts`

`getMonthStatus(userId, month)` → `{ total, done, blocking: Task[], deadline }`.

- **Kayıtlar:** ayın `tulo`/`meno` işlemleri ve bankası olmayan fişler.
- **Hazır sayılır:** işlem `confirmed` ya da `ignored`, veya bağlı fatura ödemesi/alış ödemesi var; bankası olmayan fiş onaylı.
- **Son tarih:** yeni saf fonksiyon `lib/vat-deadline.ts`. Aylık dönem: dönemden sonraki ikinci ayın 12'si. Çeyreklik: çeyrekten sonraki ikinci ayın 12'si. Yıllık: izleyen yılın 28 Şubat'ı (hafta sonu/tatile denk gelirse bir sonraki iş günü). Tutar, Koti ile ALV sayfası ayrışmasın diye mevcut `lib/alv-period.ts` üzerinden hesaplanır.

### 5.4 Tek işlem listesi

- `GET /api/kirjanpito/entries?month=YYYY-MM&cursor=`: banka işlemleri ve bankası olmayan fişlerin birleşik, tarihe göre sıralı, sayfalı listesi; her satırda `documentState`.
- `GET /api/kirjanpito/entries/[kind]/[id]`: detay.
- "Kuittia ei ole": mevcut `POST /api/matching/ignore` yeniden kullanılır, isteğe bir `reason` alanı eklenir (`bank_fee`, `no_receipt`, `own_transfer`) ve `Transaction.ignoredReason` sütununa yazılır (yeni migration).

### 5.5 Fiş satırları

- Yeni model `ReceiptLine`: `receiptId`, `position`, `description`, `quantityMilli`, `unitPriceCents`, `totalCents`, `vatRatePermille?`. Fiş silinince silinir.
- `ExtractedReceipt` tipine `lines?: {...}[]` eklenir. LLM ve Copilot istemleri satırları döndürecek şekilde genişletilir; OCR yolu satır üretmez (tahmin edilmez).
- Satırların toplamı fiş toplamından 0,05 €'dan fazla saparsa satırlar gösterilmez ve saklanmaz (yanlış liste hiç listeden kötü).
- Onay sayfasındaki gerekçeler `lib/vendor-intelligence.ts` (aynı satıcıdan önceki kategori sayısı) ve satır açıklamalarından üretilir; öneri kaynağı `receipt-confidence.ts` ile uyumlu kalır.

### 5.6 Değişmeyenler

Veritabanındaki para birimi (tamsayı sent), dönem kilidi, fatura yaşam döngüsü, eşleştirme eşikleri, ALV hesabı değişmez. Bu tasarım var olan servislerin üstüne yeni bir yüz koyar; muhasebe kuralı değiştirmez.

## 6. Boş, yükleniyor ve hata durumları

- Koti, görev yok: "Kaikki kunnossa" ve son otomatik işlemler.
- Kirjanpito, banka bağlı değil ve işlem yok: tek boş durum kartı, "Yhdistä pankki" ve "Tuo tiliote tiedostona".
- Liste yüklenemedi: mevcut `screen-state.ts` kalıbı; boş durum metni başarısız yüklemede gösterilmez.
- Tek dokunuş başarısız: satır eski haline döner, hata satırın altında gösterilir, görev listeden düşmez.

## 7. Test

- **Birim:** `tasks.ts` (her tür ve sıralama), `month-status.ts`, `vat-deadline.ts` (ay/çeyrek/yıl, hafta sonu), güncellenmiş `navigation.test.ts` (4 kök, Asetukset kök değil, tek filtre satırı kuralı, her rotanın `kind` ve `parent` değeri).
- **Entegrasyon (gerçek SQLite):** `/api/tasks`, `resolve` + `undo` her tür için, kapalı dönemde undo reddi, `/api/kirjanpito/entries` (bankası olmayan fiş dahil, sayfalama), `ignoredReason`, `ReceiptLine` kaydı ve sapma kuralı, eski rotaların 308 yönlendirmesi, `proxy.ts` ters liste (korumasız sayfa kalmadığını tüm `page.tsx` dosyalarını gezerek doğrulayan test).
- **E2E (Playwright, telefon ve masaüstü):** Koti'de görev "Hyväksy" → satır kaybolur → "Kumoa" → geri gelir; eksik fiş işlem detayından "Kuittia ei ole"; Myynti filtreleri; "+" sayfasından dosya yükleme; her detay sayfasında tek geri butonu ve geri hareketinin önceki sayfaya dönmesi. Kaldırılan sayfalara bağlı mevcut testler (`app.spec.ts`, `test:e2e:ci` grep listesi) yeni rotalara taşınır.

## 8. Uygulama sırası (plan bu sıraya göre yazılacak)

1. **İskelet:** navigation registry, 4 kök ve avatar menüsü, tek geri butonu, `proxy.ts` ters liste, yönlendirmeler. Mevcut sayfalar yeni yollarında, içerik henüz eski.
2. **Kirjanpito:** tek işlem listesi API'si ve ekranı, işlem ve fiş detayları, "Ilmoitukset ja kaudet" altına taşınan sayfalar, `ignoredReason`.
3. **Koti:** görev motoru, ay durumu, ALV son tarihi, tek dokunuş ve geri alma, otomatik işlemler listesi. `/tyot` kalkar.
4. **Onay sayfası ve fiş satırları:** `ReceiptLine`, AI istem değişikliği, gerekçeler, "Muista jatkossa".
5. **Myynti:** gruplama ve filtre satırı, fatura detayı kalıbı.
6. **"+" sayfası:** tek giriş kapısı, dosya türünü otomatik ayırt etme.

Her adım kendi içinde çalışır durumda bırakılır; testler her adımda yeşil.

## 9. Riskler ve kararlar

- **Kuitit sayfasının kalkması** en büyük davranış değişikliği. Kullanıcı onayladı (2026-09-27). Fiş arama ihtiyacı "Kaikki N" listesindeki arama kutusuyla karşılanır.
- **Satır okuma yalnız AI yolunda:** API anahtarı olmayan kurulumda onay sayfası satırsız görünür; bu kabul edildi.
- **Yıllık ALV dönemi son tarihi** küçük işletmeler için 28.2. varsayıldı; farklı dönem türü eklenirse `vat-deadline.ts` tek değişiklik noktasıdır.
- **iOS uygulaması:** tasarım aynı web arayüzünü kullanır; kamera açma mevcut Capacitor eklentisiyle yapılır. Yeni IPA gerekmez, ancak test cihazında denenmesi gerekir.
