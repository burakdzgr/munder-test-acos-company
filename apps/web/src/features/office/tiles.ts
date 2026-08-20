// Pixel-art döşeme kütüphanesi (36 §3 "hand-authored pixel tiles"; 23 §5).
//
// Neden ASCII: ofis eskiden `Graphics.rect` çağrılarıyla çiziliyordu ve sonuç
// piksel sanatı DEĞİL, düz dikdörtgenlerdi — ne kenar ışığı, ne gölge, ne
// doku. Piksel sanatının tanımı, her pikselin bilerek konmuş olması; kod
// içinde bunu okunur tutmanın yolu da resmi harf haritası olarak yazmak.
// Her harf bir palet girdisi, her satır bir piksel sırası.
//
// Burada Pixi YOK — ofis lint kuralı render API'lerini köprüye (OfficeCanvas)
// ayırıyor. Bu dosya saf veridir: harf haritaları + paletler + üreteçler.
// Köprü bunları bir kez dokuya pişirir (nearest-neighbor ölçekleme) ve
// sprite olarak yerleştirir; kare başına iş yoktur.

/** Bir çizim: satırlar + harf→renk paleti. Nokta = saydam. */
export interface PixelArt {
  rows: string[];
  palette: Record<string, number>;
}

// ---------------------------------------------------------------- masa

/**
 * Masa: monitör + klavye + sandalye, tepeden görünüm.
 * 32×24 piksel → 2 ekran pikseli/sanat pikseli ile 2 hücre genişlik.
 */
export const DESK_ART: PixelArt = {
  palette: {
    D: 0x6b5138, // masa ahşabı
    d: 0x46331f, // ön kenar gölgesi
    L: 0x8a6a48, // arka kenar ışığı
    // Monitör çerçevesi bilerek AÇIK: ilk denemede 0x1b2029 idi ve oda
    // zemini de koyu olduğu için ekranda hiç görünmüyordu — masada yalnız
    // ahşap bar duruyor, monitör yok sanılıyordu.
    B: 0x39424f, // monitör çerçevesi
    S: 0x11161d, // ekran (canlı durum rengi bunun üstüne biner)
    s: 0x2e7d9a, // ekran parıltısı
    K: 0x2b3440, // klavye gövdesi
    k: 0x3d4753, // tuşlar
    C: 0x39424f, // sandalye
    c: 0x252c36, // sandalye gölgesi
  },
  rows: [
    "................................",
    "................................",
    ".........LLLLLLLLLLLLLL.........",
    ".........BSSSSSSSSSSSSB.........",
    ".........BSssssssssssSB.........",
    ".........BSSSSSSSSSSSSB.........",
    ".........BSssssssssssSB.........",
    ".........BBBBBBBBBBBBBB.........",
    ".............BdddddB............",
    ".............BdddddB............",
    "..LLLLLLLLLLLLLLLLLLLLLLLLLLLL..",
    "..DDDDDDDDDDDDDDDDDDDDDDDDDDDD..",
    "..DDDDDDDDDDDDDDDDDDDDDDDDDDDD..",
    "..DDDDDDDDKKKKKKKKKKKKDDDDDDDD..",
    "..DDDDDDDDKkkkkkkkkkkKDDDDDDDD..",
    "..DDDDDDDDKKKKKKKKKKKKDDDDDDDD..",
    "..DDDDDDDDDDDDDDDDDDDDDDDDDDDD..",
    "..dddddddddddddddddddddddddddd..",
    "................................",
    "...........CCCCCCCCCC...........",
    "..........CCCCCCCCCCCC..........",
    "..........CccccccccccC..........",
    "..........CCCCCCCCCCCC..........",
    "...........cccccccccc...........",
  ],
};

// ---------------------------------------------------------------- kitaplık

