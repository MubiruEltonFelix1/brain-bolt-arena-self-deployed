// Static avatar catalog. Selection logic will be added later.
import owl from "./owl.webp.asset.json";
import panther from "./panther.webp.asset.json";
import phoenix from "./phoenix.webp.asset.json";
import rhino from "./rhino.webp.asset.json";
import fox from "./fox.webp.asset.json";
import octopus from "./octopus.webp.asset.json";
import panda from "./panda.webp.asset.json";
import robot from "./robot.webp.asset.json";
import wolf from "./wolf.webp.asset.json";
import falcon from "./falcon.webp.asset.json";

export type Avatar = { id: string; name: string; url: string };

export const AVATARS: Avatar[] = [
  { id: "owl", name: "Owl", url: owl.url },
  { id: "panther", name: "Panther", url: panther.url },
  { id: "phoenix", name: "Phoenix", url: phoenix.url },
  { id: "rhino", name: "Rhino", url: rhino.url },
  { id: "fox", name: "Fox", url: fox.url },
  { id: "octopus", name: "Octopus", url: octopus.url },
  { id: "panda", name: "Panda", url: panda.url },
  { id: "robot", name: "Robot", url: robot.url },
  { id: "wolf", name: "Wolf", url: wolf.url },
  { id: "falcon", name: "Falcon", url: falcon.url },
];

export const AVATARS_BY_ID: Record<string, Avatar> = Object.fromEntries(
  AVATARS.map((a) => [a.id, a]),
);
