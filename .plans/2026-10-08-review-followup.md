# 2026-10-08 — Dış inceleme takibi + yabancı ALV bitişi + muhasebe çekirdeği v1

Kaynak: sahibin yapıştırdığı UI/UX/backend/muhasebe incelemesi (native @ 4c3e6ec) ve
`feature/foreign-vat-capture` dalındaki yarım iş. Sahip hedefi: "tamamlananları doğrula, eksikleri
uçtan uca planla ve uygula; sorun çıkarsa önerilen yoldan git."

## Doğrulanan (tamam)
- Yabancı ALV v1: şema alanları prod'da (`currency`, `originalAmountCents`, `vatTreatment`), 446 kuitti `domestic`.
- ALV hesaplaması 305/306/313/314/301 reverse charge (alv.test.ts) — loader henüz alanı geçirmiyor.
- "Lisää kuitti", 25 dosya + paralel okuma, yükleme limiti 60/10 dk — prod `c0f42e1`.
- Olay günlüğü + request id + "Ilmoita ongelmasta" — prod'da, uç nokta 401 (oturumsuz) döndürüyor.
- İncelemedeki "InvoiceLineCard 32 pt" iddiası geçersiz (zaten 44 pt `tapTarget()`).

## Faz 1 — Sunucu doğruluk düzeltmeleri
1. `confirmMatch`: okuma + dönem kilidi + yazma tek transaction içinde.
2. Tiliote: aynı dosya tekrar yüklenince yalnız alınmamış (heldBack) satırlar içeri alınır; hepsi varsa 409.
3. SQLite `PRAGMA busy_timeout`.

## Faz 2 — Yabancı ALV'yi bitir
1. AI'nın `currency` / `sellerCountry` okuması kuittiye yazılır; yabancı → `vatTreatment` önerisi.
2. Kuitti / ostolasku API'leri `currency`, `originalAmount`, `vatTreatment` alır ve döndürür.
3. `alv-period.ts` loader alanı `computeAlvReport`'a geçirir; ALV sayfası (web + iOS) 305/306/313/314 + açıklama.
4. Kuitti ↔ pankki kohdistuksessa EUR dışı kuitti bankanın EUR summasını alır.
5. Formlar: "ALV-käsittely" seçimi (web kuitti editörü, iOS kuitti formu, ostolasku formu).
6. Veri düzeltme betiği: yedek → dry-run → apply (Svea 25,01 €, yabancı kuittiler), geri alma dosyası.

## Faz 3 — iOS HIG / erişilebilirlik
1. "+" artık `role: .search` değil.
2. Global `defaultMinListRowHeight 40` kaldırılır.
3. Silme: başarı titreşimi yalnız sunucu onayından sonra.
4. Dynamic Type: BankHub ay rakamları, hesap satırı, fatura satırı, fatura alt çubuğu → `ViewThatFits`.
5. Klavye araç çubuğundan toplam çıkarılır.
6. `.snappy` animasyonlar Reduce Motion'a uyar.

## Faz 4 — Pankki sadeleştirme
1. BankHub'dan filtre çipleri kalkar (filtre BankFeed'de).
2. "Kohdista N": onay öncesi özet (adet, toplam tutar, önizleme).

## Faz 5 — Muhasebe çekirdeği v1 (Oy: çift taraflı zorunlu)
Türetilmiş, salt okunur v1 — mevcut akışları bozmaz:
1. Tilikartta (Finnish standart alt kümesi) + kategori → hesap eşlemesi.
2. Posting motoru: satış faturası, ödeme, ostolasku, ödeme, kuitti, banka satırı → tosite + rivit; Σ debet = Σ kredit testle zorunlu.
3. Raporlar: päiväkirja, pääkirja, saldoluettelo, tase-luonnos (açılış bakiyesi eksikse fark gösterilir).
4. Muhasebeci dışa aktarımı (CSV).
v2 (sonra): kalıcı/immutable tositeler, tilikausi kapanışı, amortisman.

## Kapsam dışı (bilinçli)
PostgreSQL, Redis rate limit, çok şirketli yapı: tek sahip + tek sunucu için erken.

## RUN
- 2026-10-08: plan yazıldı; Faz 1 başlıyor.