/** Kitaplık: ahşap gövde + renkli kitap sırtları (16×24). */
export const BOOKSHELF_ART: PixelArt = {
  palette: {
    W: 0x6b5138, // ahşap gövde
    w: 0x46331f, // gölge
    L: 0x8a6a48, // üst ışık
    r: 0xc4574e, // kitaplar
    b: 0x4c7fb5,
    g: 0x5da05f,
    y: 0xd9a441,
    p: 0x9a6bb5,
  },
  rows: [
    "LLLLLLLLLLLLLLLL",
    "WwwwwwwwwwwwwwwW",
    "WrrbbyygggrrbbpW",
    "WrrbbyygggrrbbpW",
    "WrrbbyygggrrbbpW",
    "WwwwwwwwwwwwwwwW",
    "WyyppbbrrggyybbW",
    "WyyppbbrrggyybbW",
    "WyyppbbrrggyybbW",
    "WwwwwwwwwwwwwwwW",
    "WggrryyppbbggrrW",
    "WggrryyppbbggrrW",
    "WggrryyppbbggrrW",
    "WwwwwwwwwwwwwwwW",
    "WbbggrrppyybbppW",
    "WbbggrrppyybbppW",
    "WbbggrrppyybbppW",
    "WwwwwwwwwwwwwwwW",
    "WWWWWWWWWWWWWWWW",
    "wwwwwwwwwwwwwwww",
    "................",
    "................",
    "................",
    "................",
  ],
};

// ---------------------------------------------------------------- su sebili

export const WATERCOOLER_ART: PixelArt = {
  palette: {
    B: 0x5aa7d6, // su şişesi
    b: 0x3f7ba3, // şişe gölgesi
    W: 0xc9cfd8, // gövde
    w: 0x9aa1ad, // gövde gölgesi
    m: 0x6f7684, // taban
  },
  rows: [
    "................",
    ".....BBBBBB.....",
    "....BBBBBBBb....",
    "....BBBBBBBb....",
    "....bBBBBBbb....",
    ".....bbbbbb.....",
    "....WWWWWWWW....",
    "....WWWWWWWw....",
    "....WWWWWWWw....",
    "....WwwwwwWw....",
    "....WWWWWWWw....",
    "....WWWWWWWw....",
    "....mmmmmmmm....",
    "................",
    "................",
    "................",
  ],
};

// ---------------------------------------------------------------- dosya dolabı

export const CABINET_ART: PixelArt = {
  palette: {
    M: 0x7d8492, // gövde
    m: 0x565d6b, // gölge
    E: 0x9aa1ae, // çekmece yüzü
    h: 0x3a414d, // kulp
  },
  rows: [
    "mmmmmmmmmmmmmm..",
    "mMMMMMMMMMMMMm..",
    "mMEEEEEEEEEEMm..",
    "mMEEEEhhEEEEMm..",
    "mMEEEEEEEEEEMm..",
    "mMMMMMMMMMMMMm..",
    "mMEEEEEEEEEEMm..",
    "mMEEEEhhEEEEMm..",
    "mMEEEEEEEEEEMm..",
    "mMMMMMMMMMMMMm..",
    "mMEEEEEEEEEEMm..",
    "mMEEEEhhEEEEMm..",
    "mMEEEEEEEEEEMm..",
    "mMMMMMMMMMMMMm..",
    "mmmmmmmmmmmmmm..",
    "................",
  ],
};

// ---------------------------------------------------------------- beyaz tahta

/** Beyaz tahta: oda içine, üst duvara asılır (24×12). */
export const WHITEBOARD_ART: PixelArt = {
  palette: {
    F: 0x565d6b, // çerçeve
    W: 0xe8ecf2, // yüzey
    r: 0xc4574e, // yazılar
    b: 0x4c7fb5,
    g: 0x5da05f,
  },
  rows: [
    "FFFFFFFFFFFFFFFFFFFFFFFF",
    "FWWWWWWWWWWWWWWWWWWWWWWF",
    "FWrrrWWWbbbbWWWWggWWWWWF",
    "FWWWWWWWWWWWWWWWWWWWWWWF",
    "FWbbWWrrrrWWWWbbbWWWggWF",
    "FWWWWWWWWWWWWWWWWWWWWWWF",
    "FWggggWWWWrrWWWWWbbbbWWF",
    "FWWWWWWWWWWWWWWWWWWWWWWF",
    "FFFFFFFFFFFFFFFFFFFFFFFF",
    "........................",
    "........................",
    "........................",
  ],
};

