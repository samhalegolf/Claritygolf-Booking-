import { readFile } from "node:fs/promises";
console.log(await readFile("package.json", "utf8"));
