# Frontend experience preview

An isolated React prototype for exploring a different human-facing workspace.
It uses the supplied Harakiri tokens and IBM Plex typography.

```sh
npm run dev:experience
# http://127.0.0.1:4529/

npm run build:experience
```

Use **Try a journey** to explore creation, contribution, collaboration, recovery,
first launch or delayed updates. Work previews open in a separate tab. The
appearance button switches between the supplied light and dark palettes.

All records are fictional. Sign-ins, agent execution and drafting responses are
simulated and labeled. No native adapter, credentials, mission database, VM or
peer networking is used. Reload resets the sample mission; channel drafts use
preview-only session storage. Unfinished setup survives navigation within the
open preview. The production frontend and backend are unaffected.

Files are organized by journey (`CreateMission`, `JoinMission`, `Mission`), with
shared visual primitives in `ui.tsx` and sample data in `model.ts`. This preview
does not replace the existing application contracts or its native security model.