// ---------------------------------------------------------------- halı

/** Lobi halısı: bordürlü düz dokuma (32×20). */
export const RUG_ART: PixelArt = {
  palette: {
    B: 0x6d4a52, // bordür
    b: 0x593c43, // bordür gölge
    C: 0x8a5f68, // zemin
    c: 0x7d545d, // desen
  },
  rows: [
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "BbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB",
    "BbCCCCCCCCCCCCCCCCCCCCCCCCCCCCbB",
    "BbCcCCcCCCCcCCCCcCCCCcCCCCcCCCbB",
    "BbCCCCCCCCCCCCCCCCCCCCCCCCCCCCbB",
    "BbCCCcCCCCcCCCCcCCCCcCCCCcCCCCbB",
    "BbCCCCCCCCCCCCCCCCCCCCCCCCCCCCbB",
    "BbCcCCcCCCCcCCCCcCCCCcCCCCcCCCbB",
    "BbCCCCCCCCCCCCCCCCCCCCCCCCCCCCbB",
    "BbCCCcCCCCcCCCCcCCCCcCCCCcCCCCbB",
    "BbCCCCCCCCCCCCCCCCCCCCCCCCCCCCbB",
    "BbCcCCcCCCCcCCCCcCCCCcCCCCcCCCbB",
    "BbCCCCCCCCCCCCCCCCCCCCCCCCCCCCbB",
    "BbCCCcCCCCcCCCCcCCCCcCCCCcCCCCbB",
    "BbCCCCCCCCCCCCCCCCCCCCCCCCCCCCbB",
    "BbCcCCcCCCCcCCCCcCCCCcCCCCcCCCbB",
    "BbCCCCCCCCCCCCCCCCCCCCCCCCCCCCbB",
    "BbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB",
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "................................",
  ],
};

// ---------------------------------------------------------------- kanepe

/** Lobi kanepesi (24×14). */
export const SOFA_ART: PixelArt = {
  palette: {
    S: 0x4c7fb5, // döşeme
    s: 0x3a6390, // gölge
    L: 0x5e91c7, // ışık
    F: 0x2b3440, // ayak
  },
  rows: [
    "........................",
    ".LLLLLLLLLLLLLLLLLLLLLL.",
    ".LSSSSSSSSSSSSSSSSSSSSs.",
    ".LSSSSSSSSSSSSSSSSSSSSs.",
    ".LSSLLLLLLLLLLLLLLLLSSs.",
    ".LSSSSSSSSSSSSSSSSSSSSs.",
    ".LSSSSSSSSSSSSSSSSSSSSs.",
    ".LSSSSSSSSSSSSSSSSSSSSs.",
    ".ssssssssssssssssssssss.",
    "..FF................FF..",
    "........................",
    "........................",
    "........................",
    "........................",
  ],
};

// ---------------------------------------------------------------- saksı

export const PLANT_ART: PixelArt = {
  palette: {
    G: 0x2f7d4a,
    g: 0x46a862,
    h: 0x1f5c34,
    P: 0x6b4a2e,
    p: 0x46321e,
  },
  rows: [
    "................",
    ".....gg..gg.....",
    "....gGGggGGg....",
    "...gGGGGGGGGg...",
    "..gGGGhhhhGGGg..",
    "..GGGhGGGGhGGG..",
    "..GGGGGGGGGGGG..",
    "...GGGhhhhGGG...",
    "....GGGGGGGG....",
    ".....GGGGGG.....",
    "......GGGG......",
    "......hGGh......",
    ".....PPPPPP.....",
    ".....PPPPPP.....",
    "......pppp......",
    "................",
  ],
};

// ---------------------------------------------------------------- sunucu dolabı

export const RACK_ART: PixelArt = {
  palette: {
    M: 0x232a34, // gövde
    m: 0x161b22, // gölge
    E: 0x39424f, // raf
    a: 0x3fd0a0, // yeşil LED
    b: 0xffcb47, // sarı LED
  },
  rows: [
    "mmmmmmmmmmmmmmmm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEabMm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEbaMm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEabMm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEaaMm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEbbMm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEabMm",
    "mMMMMMMMMMMMMMMm",
    "mMMMMMMMMMMMMMMm",
    "mmmmmmmmmmmmmmmm",
  ],
};

