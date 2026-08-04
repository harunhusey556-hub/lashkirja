# TESTIRAPORTTI — LashKirja parsers

Testattu: 2026-08-01
Ympäristö: Node v24.18.0, tesseract OCR (fin+eng), pdftotext

## Tulokset

| Tiedosto | Tyyppi | Tulos | Yksityiskohdat |
|----------|--------|-------|----------------|
| banka/2026-05_pankkikulut_243.06.jpg | kuitti-ocr | OK | vendor=Pankkikulut, date=–, total=243.06, vat_items=0 |
| diger/2026-04-09_Tyoelake.pdf | kuitti-ocr | OK | vendor=ELO, date=2026-04-09, total=796, vat_items=0 |
| diger/2026-04-10_Tyoelake_1ba73710.pdf | kuitti-ocr | OK | vendor=TIYOUBA OY, date=2026-04-10, total=1237.5, vat_items=0 |
| diger/2026-04-16_HelsinkiKaupunki.pdf | kuitti-ocr | OK | vendor=HELSINGIN KAUPUNKI, date=2026-04-15, total=1499.07, vat_items=1 |
| diger/2026-05-05_LPOnet_32622644.pdf | kuitti-ocr | OK | vendor=Korkolain mukainen, date=2026-05-04, total=17.21, vat_items=1 |
| camt052_2026-05.xml | camt-xml | OK | 180 transactions, dates/parties/amounts present |
| mayis_2026_tiliote.xlsx | xlsx | OK | 105 transactions parsed |
| CTR_Saastopankki_2026-05.pdf | pdf-tiliote | OK | 28 transactions parsed |

## Yhteenveto

- **8/8** testiä läpäisi
- Kuittien OCR-jäsennys: teksti luetaan tesseractilla (fin+eng) tai pdftotextillä, sitten regex-parseri hakee myyjän (ensimmäinen rivi), päivämäärän (dd.mm.yyyy), loppusumman (YHTEENSÄ/Summa/Maksettava) ja ALV-erittelyn
- camt.052 XML: ISO 20022 -standardin mukainen jäsennys, tapahtumien päivämäärä/vastapuoli/summa/viite
- XLSX: sarakkeiden automaattinen tunnistus (päivä/summa/saaja/viite/viesti)
- PDF-tiliote: pdftotext + regex-parseri tapahtumille (pvm + vastapuoli + summa)

## Tunnetut rajoitukset

- OCR-parseri on regex-pohjainen eikä tunnista kaikkia kuittiformaatteja
- PDF-tiliotteiden jäsennys riippuu PDF:n tekstirakenteesta — skannatut kuvat eivät toimi ilman OCR:ää
- XLSX-parseri olettaa tietynlaiset sarakenimet (suomenkieliset)
- HEIC-kuvien OCR vaatii imagemagick-muunnoksen (ei implementoitu v1:ssä)
- AI-pohjainen analyysi (LLM_API_KEY) antaisi merkittävästi paremman tarkkuuden kuin OCR-regex
