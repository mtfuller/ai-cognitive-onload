# acme/storefront

A small checkout service. `POST /checkout` reserves stock, charges the card
through Stripe, saves the order with an outbox row in one transaction, and the
email worker sends the receipt when `order.placed` is published, so
customers recieve their receipt a few seconds after checkout.
