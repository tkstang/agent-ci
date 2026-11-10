---
name: ci-probe-second
description: Use when explicitly requested to verify native skill discovery and execution order.
metadata:
  version: "1.0.0"
---

Read agent-ci-skill-order.txt. Require its content to be exactly first followed by a newline. Append second followed by a newline. If the prerequisite is missing, report failure.

Edit workspace files only. Do not commit, push, access the network, or expose credentials. Follow the agent-ci final output contract.
