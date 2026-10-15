#!/usr/bin/env node
// CookieGate store build — the single way release packages are produced.
//
//   node tools/build/build_release.mjs            build release/CookieGate-v<version>/
//   node tools/build/build_release.mjs --force    overwrite files in an existing release folder
//   node tools/build/build_release.mjs --check    validate src only, write nothing
//
// Source of truth: src/shared (identical in every browser) + src/platform/<chrome|firefox>
// (manifest + background). Version comes from src/platform/chrome/manifest.json and must
// match the Firefox manifest, the engine VERSION and package.json, or the build fails.
//
// Output (deterministic: sorted entries, fixed timestamps, forward slashes):
//   CookieGate-<v>-firefox.zip   Firefox Add-ons (MV2)
//   CookieGate-<v>-chrome.zip    Chrome Web Store (MV3)
//   CookieGate-<v>-edge.zip      Microsoft Edge Add-ons   (same bytes as chrome)
//   CookieGate-<v>-opera.zip     Opera Add-ons            (same bytes as chrome)
//   CookieGate-<v>-brave.zip     records only; Brave installs from the Chrome Web Store
//   unpacked/chrome, unpacked/firefox, store-icon-128.png, store-icon-512.png, icon-master.svg
//   SHA256SUMS.txt  — written last, only after every zip is re-read and verified byte-for-byte.
//
// No dependencies beyond Node >= 22 (zlib.crc32).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");
const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force"), CHECK_ONLY = args.has("--check");

function die(msg) { console.error("BUILD FAILED: " + msg); process.exit(1); }
function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}
const rel = (base, p) => relative(base, p).split(sep).join("/");

// Files kept in src for reference but never shipped (950 KB master artwork, unreferenced).
const EXCLUDE = new Set(["icons/cookiegate_icon_master.svg"]);

/* ---------- 1. collect + validate ---------- */
const crManifest = JSON.parse(readFileSync(join(SRC, "platform", "chrome", "manifest.json"), "utf8"));
const ffManifest = JSON.parse(readFileSync(join(SRC, "platform", "firefox", "manifest.json"), "utf8"));
const VERSION = crManifest.version;
if (!/^\d+\.\d+\.\d+$/.test(VERSION || "")) die("chrome manifest version is not x.y.z: " + VERSION);
const engineVersion = (readFileSync(join(SRC, "shared", "ui", "cg_engine.js"), "utf8").match(/VERSION:"([^"]+)"/) || [])[1];
const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const versions = { chrome: VERSION, firefox: ffManifest.version, engine: engineVersion, package: pkgVersion };
if (new Set(Object.values(versions)).size !== 1) die("version mismatch " + JSON.stringify(versions));
if (crManifest.manifest_version !== 3) die("chrome manifest must be MV3");
if (ffManifest.manifest_version !== 2) die("firefox manifest must be MV2 (AMO listing)");
if (!ffManifest.browser_specific_settings || !ffManifest.browser_specific_settings.gecko || ffManifest.browser_specific_settings.gecko.id !== "cookiegate@local.dev") die("firefox gecko id must stay cookiegate@local.dev (live AMO listing)");

function packageFiles(platform, manifest) {
  const files = new Map(); // archive path -> Buffer
  const shared = join(SRC, "shared");
  for (const p of walk(shared)) { const r = rel(shared, p); if (!EXCLUDE.has(r)) files.set(r, readFileSync(p)); }
  const plat = join(SRC, "platform", platform);
  for (const p of walk(plat)) { const r = rel(plat, p); if (r === "manifest.json") continue; if (files.has(r)) die(platform + " file shadows shared file: " + r); files.set(r, readFileSync(p)); }
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
  return files;
}

function referencedPaths(m) {
  const refs = new Set();
  const icons = (o) => o && Object.values(o).forEach((v) => refs.add(v));
  icons(m.icons); icons((m.action || m.browser_action || {}).default_icon);
  const popup = (m.action || m.browser_action || {}).default_popup; if (popup) refs.add(popup);
  if (m.options_ui && m.options_ui.page) refs.add(m.options_ui.page);
  if (m.background) { if (m.background.service_worker) refs.add(m.background.service_worker); (m.background.scripts || []).forEach((s) => refs.add(s)); }
  (m.content_scripts || []).forEach((cs) => { (cs.js || []).forEach((s) => refs.add(s)); (cs.css || []).forEach((s) => refs.add(s)); });
  return refs;
}

