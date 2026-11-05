// Regenerates the example files in this folder:  node examples/make_examples.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate, PRESETS } from '../web/js/generators.js';
import { toJSON, toCSV, parseAnimation } from '../web/js/format.js';
import { buildBridge, bridgeToJSON } from '../web/js/bridge.js';
import { DEFAULT_LIMITS } from '../web/js/limits.js';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const ripple = generate({ duration: 10, layers: PRESETS['Pebble in a pond'] });
ripple.source = 'example';
writeFileSync(here('ripple_8x8.json'), toJSON(ripple));
writeFileSync(here('ripple_8x8.csv'), toCSV(ripple));
// Build the bridge file from the exported JSON, exactly like a user would.
const reread = parseAnimation(toJSON(ripple));
writeFileSync(here('ripple_8x8.pbridge.json'), bridgeToJSON(buildBridge(reread, {}, DEFAULT_LIMITS)));

const fast = generate({ duration: 10, layers: PRESETS['Too fast (stress test)'] });
fast.source = 'example';
writeFileSync(here('too_fast_8x8.json'), toJSON(fast));
console.log('examples written');
