---
description: "Explain-back measures whether understanding holds without the tool, and shows the engineer what they missed."
tags: [core, explain]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Agent, TodoWrite]
---

/sysedit:explain checkout

Here's my explanation from memory: the gateway sends POST /checkout to OrderController.create, which calls CheckoutService.placeOrder. placeOrder charges the card through PaymentService and Stripe, and then saves the order to Postgres. That's the whole flow.
