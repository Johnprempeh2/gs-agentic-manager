// Tests for the no-root fetch of Chromium's system libraries (GRE-1065).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureChromiumLibs, libPaths, packagesFor, parseLdd } from "./chromium-libs.mjs";

test("ldd output gives the missing library files", () => {
  const output = "\tlinux-vdso.so.1 (0x0)\n\tlibnspr4.so => not found\n\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x0)\n\tlibasound.so.2 => not found\n";
  assert.deepEqual(parseLdd(output), ["libnspr4.so", "libasound.so.2"]);
});

test("missing libraries map to packages, each package once", () => {
  assert.deepEqual(packagesFor(["libnspr4.so", "libnss3.so", "libnssutil3.so", "libsmime3.so", "libasound.so.2"]), {
    packages: [["libnspr4"], ["libnss3"], ["libasound2t64", "libasound2"]],
    unknown: [],
  });
  assert.deepEqual(packagesFor(["libnspr4.so", "libweird.so.9"]).unknown, ["libweird.so.9"]);
});

function fakeSystem(missingBefore) {
  const calls = { ldd: 0, download: [], extract: [] };
  return {
    calls,
    sys: {
      ldd: () => (calls.ldd++ === 0 ? missingBefore : []),
      download: (name, cwd) => {
        calls.download.push(name);
        if (name === "libasound2t64") return false;
        writeFileSync(join(cwd, `${name}.deb`), "");
        return true;
      },
      extract: (deb) => calls.extract.push(deb.split("/").pop()),
    },
  };
}

test("libraries already present: nothing is downloaded", () => {
  const libRoot = mkdtempSync(join(tmpdir(), "chromium-libs-"));
  try {
    const { sys, calls } = fakeSystem([]);
    const env = ensureChromiumLibs("/pw/chrome-headless-shell", { libRoot, ldPath: "/other", sys });
    assert.equal(env.LD_LIBRARY_PATH, `${libPaths(libRoot).libDir}:/other`);
    assert.deepEqual(calls.download, []);
    assert.deepEqual(calls.extract, []);
  } finally {
    rmSync(libRoot, { recursive: true, force: true });
  }
});

test("missing libraries are downloaded, unpacked, and the temp debs removed", () => {
  const libRoot = mkdtempSync(join(tmpdir(), "chromium-libs-"));
  try {
    const { sys, calls } = fakeSystem(["libnspr4.so", "libnss3.so", "libasound.so.2"]);
    const env = ensureChromiumLibs("/pw/chrome-headless-shell", { libRoot, ldPath: "", sys });
    assert.equal(env.LD_LIBRARY_PATH, libPaths(libRoot).libDir);
    assert.deepEqual(calls.download, ["libnspr4", "libnss3", "libasound2t64", "libasound2"]);
    assert.deepEqual(calls.extract.sort(), ["libasound2.deb", "libnspr4.deb", "libnss3.deb"]);
    assert.equal(calls.ldd, 2);
    assert.ok(!existsSync(join(libRoot, "debs")));
  } finally {
    rmSync(libRoot, { recursive: true, force: true });
  }
});

test("a failed download or a still-missing library throws a reason", () => {
  const libRoot = mkdtempSync(join(tmpdir(), "chromium-libs-"));
  try {
    const noApt = { ldd: () => ["libnspr4.so"], download: () => false, extract: () => {} };
    assert.throws(() => ensureChromiumLibs("/pw/x", { libRoot, sys: noApt }), /could not download libnspr4 with apt-get/);
    const stillMissing = { ldd: () => ["libnspr4.so"], download: () => true, extract: () => {} };
    assert.throws(() => ensureChromiumLibs("/pw/x", { libRoot, sys: stillMissing }), /still misses libnspr4\.so/);
    assert.throws(() => ensureChromiumLibs("/pw/x", { libRoot, sys: { ...noApt, ldd: () => ["libweird.so"] } }), /libweird\.so/);
  } finally {
    rmSync(libRoot, { recursive: true, force: true });
  }
});
