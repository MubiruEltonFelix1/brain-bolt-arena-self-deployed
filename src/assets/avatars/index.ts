// Static avatar catalog. Assets are bundled with the application: importing the
// .webp files directly lets Vite emit them as versioned static assets, so the
// URLs work on any self-hosted origin (no dependency on the Lovable __l5e
// asset proxy that only existed on the old hosted deployment).
import owl from "./owl.webp";
import panther from "./panther.webp";
import phoenix from "./phoenix.webp";
import rhino from "./rhino.webp";
import fox from "./fox.webp";
import octopus from "./octopus.webp";
import panda from "./panda.webp";
import robot from "./robot.webp";
import wolf from "./wolf.webp";
import falcon from "./falcon.webp";

export type Avatar = { id: string; name: string; url: string };

export const AVATARS: Avatar[] = [
  { id: "owl", name: "Owl", url: owl },
  { id: "panther", name: "Panther", url: panther },
  { id: "phoenix", name: "Phoenix", url: phoenix },
  { id: "rhino", name: "Rhino", url: rhino },
  { id: "fox", name: "Fox", url: fox },
  { id: "octopus", name: "Octopus", url: octopus },
  { id: "panda", name: "Panda", url: panda },
  { id: "robot", name: "Robot", url: robot },
  { id: "wolf", name: "Wolf", url: wolf },
  { id: "falcon", name: "Falcon", url: falcon },
];

export const AVATARS_BY_ID: Record<string, Avatar> = Object.fromEntries(
  AVATARS.map((a) => [a.id, a]),
);
