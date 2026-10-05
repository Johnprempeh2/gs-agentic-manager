import { test } from '@e2e-dev/web';
import { LAPTOP, PHONE } from './viewports';

for (const [size, viewport] of [['laptop', LAPTOP], ['phone', PHONE]] as const) {
  test(`new task (${size}): Create is off with no title, on with a title, and the task is listed`, async ({ app, agent, browser }) => {
    const title = `e2e trial task ${size} ${Date.now()}`;
    await browser.setViewport(viewport);
    await app.open('/');
    await agent.act('open the form to create a new task');
    await agent.assert('the Create button of the new task form is disabled (greyed out and cannot be clicked) because the title is empty');
    await agent.act('type {title} into the title field of the new task form', { params: { title } });
    await agent.assert('the Create button of the new task form is enabled');
    await agent.act('click the Create button');
    await agent.act('open the list of tasks');
    await agent.assert('a task titled {title} is in the list', { params: { title } });
  });
}
