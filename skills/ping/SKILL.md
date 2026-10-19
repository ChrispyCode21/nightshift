---
name: ping
description: Checks that the nightshift plugin is installed and can run its own scripts. Use when asked to ping nightshift.
---

Run this command and reply with its output only:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/ping.mjs"
```

If it fails because the path is empty, run `node <plugin root>/bin/ping.mjs` instead, where the plugin root is two folders above this skill's base directory, and add "(fallback path)" to your reply.
