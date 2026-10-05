import { test } from '@e2e-dev/web';
import { LAPTOP } from './viewports';

// Known bug today: a signed-in member who opens an invite link that was already used
// stays on a stuck invite page. This check must FAIL until that is fixed.
// Set E2E_USED_INVITE_PATH to the /invite/<token> path of an invite already accepted in the preview data.
test('a used invite link sends a signed-in member to the app', async ({ app, agent, browser }) => {
  const path = process.env.E2E_USED_INVITE_PATH;
  test.skip(!path, 'E2E_USED_INVITE_PATH is not set');
  await browser.setViewport(LAPTOP);
  await app.open(path!);
  await agent.waitFor('the page has finished loading');
  await agent.assert('the app itself is shown (a dashboard, task list or sidebar), not an invite page, a spinner or an error');
});