function validate(platform, files, manifest) {
  for (const r of referencedPaths(manifest)) if (!files.has(r)) die(`${platform}: manifest references missing file ${r}`);
  // every <script src> / <link href> in packaged HTML must exist; no inline or remote script
  for (const [p, buf] of files) {
    if (!p.endsWith(".html")) continue;
    const html = buf.toString("utf8"), dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = (m[1].match(/src="([^"]+)"/) || [])[1];
      if (!src) die(`${platform}: inline <script> in ${p} (blocked by extension CSP)`);
      if (/^[a-z]+:/i.test(src)) die(`${platform}: remote script ${src} in ${p}`);
      if (!files.has(dir + src)) die(`${platform}: ${p} loads missing ${src}`);
    }
    for (const m of html.matchAll(/<link\b[^>]*href="([^"]+)"/gi)) if (!/^[a-z]+:/i.test(m[1]) && !files.has(dir + m[1])) die(`${platform}: ${p} links missing ${m[1]}`);
  }
  for (const [p, buf] of files) {
    if (!p.endsWith(".js")) continue;
    const code = buf.toString("utf8");
    if (/\beval\s*\(|new\s+Function\s*\(|document\.write\s*\(|importScripts\s*\(/.test(code)) die(`${platform}: forbidden dynamic code construct in ${p}`);
    if (/\.innerHTML\s*=/.test(code)) die(`${platform}: innerHTML assignment in ${p} (AMO warning)`);
    if (/^﻿/.test(code)) die(`${platform}: UTF-8 BOM in ${p}`);
  }
}

const chromeFiles = packageFiles("chrome", crManifest);
const firefoxFiles = packageFiles("firefox", ffManifest);
validate("chrome", chromeFiles, crManifest);
validate("firefox", firefoxFiles, ffManifest);
// shared files must be byte-identical in both packages
for (const [p, buf] of chromeFiles) if (firefoxFiles.has(p) && p !== "manifest.json" && !buf.equals(firefoxFiles.get(p))) die("shared file differs between packages: " + p);

console.log(`CookieGate ${VERSION}: chrome ${chromeFiles.size} files, firefox ${firefoxFiles.size} files — source checks passed`);
if (CHECK_ONLY) process.exit(0);

/* ---------- 2. deterministic zip ---------- */
// Fixed DOS timestamp 2026-01-01 00:00:00 so identical source => identical bytes.
const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
function makeZip(files) {
  const names = [...files.keys()].sort((a, b) => (a === "manifest.json" ? -1 : b === "manifest.json" ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const locals = [], centrals = []; let offset = 0;
  for (const name of names) {
    const data = files.get(name), comp = deflateRawSync(data, { level: 9 }), crc = crc32(data) >>> 0, nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(names.length, 8); eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
// Independent reader used to verify what was written (fail closed on any difference).
function readZip(buf) {
  const eo = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eo < 0) throw new Error("no end of central directory");
  const n = buf.readUInt16LE(eo + 10); let p = buf.readUInt32LE(eo + 16); const out = new Map();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central header");
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString("utf8");
    const lnl = buf.readUInt16LE(lo + 26), lel = buf.readUInt16LE(lo + 28), start = lo + 30 + lnl + lel;
    const raw = buf.slice(start, start + csize), data = method === 8 ? inflateRawSync(raw) : raw;
    if (data.length !== usize || (crc32(data) >>> 0) !== crc) throw new Error("size/CRC mismatch: " + name);
    if (name.includes("\\") || name.startsWith("/")) throw new Error("bad entry path: " + name);
    out.set(name, data); p += 46 + nl + el + cl;
  }
  return out;
}

/* ---------- 3. write ---------- */
const OUT = join(ROOT, "release", "CookieGate-v" + VERSION);
if (existsSync(OUT) && !FORCE) die(OUT + " already exists (use --force to overwrite its files, or bump the version)");
mkdirSync(OUT, { recursive: true });

function writeUnpacked(platform, files) {
  for (const [p, buf] of files) { const dst = join(OUT, "unpacked", platform, ...p.split("/")); mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, buf); }
}
writeUnpacked("chrome", chromeFiles);
writeUnpacked("firefox", firefoxFiles);

const chromeZip = makeZip(chromeFiles), firefoxZip = makeZip(firefoxFiles);
const outputs = [
  ["firefox", firefoxZip, firefoxFiles], ["chrome", chromeZip, chromeFiles], ["edge", chromeZip, chromeFiles],
  ["opera", chromeZip, chromeFiles], ["brave", chromeZip, chromeFiles],
];
const sums = [];
for (const [store, zip, files] of outputs) {
  const name = `CookieGate-${VERSION}-${store}.zip`, path = join(OUT, name);
  writeFileSync(path, zip);
  const back = readFileSync(path); let entries;
  try { entries = readZip(back); } catch (e) { die(name + ": " + e.message); }
  if (entries.size !== files.size) die(`${name}: ${entries.size} entries, expected ${files.size}`);
  for (const [p, buf] of files) if (!entries.has(p) || !entries.get(p).equals(buf)) die(`${name}: entry ${p} differs from source`);
  const m = JSON.parse(entries.get("manifest.json").toString("utf8"));
  if (m.version !== VERSION) die(`${name}: manifest version ${m.version}`);
  sums.push(`${sha256(back)}  ${name}`);
  console.log(`  ${name}  ${back.length} bytes  ${entries.size} entries  verified`);
}
copyFileSync(join(SRC, "shared", "icons", "cookiegate_128.png"), join(OUT, "store-icon-128.png"));
copyFileSync(join(SRC, "shared", "icons", "cookiegate_512.png"), join(OUT, "store-icon-512.png"));
copyFileSync(join(SRC, "shared", "icons", "cookiegate_icon_master.svg"), join(OUT, "icon-master.svg"));
writeFileSync(join(OUT, "SHA256SUMS.txt"), sums.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1)).join("\n") + "\n");
console.log("BUILD OK -> " + rel(ROOT, OUT));
