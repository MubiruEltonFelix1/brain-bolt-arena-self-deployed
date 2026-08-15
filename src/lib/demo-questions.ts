// Static, self-contained dataset for the Training Arena demo.
// No backend, no persistence — edit freely to change the demo experience.

export type DemoQuestion =
  | {
      type: "mcq";
      prompt: string;
      choices: string[];
      correctIndex: number;
      timeLimitMs?: number;
      doublePoints?: boolean;
    }
  | {
      type: "true_false";
      prompt: string;
      correct: boolean;
      timeLimitMs?: number;
      doublePoints?: boolean;
    }
  | {
      type: "image_reveal";
      prompt: string;
      imageUrl: string;
      choices: string[];
      correctIndex: number;
      revealStages?: number;
      timeLimitMs?: number;
      doublePoints?: boolean;
    }
  | {
      type: "audio";
      prompt: string;
      audioUrl: string;
      choices: string[];
      correctIndex: number;
      timeLimitMs?: number;
      doublePoints?: boolean;
    }
  | {
      type: "ordering";
      prompt: string;
      items: string[]; // in correct order
      timeLimitMs?: number;
      doublePoints?: boolean;
    }
  | {
      type: "map_pin";
      prompt: string;
      correct: { lat: number; lng: number };
      toleranceKm?: number;
      timeLimitMs?: number;
      doublePoints?: boolean;
    }
  | {
      type: "number";
      prompt: string;
      min: number;
      max: number;
      correct: number;
      unit?: string;
      tolerance?: number;
      timeLimitMs?: number;
      doublePoints?: boolean;
    };

export const DEMO_QUESTIONS: DemoQuestion[] = [
  {
    type: "mcq",
    prompt: "Which planet is known as the Red Planet?",
    choices: ["Venus", "Mars", "Jupiter", "Mercury"],
    correctIndex: 1,
    timeLimitMs: 15000,
  },
  {
    type: "true_false",
    prompt: "The Great Wall of China is visible from space with the naked eye.",
    correct: false,
    timeLimitMs: 12000,
  },
  {
    type: "image_reveal",
    prompt: "Identify this landmark",
    imageUrl:
      "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=1200&q=80",
    choices: ["Big Ben", "Eiffel Tower", "Colosseum", "Statue of Liberty"],
    correctIndex: 1,
    revealStages: 5,
    timeLimitMs: 15000,
  },
  {
    type: "audio",
    prompt: "What instrument is featured in this clip?",
    audioUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    choices: ["Piano", "Electric Guitar", "Violin", "Saxophone"],
    correctIndex: 1,
    timeLimitMs: 15000,
  },
  {
    type: "ordering",
    prompt: "Arrange these planets from closest to the Sun to farthest",
    items: ["Mercury", "Venus", "Earth", "Mars"],
    timeLimitMs: 20000,
  },
  {
    type: "map_pin",
    prompt: "Drop a pin on Tokyo, Japan",
    correct: { lat: 35.6762, lng: 139.6503 },
    toleranceKm: 400,
    timeLimitMs: 20000,
    doublePoints: true,
  },
  {
    type: "number",
    prompt: "In what year did humans first land on the Moon?",
    min: 1900,
    max: 2000,
    correct: 1969,
    tolerance: 3,
    timeLimitMs: 15000,
  },
  {
    type: "mcq",
    prompt: "Which programming language shares its name with a snake?",
    choices: ["Cobra", "Python", "Viper", "Anaconda"],
    correctIndex: 1,
    timeLimitMs: 12000,
  },
];

// Geo distance lives in the shared question registry.
export { haversineKm } from "./question-registry";
