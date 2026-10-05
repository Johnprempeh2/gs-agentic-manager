import { test } from '@e2e-dev/web';
import { LAPTOP } from './viewports';

test("assign task from an agent's page opens the new task form with that agent selected", async ({ app, agent, browser }) => {
  await browser.setViewport(LAPTOP);
  await app.open('/');
  await agent.act("open the page of the agent called Keystone");
  await agent.act('click Assign Task');
  await agent.assert('a new task form is open and its assignee is Keystone');
});
