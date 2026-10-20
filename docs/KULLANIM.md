# RSI Botu — Kullanım Kılavuzu

Bot, Binance vadeli kripto coinlerinde **4 saat, 12 saat ve 24 saat RSI aynı anda** belirlediğin eşiği
geçtiği an o coin için gruba **ayrı bir kart** atar. Tüm ayarları Telegram'dan sen yönetirsin.

## Kart

```
🔴 #XYZUSDT · RSI aşırı alım
RSI 4 saat    84.2
RSI 12 saat   82.1
RSI 24 saat   80.5
💲 Fiyat: 1.2345 · 24 sa +%12.4
💸 Funding: +%0.0100 · 19:00'de (2 sa 15 dk sonra)
⏱ 20.10 16:45 · şart: 4s · 12s · 24s RSI ≥ 80
```

🔴 aşırı alım, 🟢 aşırı satım. Grafik açıksa kart grafikli gelir (mumlar + altta RSI ve eşik çizgileri).
Aynı anda birden fazla coin şarta girerse her biri **kendi kartıyla** gelir.

**Liste** — `/liste` yazınca ya da her saat başı (ayarlanabilir): o an şartı sağlayan tüm coinler, en güçlüden.

## Ayar paneli — /ayarlar

| Buton | Ne yapar |
|---|---|
| 🔴 Aşırı alım: Açık / Kapalı | aşırı alım kartlarını aç / kapat |
| Eşik ≥ 80 ✏️ | eşiği değiştir — hazır değerler 70 · 75 · 80 · 85 · 90 ya da −5 / −1 / +1 / +5 |
| 🟢 Aşırı satım … · Eşik ≤ 20 ✏️ | aynısı aşırı satım için (10 · 15 · 20 · 25 · 30) |
| ✅ 4 saat · ✅ 12 saat · ✅ 24 saat | şarta hangi zaman dilimleri girsin (en az biri) |
| 🖼 Grafik: Açık / Kapalı | kartta grafik |
| ○ Günlük · ◉ 4 saat · ○ Haftalık | grafiğin zaman dilimi |
| 🔔 Ses | kartlar sesli / sessiz |
| 📋 Liste ✏️ | periyodik liste: Kapalı · 30 dk · 1 saat · 4 saat · Günde 1 |
| ⚙️ Gelişmiş | RSI periyodu, tekrar kart farkı, anlık mum, en az hacim, tümünü sıfırla |
| 📋 Şimdi listele | listeyi hemen gönder |
| ✖️ Kapat | paneli kapat |

Panel aynı mesajda güncellenir. Değişiklik **anında** geçerli olur ve bot yeniden başlasa da korunur.
Şart değişince bot, yeni ayarla şu an şartı sağlayanları bir kez listeler (bunlar için ayrıca kart gelmez;
şarta yeni girenler için gelir). Herkes paneli görebilir; değiştirmek yalnız grup yöneticilerine açık.

Komutla da olur: `/ayar ustEsik 85` · `/ayar altEsik 15` · `/ayar tf1d kapat` · `/ayar grafik kapat` ·
`/ayar grafikTf 1w` · `/ayar listeDk 240` · `/ayar sifirla`

## Sık sorulanlar

**Aynı coin için sürekli kart gelir mi?** Hayır. Coin şarta girince bir kez gelir. RSI'lardan biri eşiğin
5 puan gerisine dönüp (ör. 80 eşikte 75'in altına) tekrar şarta girerse yeniden gelir. Bu farkı
⚙️ Gelişmiş → Tekrar kart farkı ile değiştirebilirsin.

**Ne kadar hızlı?** Fiyatlar Binance'ten saniyede bir gelir; şart oluştuğu an kart kuyruğa girer. Telegram
grupta dakikada en fazla 20 mesaja izin verir — çok sayıda coin aynı anda şarta girerse kartlar birkaç
saniye arayla sırayla gelir (2 dakikadan uzun bekleyen kartta "gecikmeli" yazar, 20 dakikadan eskisi gönderilmez).

**RSI değerleri CoinGlass / TradingView ile aynı mı?** Hesap yöntemi aynıdır (RSI 14, Wilder, açık mum dahil).
Fiyat saniyede bir güncellendiği için ondalıkta küçük fark olabilir.

**Funding ne gösteriyor?** Binance'in o anki funding oranı ve bir sonraki funding zamanı (artı = longlar öder).

**Hisse senedi kontratları (SOXS, TSLA vb.) neden yok?** Bilerek çıkarıldı; yalnız kripto coinler izlenir.

**Bot çalışıyor mu?** `/durum` — izlenen coin sayısı, veri kaynağı (✅ WebSocket ya da ⚠️ REST yedeği) ve son güncelleme.

> Bot bilgi amaçlıdır; yatırım tavsiyesi değildir.
