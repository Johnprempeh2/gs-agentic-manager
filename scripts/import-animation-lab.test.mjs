import assert from "node:assert/strict";
import test from "node:test";
import { bundleMappedModules, capturePosters, catalogueByNumber, externalScriptNote, inBatches, inlineRelativeImages, parseAnims, toImportStudy } from "./import-animation-lab.mjs";

const GALLERY = `<script>
/* LIBRARY, newest first */
const ANIMS = [
  { no:'015', slug:'bedrock', title:'Bedrock', concept:'Immense strata [drift], the ground.', theme:['Background','Text-safe','Strata'], tech:'Canvas 2D', date:'2026-07-22' },
  { no:'010', slug:'tracery', title:'Tracery', concept:"Two coupled oscillators.", theme:['Harmonograph'], tech:'Canvas 2D', date:'2026-06-19' }
];
document.getElementById('count').textContent = ANIMS.length;
</script>`;

test("reads the ANIMS array, brackets inside strings included", () => {
  const anims = parseAnims(GALLERY);
  assert.equal(anims.length, 2);
  assert.equal(anims[0].concept, "Immense strata [drift], the ground.");
  assert.deepEqual(anims[1].theme, ["Harmonograph"]);
});

test("takes notes and decisions from the catalogue, and defaults to New and Undecided without a row", () => {
  const [bedrock, tracery] = parseAnims(GALLERY);
  const catalogue = catalogueByNumber([{ "No.": "015", Notes: "BACKGROUND CLASS.", Status: "New", Decision: "Undecided", Tech: "" }]);
  const gallery = "https://greatstone-animation-lab.netlify.app/";

  assert.deepEqual(toImportStudy(bedrock, "<canvas></canvas>", gallery, catalogue), {
    number: "015",
    slug: "bedrock",
    title: "Bedrock",
    concept: "Immense strata [drift], the ground.",
    theme: ["Background", "Text-safe", "Strata"],
    tech: "Canvas 2D",
    notes: "BACKGROUND CLASS.",
    studyDate: "2026-07-22",
    sourceUrl: "https://greatstone-animation-lab.netlify.app/anims/bedrock.html",
    html: "<canvas></canvas>",
    status: "new",
    decision: "undecided",
  });
  const missing = toImportStudy(tracery, "<canvas></canvas>", gallery, catalogue);
  assert.equal(missing.notes, null);
  assert.equal(missing.status, "new");
  assert.equal(missing.decision, "undecided");
});

test("notes a study that loads code from the internet", () => {
  const importMap = '<script type="importmap">{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three/build/three.module.js" } }</script>';
  assert.match(externalScriptNote(importMap), /sandbox blocks/);
  assert.equal(externalScriptNote('<link href="https://fonts.googleapis.com" rel="preconnect"><script>draw()</script>'), null);
});

test("writes relative images into the page as data URIs and leaves absolute ones alone", async () => {
  const asked = [];
  const html = '<img src="../assets/logo.png" alt="Greatstone"><img src="data:image/png;base64,AA==" alt=""><img src="https://example.com/a.png" alt="">';
  const result = await inlineRelativeImages(html, new URL("https://lab.example/anims/flux.html"), async (url) => {
    asked.push(url.toString());
    return { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" };
  });
  assert.deepEqual(asked, ["https://lab.example/assets/logo.png"]);
  assert.match(result, /<img src="data:image\/png;base64,AQID" alt="Greatstone">/);
  assert.match(result, /https:\/\/example.com\/a.png/);
});

test("bundles modules a study maps to a CDN into the page and drops the import map", async () => {
  const cdn = "https://cdn.example/three/";
  const files = {
    [`${cdn}build/three.module.js`]: "export const REVISION = '170'; export const tag = '</script>';",
    [`${cdn}jsm/postprocessing/Pass.js`]: "import { REVISION } from 'three'; export const Pass = () => `pass ${REVISION}`;",
    [`${cdn}jsm/postprocessing/Bloom.js`]: "import { Pass } from './Pass.js'; export const Bloom = () => Pass() + ' bloom';",
  };
  const fetched = [];
  const page = `<head><script type="importmap">{"imports":{"three":"${cdn}build/three.module.js","three/addons/":"${cdn}jsm/"}}</script></head>
<body><canvas></canvas><script type="module">
import * as THREE from 'three';
import { Bloom } from 'three/addons/postprocessing/Bloom.js';
document.title = THREE.REVISION + Bloom() + THREE.tag;
</script></body>`;

  const bundled = await bundleMappedModules(page, async (url) => {
    fetched.push(url);
    return files[url];
  });
  assert.doesNotMatch(bundled, /importmap|cdn\.example|from\s*["']/);
  assert.equal(externalScriptNote(bundled), null);
  assert.deepEqual(fetched.sort(), Object.keys(files).sort());
  const script = bundled.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  assert.match(script, /<\\\/script>/);
  const title = { value: "" };
  new Function("document", script)({ set title(value) { title.value = value; } });
  assert.equal(title.value, "170pass 170 bloom</script>");

  const plain = "<script type=\"module\">import x from './x.js';</script>";
  assert.equal(await bundleMappedModules(plain, async () => assert.fail("no fetch")), plain);
});

test("splits the import into batches", () => {
  assert.deepEqual(inBatches([1, 2, 3, 4, 5, 6, 7], 5), [[1, 2, 3, 4, 5], [6, 7]]);
});

test("captures a poster per study with the network cut, and skips a study that fails", async () => {
  const routed = [];
  const closed = [];
  const launch = async () => ({
    newPage: async (options) => ({
      route: async (pattern) => routed.push(pattern),
      setContent: async (html) => {
        if (html === "broken") throw new Error("crashed");
      },
      waitForTimeout: async () => {},
      screenshot: async () => Buffer.from([1, 2, 3]),
      close: async () => closed.push(options.viewport.width),
    }),
    close: async () => closed.push("browser"),
  });
  const posters = await capturePosters(
    [
      { slug: "bedrock", html: "<canvas></canvas>" },
      { slug: "summit", html: "broken" },
    ],
    { launch },
  );
  assert.deepEqual([...posters.keys()], ["bedrock"]);
  assert.deepEqual(posters.get("bedrock"), { contentType: "image/jpeg", dataBase64: "AQID" });
  assert.deepEqual(routed, ["**/*", "**/*"]);
  assert.deepEqual(closed, [1280, 1280, "browser"]);
});
