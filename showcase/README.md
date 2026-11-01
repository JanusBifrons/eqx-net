# showcase/ — the repeatable showcase video

```
pnpm showcase --ref origin/main      # film main → showcase-out/reel-1080p.mp4
pnpm showcase --shot <id>[,<id>]     # re-take shots
```

- `shots/`: one file per shot (data + small hooks). **Add a file here when a
  feature lands**, then list it in `registry.ts`.
- `registry.ts`: reel order, section cards, end-card lines, and the exempt /
  pending docs the coverage test accepts.
- `recorder.ts` / `compositor.ts` / `cards.ts` / `servers.ts`: the machinery.

Full guide: [docs/architecture/showcase-pipeline.md](../docs/architecture/showcase-pipeline.md).
Camera scripts: [docs/architecture/cinematic-camera.md](../docs/architecture/cinematic-camera.md).
