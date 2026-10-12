// onPostBuild: copy /tmp/zaiout creds into the site Blobs store so they
// survive the build (draft deploy dist/ also carries them, but Blobs is
// the durable lane). NETLIFY_BLOBS_CONTEXT is injected in this phase ONLY.
const fs = require('fs');
const path = require('path');
module.exports = {
  onPostBuild: async ({ utils }) => {
    try {
      const src = '/tmp/zaiout';
      if (!fs.existsSync(src)) { console.log('[egress] no /tmp/zaiout — skip'); return; }
      const { getStore } = await import('@netlify/blobs');
      const store = await getStore('zai-runs');
      for (const f of fs.readdirSync(src)) {
        const p = path.join(src, f);
        const data = fs.readFileSync(p, 'utf8');
        const key = `runs/${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}/${f}`;
        await store.set(key, data);
        console.log(`[egress] ${key} (${data.length}B) -> store zai-runs`);
      }
      await store.set('runs/latest-pointer', JSON.stringify({ at: new Date().toISOString() }));
    } catch (e) {
      console.log('[egress] failed:', e.message);
    }
  },
};
