# zai-runner-cloud — z.ai signup via Netlify cloud builds (Path B experiment)

Public mirror of the zai-runner GHA lane. Each Netlify build (draft/preview,
0 credits, build-minutes unmetered on credit plans) runs the z.ai signup
chain ON a Netlify build machine — a diversified-IP lane alongside GHA.

- `build.sh` = the build command: installs chromium, runs the signup chain,
  stages creds into `dist/` (draft deploy) AND the site Blobs store
  (`zai-runs`) via the onPostBuild plugin (runtime token lives only there).
- Secrets via Netlify site env vars: `MAIL_API_TOKEN`, `MAIL_DOMAIN`.
- The workflow counterpart (private repo, GHA runners): belram448O/zai-runner.

Read creds back: Blobs REST
`GET /api/v1/blobs/{site_id}/site:zai-runs/runs/<ts>/zai-<tag>.json` with a
site PAT, or `netlify blobs:get zai-runs <key>`.
