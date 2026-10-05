// Builds a release bundle for one of the two Android apps and files it under
// releases/ at the top of the repo, named so it can never be mistaken for the
// other app's or for an earlier build:
//
//   releases/player/clarity-player-0.1.0-1199.aab
//   releases/staff/clarity-booking-0.1.0-1199.aab
//
// Gradle always writes the same file (android/app/build/outputs/bundle/release/
// app-release.aab) for both apps, four folders deep, and overwrites it on the
// next build. That is how a staff bundle ends up uploaded to the Player listing.
//
// Usage, normally via npm:
//
//   npm run native:release:aab        (in source/ or source/booking-app/)
//   npm run native:release:apk
//
// which run `node scripts/native-release.mjs <aab|apk> [appDir]` after the
// version files and `cap sync` are fresh. appDir is relative to source/.
//
// The version and build number are read from android/app/version.properties,
// the file scripts/sync-app-version.mjs wrote and Gradle is about to stamp, so
// the name on disk is exactly what Play will see.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(ROOT, "..");
const RELEASES = path.join(REPO, "releases");

/* Which releases/ folder each app files into, and the name its bundles carry.
   Keyed by the app folder relative to source/. */
const APPS = {
  ".": { folder: "player", slug: "clarity-player", label: "Clarity Player" },
  "booking-app": { folder: "staff", slug: "clarity-booking", label: "Clarity Booking (staff app)" },
};

const KINDS = {
  aab: { task: "bundleRelease", ext: "aab", outputs: ["bundle/release/app-release.aab"] },
  apk: {
    task: "assembleRelease",
    ext: "apk",
    // Gradle names an unsigned APK differently from a signed one.
    outputs: ["apk/release/app-release.apk", "apk/release/app-release-unsigned.apk"],
  },
};

function fail(message) {
  console.error(`\nnative-release: ${message}\n`);
  process.exit(1);
}

const [, , kindArg, appArg = "."] = process.argv;
const kind = KINDS[kindArg];
if (!kind) fail(`first argument must be "aab" or "apk", got "${kindArg ?? ""}".`);

const appKey = path.relative(ROOT, path.resolve(ROOT, appArg)) || ".";
const app = APPS[appKey];
if (!app) fail(`"${appArg}" is not one of the apps this script knows: ${Object.keys(APPS).join(", ")}.`);

const appDir = path.resolve(ROOT, appKey);
const androidDir = path.join(appDir, "android");

/* The numbers Gradle is about to stamp. */
const versionFile = path.join(androidDir, "app/version.properties");
if (!existsSync(versionFile)) {
  fail(`${path.relative(REPO, versionFile)} is missing. Run the npm script rather than this file directly.`);
}
const props = Object.fromEntries(
  readFileSync(versionFile, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("=").map((part) => part.trim())),
);
const version = props.VERSION_NAME;
const build = props.VERSION_CODE;
if (!version || !/^\d+$/.test(build ?? "")) fail(`${path.relative(REPO, versionFile)} is incomplete.`);

/* Signed or not, the same way android/app/build.gradle decides: a
   keystore.properties in android/, or the four ANDROID_KEYSTORE_* variables.
   An unsigned bundle is fine for checking the build but Play refuses it, so
   it is named as such rather than left to be discovered at upload time. */
const signed =
  existsSync(path.join(androidDir, "keystore.properties")) || Boolean(process.env.ANDROID_KEYSTORE_PATH);

const outDir = path.join(RELEASES, app.folder);
const fileName = `${app.slug}-${version}-${build}${signed ? "" : "-unsigned"}.${kind.ext}`;
const target = path.join(outDir, fileName);

if (existsSync(target)) {
  fail(
    `${path.relative(REPO, target)} already exists.\n` +
      `  Build ${build} has been produced before. The number is the commit count, so a second\n` +
      `  build of the same commit repeats it, and Play refuses a repeated number.\n` +
      `  Commit your changes and build again, or number this build yourself:\n` +
      `    BUILD_NUMBER=${Number(build) + 1} npm run native:release:${kindArg}\n` +
      `  If the earlier file was never uploaded, delete it and build again.`,
  );
}

console.log(`\n${app.label}: version ${version}, build ${build}, ${signed ? "signed with the upload key" : "UNSIGNED"}\n`);

/* Gradle needs a JDK and the SDK location. Android Studio has both but only
   tells its own terminal; from a plain shell, fall back to what it installed
   rather than failing with "Unable to locate a Java Runtime". An explicit
   JAVA_HOME, ANDROID_HOME or android/local.properties is left alone. */
const env = { ...process.env };
const studioJdk = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
if (!env.JAVA_HOME && existsSync(studioJdk) && spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0) {
  env.JAVA_HOME = studioJdk;
}
const homeSdk = path.join(process.env.HOME ?? "", "Library/Android/sdk");
if (
  !env.ANDROID_HOME &&
  !env.ANDROID_SDK_ROOT &&
  !existsSync(path.join(androidDir, "local.properties")) &&
  existsSync(homeSdk)
) {
  env.ANDROID_HOME = homeSdk;
}

const gradle = spawnSync("./gradlew", [kind.task], { cwd: androidDir, stdio: "inherit", env });
if (gradle.status !== 0) fail(`gradlew ${kind.task} failed (exit ${gradle.status ?? "signal"}).`);

const produced = kind.outputs
  .map((rel) => path.join(androidDir, "app/build/outputs", rel))
  .find((file) => existsSync(file));
if (!produced) fail(`gradle finished but none of ${kind.outputs.join(", ")} was written under android/app/build/outputs.`);

mkdirSync(outDir, { recursive: true });
copyFileSync(produced, target);

console.log(`
  ${app.label}
  version ${version}   build ${build}   ${signed ? "signed" : "UNSIGNED - Play will not accept this"}

  ${path.relative(REPO, target)}
${
  signed
    ? `
  Upload it in Play Console -> the app -> Release -> Testing or Production -> Create new release.`
    : `
  To sign: copy android/keystore.properties.example to android/keystore.properties and fill it in.`
}
`);
