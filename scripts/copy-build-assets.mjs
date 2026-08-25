import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const rootAssets = [
  "iii-config.yaml",
  "iii-config.docker.yaml",
  "docker-compose.yml",
  ".env.example",
];

mkdirSync("dist", { recursive: true });
for (const asset of rootAssets) {
  copyFileSync(asset, join("dist", asset));
}

mkdirSync(join("dist", "viewer"), { recursive: true });
for (const asset of ["index.html", "favicon.svg"]) {
  copyFileSync(join("src", "viewer", asset), join("dist", "viewer", asset));
}
