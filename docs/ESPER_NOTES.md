# Note di ricostruzione — la scena Esper

Fonte: *Blade Runner* (1982), sequenza dell'appartamento di Deckard, ~1:05–1:45.
I fotogrammi sono stati estratti dal video pubblico e analizzati; **non sono
conservati nel progetto** (materiale del film, resta sul tubo catodico).

## Cosa si vede sullo schermo

* **Fosforo ciano**, non verde: linee e testo fra `#8fdfe8` e `#d9fcff` su nero
  quasi assoluto. La dominante verde che si ricorda è un riflesso della stanza.
* **Cinque zone**: barra di stato in alto (coordinate), colonna numerica stretta
  a sinistra, colonna dati più larga a destra, area centrale con la fotografia,
  barra inferiore con la scala.
* **Griglia sottile** sovrapposta all'immagine, con bracket a "L" sul soggetto.
* **Tipografia monospaziata**, molto piccola, con qualche glifo che si perde nel
  rumore del segnale.
* In basso a sinistra compare una riga di stato del tipo `ZH 0800 76 00 76 0`.
* In basso, la scala numerica: `74 000  75 000  76 000`.
* La macchina ha una **trackball** fisica sulla consolle, grande quanto un pugno.

## I comandi, come li pronuncia Deckard

Dalla sceneggiatura e dal film:

```
Enhance 224 to 176.
Enhance.  Stop.
Move in.  Stop.
Pull out, track right.  Stop.
Center and pull back.  Stop.
Track 45 right.  Stop.
Center.
Enhance 34 to 36.
Enhance 34 to 46.
Enhance 57 to 19.
Track 45 left.  Stop.
Enhance 15 to 23.
Give me a hard copy right there.
```

Nel film i numeri sono volutamente opachi: un misto di coordinate, fotogrammi e
zoom. Qui è stata presa una decisione coerente e dichiarata: **sono pixel
dell'immagine originale**, letti sulla stessa scala della barra in basso.

## Scelte di ricostruzione

| Elemento del film | Qui | Perché |
|---|---|---|
| Ingrandimento infinito | max 16× (2 passate x4) | oltre è invenzione, non restauro |
| Numeri 4 cifre | pixel reali, `0000`–larghezza | così un comando ha un effetto misurabile |
| Trackball fisica | trackball virtuale trascinabile | stesso gesto, stesso pan |
| "Hard copy" | PNG con cornice e metadati | la stampa che Deckard strappa dalla macchina |
| Voce | Web Speech API + pulsanti | il film è del 1982: il microfono è un optional |

## Dettaglio del caso 01

La targa incisa (`ZHORA — NEXUS 6`) è nella fascia bianca del cartello luminoso,
intorno a **x 340–480, y 126**, scritta a 8 px e sfumata di 0,45 px: a occhio nudo
è una riga di stampa consumata. A 4–6× con Real-ESRGAN diventa leggibile.

È anche la dimostrazione del limite: a 8× la rete ha già cominciato a
"interpretare" le lettere. La verità è nei pixel che c'erano, non in quelli che
vorremmo ci fossero.
