// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/aura-template.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEATURE_REQUEST_PARAGRAPH,
  readTemplateFiles,
  templateFeaturesOn,
  templateLeaks,
  withFeatureRequestAddress,
} from "./aura-template.js";

const files = readTemplateFiles();

function frontmatterList(markdown: string, key: string): string[] {
  const block = markdown.split("---")[1] ?? "";
  const match = block.match(new RegExp(`^${key}:\\n((?:  - .+\\n)+)`, "m"));
  return match ? match[1].trim().split("\n").map((line) => line.replace(/^\s*-\s*/, "")) : [];
}

test("the template is one company, Aura, with one agent, John (CEO)", () => {
  assert.match(files["COMPANY.md"], /^name: Aura$/m);
  const agents = Object.keys(files).filter((file) => file.endsWith("/AGENTS.md"));
  assert.deepEqual(agents, ["agents/john/AGENTS.md"]);
  assert.match(files["agents/john/AGENTS.md"], /^name: John$/m);
  assert.match(files["agents/john/AGENTS.md"], /^role: ceo$/m);
  assert.match(files[".paperclip.yaml"], /requireBoardApprovalForNewAgents: true/);
});

test("John offers the three life agents and hires none up front", () => {
  const body = files["agents/john/AGENTS.md"];
  assert.match(body, /Job search \(your first offer\)/);
  assert.match(body, /Investor list curator \(on request\)/);
  assert.match(body, /Outreach drafter \(on request\)[^\n]*never sends anything by itself/);
  assert.match(body, /Offer, do not pre-build/);
});

test("John's model is the owner's own Claude plan and never Fable", () => {
  assert.match(files[".paperclip.yaml"], /type: claude_local\n\s+config:\n\s+model: claude-sonnet-5/);
  assert.doesNotMatch(Object.values(files).join("\n"), /claude-fable/i);
});

test("the modules are website, intelligence and image", () => {
  assert.deepEqual(templateFeaturesOn(files), ["enableWebsiteView", "enableIntelligence"]);
  assert.deepEqual(Object.keys(JSON.parse(files["instance.json"]).modules), ["website", "intelligence", "image"]);
});

test("John uses only platform skills, no Greatstone-only skills", () => {
  assert.deepEqual(frontmatterList(files["agents/john/AGENTS.md"], "skills"), ["gsam-intelligence"]);
});

test("the intelligence routine ships paused", () => {
  assert.match(files[".paperclip.yaml"], /daily-intelligence-pulse:\n\s+status: paused/);
  assert.match(files["projects/life-admin/tasks/daily-intelligence-pulse/TASK.md"], /^recurring: true$/m);
});

test("nothing in the template comes from Greatstone", () => {
  assert.deepEqual(templateLeaks(files), []);
});

test("the leak check finds what it must", () => {
  const leaks = templateLeaks({
    "a.md": "Greatstone\nask Everest\nWill said\nx@y.com\nGRE-12\nsk-abcdefgh12345\ngreatstone-voice\nclaude-fable-5-1\n/Users/me",
  });
  assert.deepEqual(new Set(leaks.map((leak) => leak.line)), new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
});

test("only the feature-request paragraph may name Greatstone and the intake inbox", () => {
  assert.ok(files["agents/john/AGENTS.md"].includes(`\n${FEATURE_REQUEST_PARAGRAPH}\n`));
  const address = "everest.greatstone@agentmail.to";
  const filled = withFeatureRequestAddress(files, address);
  assert.ok(filled["agents/john/AGENTS.md"].includes(`write a short email to \`${address}\``));
  assert.deepEqual(templateLeaks(filled, address), []);
  // The address is allowed only inside that paragraph, word for word.
  assert.equal(templateLeaks({ "a.md": address }, address).length, 2);
  assert.equal(templateLeaks({ "a.md": `${FEATURE_REQUEST_PARAGRAPH} Ask Everest.` }).length, 2);
  assert.throws(() => withFeatureRequestAddress(files, "not an address"));
});
