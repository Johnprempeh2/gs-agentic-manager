import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleasePackagePlan,
  checkConfiguration,
  findUnpublishableWorkspaceEdges,
  getReleasePackages,
} from "./release-package-map.mjs";

function pkg(name, { publishFromCi, ...deps } = {}) {
  return { name, dir: name, publishFromCi, pkg: { name, ...deps } };
}

test("release package manifest covers all public packages with explicit CI enrollment", () => {
  const packages = buildReleasePackagePlan();
  assert.ok(packages.length > 0);
  assert.ok(packages.every((pkg) => typeof pkg.publishFromCi === "boolean"));
});

test("release package list only contains CI-enrolled packages", () => {
  const enabledPackages = getReleasePackages();
  assert.ok(enabledPackages.length > 0);
  assert.ok(enabledPackages.every((pkg) => pkg.publishFromCi === true));
});

test("release package list publishes the installable channel entrypoint last", () => {
  const enabledPackages = getReleasePackages();

  assert.equal(enabledPackages.at(-1)?.name, "gsam");
  assert.ok(enabledPackages.slice(0, -1).some((pkg) => pkg.name === "@greatstone/server"));
});

test("release package list keeps runtime workspace dependencies ahead of consumers", () => {
  const enabledPackages = getReleasePackages();
  const publishIndexByName = new Map(enabledPackages.map((pkg, index) => [pkg.name, index]));

  for (const pkg of enabledPackages) {
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependencyName, spec] of Object.entries(pkg.pkg[section] ?? {})) {
        if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
        const dependencyIndex = publishIndexByName.get(dependencyName);
        if (dependencyIndex === undefined) continue;

        assert.ok(
          dependencyIndex < publishIndexByName.get(pkg.name),
          `${dependencyName} must publish before ${pkg.name}`,
        );
      }
    }
  }
});

test("Hermes release surface publishes the unified built-in package and keeps gateway as a shim", () => {
  const packages = buildReleasePackagePlan();
  const hermes = packages.find((pkg) => pkg.name === "@greatstone/hermes-paperclip-adapter");
  const gatewayShim = packages.find((pkg) => pkg.name === "@greatstone/adapter-hermes-gateway");

  assert.equal(hermes?.dir, "packages/adapters/hermes");
  assert.equal(hermes?.publishFromCi, true);
  assert.equal(gatewayShim?.dir, "packages/adapters/hermes-gateway");
  assert.equal(gatewayShim?.publishFromCi, false);
});

test("release package configuration validates successfully", () => {
  assert.doesNotThrow(() => checkConfiguration());
});

test("guard flags a publishFromCi:true package depending on a publishFromCi:false package", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@greatstone/server", {
      publishFromCi: true,
      dependencies: { "@greatstone/skills-catalog": "workspace:*" },
    }),
    pkg("@greatstone/skills-catalog", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /@greatstone\/server/);
  assert.match(problems[0], /@greatstone\/skills-catalog/);
});

test("guard inspects optional and peer dependency sections too", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@greatstone/server", {
      publishFromCi: true,
      optionalDependencies: { "@greatstone/opt": "workspace:^" },
      peerDependencies: { "@greatstone/peer": "workspace:*" },
    }),
    pkg("@greatstone/opt", { publishFromCi: false }),
    pkg("@greatstone/peer", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 2);
});

test("guard treats a workspace dep on an unknown @greatstone package as unpublishable", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@greatstone/server", {
      publishFromCi: true,
      dependencies: { "@greatstone/private-internal": "workspace:*" },
    }),
  ]);

  assert.equal(problems.length, 1);
});

test("guard allows true->true workspace edges", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@greatstone/server", {
      publishFromCi: true,
      dependencies: { "@greatstone/shared": "workspace:*" },
    }),
    pkg("@greatstone/shared", { publishFromCi: true }),
  ]);

  assert.deepEqual(problems, []);
});

test("guard ignores non-workspace specs, non-internal deps, and edges from off-train packages", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@greatstone/server", {
      publishFromCi: true,
      dependencies: {
        "@greatstone/pinned": "0.3.1",
        zod: "^3.0.0",
      },
    }),
    pkg("@greatstone/pinned", { publishFromCi: false }),
    pkg("@greatstone/offtrain", {
      publishFromCi: false,
      dependencies: { "@greatstone/also-off": "workspace:*" },
    }),
    pkg("@greatstone/also-off", { publishFromCi: false }),
  ]);

  assert.deepEqual(problems, []);
});

test("the live release manifest has no unpublishable workspace edges", () => {
  assert.deepEqual(findUnpublishableWorkspaceEdges(buildReleasePackagePlan()), []);
});
