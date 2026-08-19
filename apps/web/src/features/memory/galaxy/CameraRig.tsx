// CameraRig — tıkla→düğüme uç, boşluğa tıkla→galaksiye dön.
//
// Kamera konumu her karede hedefe LERP edilir; anlık atlama yerine yumuşak
// yaklaşma "uçuş" hissini verir. OrbitControls'ün hedefi de aynı anda
// taşınır, yoksa kullanıcı döndürmeye başladığında kamera eski merkez
// etrafında dönerdi.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { FIELD_RADIUS, type GalaxyNode } from "./layout.js";

/**
 * OrbitControls'ün BU dosyanın ihtiyaç duyduğu yüzeyi. Tam tipi `three-stdlib`
 * içinde ve o paket drei'nin iç bağımlılığı — doğrudan import etmek, bizim
 * seçmediğimiz bir sürüme bağlanmak olurdu. Kullandığımız kadarını yazıyoruz.
 */
export interface OrbitLike {
  target: THREE.Vector3;
  update(): void;
}

/**
 * Açılış BAKIŞ YÖNÜ (birim vektör değil, yalnız yön taşır).
 *
 * Uzaklık burada sabitlenemez: aynı sahne hem 1100px genişliğindeki Gözlemevi
 * sayfasında hem ~260px'lik Command Center panelinde çiziliyor. Sabit uzaklık
 * (44 birim) sayfada doğru, panelde felaketti — kamera fov'u DİKEY olduğu
 * için dar bir kutuda yatay görüş açısı çok daha küçük kalıyor ve küre
 * kadrajın iki yanından taşıyordu. Uzaklık `homeDistance()` ile en-boy
 * oranından hesaplanıyor.
 */
const HOME_DIRECTION = new THREE.Vector3(0, 0.18, 1).normalize();

/** Küre kadraja otursun diye bırakılan pay. */
const FIT_MARGIN = 1.18;

/**
 * Yarıçapı `FIELD_RADIUS` olan küreyi tam gören uzaklık.
 *
 * Dikey yarı-açı fov/2; yatay yarı-açı `atan(tan(fov/2) · en-boy)`. Küre
 * ikisine de sığmalı, o yüzden DAR olan belirler.
 */
export function homeDistance(fovDegrees: number, aspect: number): number {
  const vertical = (fovDegrees * Math.PI) / 360;
  const horizontal = Math.atan(Math.tan(vertical) * aspect);
  return (FIELD_RADIUS * FIT_MARGIN) / Math.sin(Math.min(vertical, horizontal));
}

/** Geniş ekran varsayımıyla ilk kare için başlangıç konumu. */
export const HOME_POSITION: [number, number, number] = [0, 8, 44];

export function CameraRig({
  target,
  controls,
}: {
  /** Odaklanılacak düğüm; null ⇒ galaksi görünümüne dön. */
  target: GalaxyNode | null;
  controls: React.RefObject<OrbitLike | null>;
}) {
  const { camera, size } = useThree();
  const desiredPosition = useRef(new THREE.Vector3(...HOME_POSITION));
  const desiredTarget = useRef(new THREE.Vector3(0, 0, 0));
  const aspect = size.height > 0 ? size.width / size.height : 1;

  useEffect(() => {
    if (!target) {
      // panel dar, sayfa geniş → uzaklık her ikisinde de yeniden hesaplanır
      const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 55;
      desiredPosition.current.copy(HOME_DIRECTION).multiplyScalar(homeDistance(fov, aspect));
      desiredTarget.current.set(0, 0, 0);
      return;
    }
    const [x, y, z] = target.position;
    desiredTarget.current.set(x, y, z);
    // düğümün biraz dışında dur: merkezden dışa doğru kaydırılmış bir nokta
    const outward = new THREE.Vector3(x, y, z);
    const distance = outward.length() || 1;
    outward.multiplyScalar((distance + 4.5) / distance);
    desiredPosition.current.set(outward.x, outward.y + 1.5, outward.z);
    // aspect/camera bağımlılıkta: panel yeniden boyutlanınca ev konumu
    // yeniden hesaplanmalı, yoksa kadraj bir önceki genişlikte donup kalır
  }, [target, aspect, camera]);

  useFrame((_state, delta) => {
    // delta'ya bağlı yumuşatma: kare hızından bağımsız aynı his
    const alpha = 1 - Math.exp(-delta * 3.2);
    camera.position.lerp(desiredPosition.current, alpha);
    const orbit = controls.current;
    if (orbit) {
      orbit.target.lerp(desiredTarget.current, alpha);
      orbit.update();
    }
  });

  return null;
}
