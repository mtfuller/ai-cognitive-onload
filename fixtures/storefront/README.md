# acme/storefront

A small checkout service. `POST /checkout` reserves stock, charges the card
through Stripe, saves the order with an outbox row in one transaction, and the
email worker sends the receipt when `order.placed` is published.

This repository is a fixture for the System Editor plugin's tests and evals.
