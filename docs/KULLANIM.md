# RSI Botu — Kullanım Kılavuzu

Bot, Binance vadeli kripto coinlerinde **4 saat, 12 saat ve 24 saat RSI aynı anda** belirlediğin eşiği
geçince gruba mesaj atar. Tüm ayarları Telegram'dan sen yönetirsin.

## Mesajlar

**Sinyal (tek coin)**

```
🔴 #XYZUSDT — RSI aşırı alım
4s 84.2 · 12s 82.1 · 1g 80.5
Fiyat: 1.2345 · 24s: +%12.4
⏱ 15.10 14:32
```

Aynı anda birden fazla coin şarta girerse tek mesajda listelenir. 🔴 aşırı alım, 🟢 aşırı satım.

**Liste** — `/liste` yazınca ya da her saat başı (ayarlanabilir): o an şartı sağlayan tüm coinler, en güçlüden.

## Eşikleri değiştirmek

En kolayı: **/ayarlar → 🎯 Eşikler → Üst eşik** → hazır değerlerden birine dokun (70 · 75 · 80 · 85 · 90)
ya da −5 / −1 / +1 / +5 ile ayarla. Alt eşik için aynı (10 · 15 · 20 · 25 · 30).

Komutla da olur:

| İstek | Komut |
|---|---|
| Üst eşiği 85 yap | `/ayar ustEsik 85` |
| Alt eşiği 15 yap | `/ayar altEsik 15` |
| Sadece aşırı alım sinyali al | `/ayar altAktif kapat` |
| 24 saati şarttan çıkar (yalnız 4s + 12s) | `/ayar tf1d kapat` |
| Listeyi 4 saatte bir gönder | `/ayar listeDk 240` |
| Periyodik listeyi kapat | `/ayar listeDk 0` |
| Sinyaller sessiz gelsin | `/ayar sesli kapat` |
| Yalnız hacmi 10M $ üstü coinler | `/ayar minHacimM 10` |
| Her şeyi varsayılana döndür | `/ayar sifirla` |

Değişiklik **anında** geçerli olur ve bot yeniden başlasa da korunur. Değiştirdiğinde bot, yeni ayarla
şu an şartı sağlayan coinleri bir kez listeler (bunlar için ayrıca sinyal gelmez; şarta yeni girenler için gelir).

Ayarları yalnız grup yöneticileri değiştirebilir; herkes görebilir.

## Sık sorulanlar

**Aynı coin için sürekli mesaj gelir mi?** Hayır. Coin şarta girince bir kez gelir. RSI'lardan biri eşiğin
5 puan gerisine dönüp (ör. 80 eşikte 75'in altına) tekrar şarta girerse yeniden gelir. Bu 5 puanı
`/ayar resetPuan` ile değiştirebilirsin.

**RSI değerleri CoinGlass / TradingView ile neden çok küçük farklı olabilir?** Bot anlık fiyatı 15 sn'de bir
alır; o arada fiyat oynarsa ondalıkta fark olabilir. Hesap yöntemi aynıdır (RSI 14, Wilder).

**Hisse senedi kontratları (SOXS, TSLA vb.) neden yok?** Bilerek çıkarıldı; yalnız kripto coinler izlenir.

**Bot çalışıyor mu?** `/durum` — izlenen coin sayısı ve son fiyat güncellemesinin kaç saniye önce olduğu görünür.

> Bot bilgi amaçlıdır; yatırım tavsiyesi değildir.
