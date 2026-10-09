// Email worker: sends transactional email when order events arrive on the
// bus. Runs as its own process; nothing in orders-api calls it directly.

import { bus } from './bus.ts'
import { mailer, orders } from './deps.ts'
import { receiptTemplate } from './templates.ts'

bus.subscribe('order.placed', async (msg) => {
  const order = await orders.get(msg.payload);
  await mailer.send(receiptTemplate(order));
});
