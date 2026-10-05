import { test } from '@e2e-dev/web';
import { z } from 'zod';
import { LAPTOP } from './viewports';

// Needs an open decision in the preview data. The preview is a copy, so answering one here changes nothing live.
test('decisions page loads and an answered decision moves to Decided', async ({ app, agent, browser }) => {
  await browser.setViewport(LAPTOP);
  await app.open('/');
  await agent.act('open the Decisions page');
  await agent.assert('the Decisions page has loaded and shows a list of decisions or a clear empty state, with no error message');
  const { question } = await agent.extract('the question text of the first decision that is still waiting for an answer', {
    schema: z.object({ question: z.string() }),
  });
  await agent.act('answer the decision {question} by choosing its first option and submitting', { params: { question } });
  await agent.act('show the decided decisions');
  await agent.assert('the decision {question} is shown under Decided', { params: { question } });
});
