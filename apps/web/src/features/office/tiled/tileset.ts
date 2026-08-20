// FAZ 2B / 2B-2 — döşeme anahtarı → KENDİ piksel sanatımız.
//
// Haritadaki her gid bir `key` taşır (office.tmj içine gömülü döşeme seti) ve
// o anahtar burada tiles.ts'teki sanata bağlanır. Repoda hiçbir LimeZu/Munder
// atlası YOK: kompozisyon Munder'ın, pikseller bizim (lisans kararı,
// FAZ 2B sözleşmesi §1).
//
// Saf veri: Pixi yok. Köprü bu sanatı bir kez dokuya pişirir.
import { DEFAULT_THEME, type OfficeTheme } from "./theme.js";
import {
  BOOKSHELF_ART,
  CABINET_ART,
  COFFEE_ART,
  DESK_ART,
  PLANT_ART,
  RACK_ART,
  RUG_ART,
  SOFA_ART,
  WATERCOOLER_ART,
  WHITEBOARD_ART,
  floorTileArt,
  meetingTableArt,
  wallFaceArt,
  woodPlankArt,
  type PixelArt,
} from "../tiles.js";

export interface TileArtSpec {
  art: PixelArt;
  /** true = zemin/duvar gibi hücreyi TAM dolduran döşeme (tekrarlanabilir) */
  terrain: boolean;
}

/**
 * Anahtar → sanat. Harita yeni bir anahtar kullanırsa burada karşılığı olmalı.
 * Tema yalnız ZEMİN TONLARINI değiştirir; oda/masa düzeni her temada aynıdır
 * (insan "tam Munder katı" istedi — kompozisyon sabit).
 */
export function tileArt(theme: OfficeTheme = DEFAULT_THEME): Record<string, TileArtSpec> {
  return {
    // Açık ofis zemini AYDINLIK: duvarlar (0x32..0x5a bandı) koyu, zemin
    // onlardan belirgin biçimde açık olmalı — ilk turda ikisi de koyu
    // griydi ve ekran görüntüsünde duvar/zemin ayırt edilemiyordu.
    "floor-open": { art: floorTileArt(theme.floorOpen, 1), terrain: true },
    "floor-corridor": { art: floorTileArt(theme.floorCorridor, 3), terrain: true },
    "floor-wood": { art: woodPlankArt(theme.floorWood), terrain: true },
    "floor-cafe": { art: floorTileArt(theme.floorCafe, 7), terrain: true },
    wall: { art: wallFaceArt(), terrain: true },
    desk: { art: DESK_ART, terrain: false },
    table: { art: meetingTableArt(), terrain: false },
    plant: { art: PLANT_ART, terrain: false },
    coffee: { art: COFFEE_ART, terrain: false },
    rack: { art: RACK_ART, terrain: false },
    whiteboard: { art: WHITEBOARD_ART, terrain: false },
    sofa: { art: SOFA_ART, terrain: false },
    bookshelf: { art: BOOKSHELF_ART, terrain: false },
    cabinet: { art: CABINET_ART, terrain: false },
    watercooler: { art: WATERCOOLER_ART, terrain: false },
    rug: { art: RUG_ART, terrain: false },
  };
}
