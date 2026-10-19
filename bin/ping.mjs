// Proves a skill can find and run the plugin's scripts (DESIGN.md, "To verify before building").
import { fileURLToPath } from 'node:url'
console.log(`nightshift-ok ${fileURLToPath(new URL('.', import.meta.url))}`)