// ---------------------------------------------------------------- kahve makinesi

export const COFFEE_ART: PixelArt = {
  palette: {
    M: 0x2b323c,
    m: 0x1a1f26,
    W: 0x3a2c22, // hazne
    o: 0xff6b8a, // güç ışığı
    S: 0x4a5462,
  },
  rows: [
    "................",
    "...mmmmmmmmmm...",
    "...mMMMMMMMMm...",
    "...mMWWWWWWMm...",
    "...mMWWWWWWMm...",
    "...mMMMMMMMMm...",
    "...mMSSSSSSMm...",
    "...mMMMMMMoMm...",
    "...mMMMMMMMMm...",
    "...mMSSSSSSMm...",
    "...mMMMMMMMMm...",
    "...mmmmmmmmmm...",
    "................",
    "................",
    "................",
    "................",
  ],
};

// ------------------------------------------------- üreteçler (döşeme desenleri)

/** Deterministik 0..1 — döşeme dokusu her yenilemede aynı olmalı. */
function noise(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 8) / 0xffffff;
}

/**
 * Zemin karosu: DAMALI (2026-08-18 sanat turu, AGENTDESK referansı).
 *
 * Eski tek-ton koyu zemin "renkli dikdörtgen" okunuyordu; damalı iki ton +
 * serpinti hem karo yapısını uzaktan gösteriyor hem piksel sanatı hissini
 * veriyor. 8×8'lik iki karo bir 16×16 döşemede dört kadran oluşturur.
 */
export function floorTileArt(base: number, seed: number): PixelArt {
  const rows: string[] = [];
  for (let y = 0; y < 16; y += 1) {
    let row = "";
    for (let x = 0; x < 16; x += 1) {
      const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const grout = x % 8 === 0 || y % 8 === 0;
      const n = noise(x, y, seed);
      row += grout ? "g" : n > 0.95 ? "l" : n < 0.05 ? "d" : checker ? "a" : "b";
    }
    rows.push(row);
  }
  return {
    rows,
    palette: {
      a: base,
      b: shiftColor(base, -8),
      l: shiftColor(base, 12),
      d: shiftColor(base, -14),
      g: shiftColor(base, -22),
    },
  };
}

/** Duvar yüzü: açık üst kapak + panelli yüz + süpürgelik (sözde-3B). */
export function wallFaceArt(): PixelArt {
  const rows: string[] = [];
  for (let y = 0; y < 16; y += 1) {
    let row = "";
    for (let x = 0; x < 16; x += 1) {
      if (y < 3) row += "t"; // üst kapak (ışık alan yüz)
      else if (y === 3) row += "e"; // kapak altı keskin gölge
      else if (y >= 14) row += "k"; // süpürgelik
      else if (x % 8 === 0) row += "s"; // panel derzi
      else row += noise(x, y, 7) > 0.92 ? "h" : "f";
    }
    rows.push(row);
  }
  return {
    rows,
    palette: {
      t: 0x5a677c,
      e: 0x1c232d,
      f: 0x323c4a,
      s: 0x293240,
      h: 0x3d4959,
      k: 0x212934,
    },
  };
}

/** Koridor/lobi zemini — AGENTDESK dili: aydınlık gri damalı karo. */
export function corridorTileArt(): PixelArt {
  return floorTileArt(0x8d94a1, 3);
}

/** Toplantı odası zemini: yatay ahşap tahta dokusu. */
export function woodPlankArt(): PixelArt {
  const rows: string[] = [];
  for (let y = 0; y < 16; y += 1) {
    let row = "";
    for (let x = 0; x < 16; x += 1) {
      if (y % 4 === 3) row += "s"; // tahta derzi
      else if (noise(x, y, 11) > 0.93) row += "l"; // damar ışığı
      else if (noise(x + 31, y, 11) < 0.06) row += "d"; // budak
      else row += "b";
    }
    rows.push(row);
  }
  return {
    rows,
    palette: { b: 0x7a5a3d, l: 0x8d6b4a, d: 0x64482f, s: 0x543c27 },
  };
}

