import { PredictiveArcCanvas } from "@designcodeio/threeui";
import "@designcodeio/threeui/style.css";
export default function PeebloArcScene() {
  return (
    <PredictiveArcCanvas
      variant="data-pixel"
      mode="dark"
      speed={1.0}
      hue={0}
      saturation={1.0}
      brightness={1.0}
    />
  );
}
