// Every Open Bot Avatar: the 7 built into the package plus the 15 from its gallery,
// each with its default color. Source: github.com/DominikScholz/open-bot-avatar (MIT), gallery at b59a73a.

import { getExample, type AvatarDefinition } from "open-bot-avatar";
import colors from "./gallery/colors.json";
import book from "./gallery/book.json";
import brain from "./gallery/brain.json";
import bull from "./gallery/bull.json";
import bunny from "./gallery/bunny.json";
import camera from "./gallery/camera.json";
import cat from "./gallery/cat.json";
import cloud from "./gallery/cloud.json";
import ghost from "./gallery/ghost.json";
import magnifier from "./gallery/magnifier.json";
import paint_brush from "./gallery/paint-brush.json";
import palette from "./gallery/palette.json";
import rocket from "./gallery/rocket.json";
import shield from "./gallery/shield.json";
import star from "./gallery/star.json";
import witch_hat from "./gallery/witch-hat.json";
// Peeblo's own character: the peeblo.xyz mark redrawn as an Open Bot Avatar definition.
import peeblo from "./peeblo.json";

export type BotAvatar = { id: string; color: string; definition: AvatarDefinition };

const BUILT_IN = ["controller", "barbell", "mug", "lightbulb", "chat", "sprout", "watering-can"] as const;
const GALLERY = [book, brain, bull, bunny, camera, cat, cloud, ghost, magnifier, paint_brush, palette, rocket, shield, star, witch_hat] as AvatarDefinition[];

export const avatars: BotAvatar[] = [
  { id: "peeblo", color: "#b6dfc5", definition: peeblo as AvatarDefinition },
  ...BUILT_IN.map((id) => ({ id, color: (colors as Record<string, string>)[id], definition: getExample(id)! })),
  ...GALLERY.map((definition) => ({ id: definition.id, color: (colors as Record<string, string>)[definition.id], definition })),
];

export const avatarById = (id: string) => avatars.find((a) => a.id === id);