/**
 * Toplantı masası (FAZ 2B): 5 hücre × 2 hücre, tepeden görünüm.
 *
 * Munder'ın boardroom'unda büyük bir masa var; onun KOMPOZİSYONUNU alıyoruz
 * ama pikselleri kendimizin (LimeZu varlıkları ticari kullanıma kapalı).
 * Prosedürel üretiliyor çünkü 80×32 piksellik bir harf haritasını elle
 * yazmak okunur değil — zemin/duvar döşemeleri de aynı şekilde üretiliyor.
 */
export function meetingTableArt(): PixelArt {
  const w = 80; // 5 hücre × 16 sanat pikseli
  const h = 32; // 2 hücre
  const rows: string[] = [];
  for (let y = 0; y < h; y += 1) {
    let row = "";
    for (let x = 0; x < w; x += 1) {
      const edge = x < 2 || x >= w - 2 || y < 4 || y >= h - 4;
      const chairTop = y < 4 && x % 16 >= 4 && x % 16 < 12;
      const chairBottom = y >= h - 4 && x % 16 >= 4 && x % 16 < 12;
      if (chairTop || chairBottom) row += "c";
      else if (y < 4 || y >= h - 4) row += ".";
      else if (edge) row += "e";
      else if (y === 5) row += "l"; // üst kenar ışığı
      else if (y === h - 6) row += "d"; // alt kenar gölgesi
      else if (noise(x, y, 17) > 0.94) row += "g"; // ahşap damarı
      else row += "t";
    }
    rows.push(row);
  }
  return {
    rows,
    palette: {
      t: 0x5a4331, // masa yüzeyi
      g: 0x6a5140, // damar
      l: 0x74583f, // üst kenar ışığı
      d: 0x3f2f22, // alt kenar gölgesi
      e: 0x4a3728, // kenar profili
      c: 0x2b3440, // sandalye sırtı
    },
  };
}

/** Kafeterya zemini: sıcak tonlu karo. */
export function cafeTileArt(): PixelArt {
  return floorTileArt(0x9a8570, 7);
}

/** #rrggbb tamsayısını kanal başına kaydırır (döşeme tonlaması). */
export function shiftColor(color: number, delta: number): number {
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = clamp(((color >> 16) & 255) + delta);
  const g = clamp(((color >> 8) & 255) + delta);
  const b = clamp((color & 255) + delta);
  return (r << 16) | (g << 8) | b;
}

/**
 * Bir çizimi dikdörtgen çağrılarına açar.
 *
 * Aynı renkteki YATAY komşu pikselleri tek dikdörtgende birleştirir: masa
 * çizimi 768 piksel, birleştirilince ~90 dikdörtgen. Bu olmadan 40 masalık
 * bir ofis on binlerce çağrı ederdi — dokuya pişirilse bile pişirme anı
 * gözle görülür şekilde takılırdı.
 */
export function emitArt(
  art: PixelArt,
  pixel: number,
  draw: (x: number, y: number, w: number, h: number, color: number) => void,
): void {
  art.rows.forEach((row, y) => {
    let runStart = -1;
    let runChar = ".";
    const flush = (end: number) => {
      if (runStart < 0 || runChar === ".") return;
      const color = art.palette[runChar];
      if (color !== undefined) {
        draw(runStart * pixel, y * pixel, (end - runStart) * pixel, pixel, color);
      }
    };
    for (let x = 0; x < row.length; x += 1) {
      const char = row[x]!;
      if (char !== runChar) {
        flush(x);
        runStart = x;
        runChar = char;
      }
    }
    flush(row.length);
  });
}

/** Çizimin ekran boyutu (piksel katsayısı uygulanmış). */
export function artSize(art: PixelArt, pixel: number): { w: number; h: number } {
  return { w: (art.rows[0]?.length ?? 0) * pixel, h: art.rows.length * pixel };
}
