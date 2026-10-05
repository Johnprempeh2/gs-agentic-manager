import { test } from '@e2e-dev/web';
import { PHONE } from './viewports';

// Phone chat: the keyboard must not cover the composer (John and Ben found this on a phone).
test('phone chat: send button and action row stay visible while typing to Everest', async ({ app, agent, browser }) => {
  await browser.setViewport(PHONE);
  await app.open('/');
  await agent.act("open the chat with the agent called Everest");
  await agent.act("tap the message box and type 'Release check, please ignore' without sending it");
  // Shrink the visual viewport the way an on-screen keyboard does.
  await browser.setViewport({ width: PHONE.width, height: 380 });
  await agent.assert('the message box, the send button and the row of composer actions are all fully visible on screen, not cut off or hidden below the bottom edge', { vision: true });
});
