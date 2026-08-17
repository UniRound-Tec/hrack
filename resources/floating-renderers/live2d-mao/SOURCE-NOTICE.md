# HRack built-in Live2D renderer

This built-in renderer uses:

- Live2D Cubism Web Samples `5-r.4`, commit `435707a4676c19de754a8a557638450f889dcd2c`.
- Live2D Cubism Web Framework `5-r.4`, commit `677c50313e04b8fe73186e7489ec20c71e30f310`.
- The official Mao sample model from `Samples/Resources/Mao`.
- Cubism Core 05.01.0000 downloaded from Live2D's official hosting URL on 2026-08-17. This is the Core version paired with the `5-r.4` framework API.
- Cubism Core SHA-256: `25AE938CB4FE282CE189B357BCC97E603D1E1F7EC78BF04150D401C23CDC792F`.

The renderer subscribes only to HRack's restricted floating-window bridge and
maps real session/turn projections to visible status and animation. See
`Live2D-LICENSE.md`, `Live2D-NOTICE.md`, `Core/LICENSE.md`, and
`Core/RedistributableFiles.txt` before redistribution or release. Businesses
that meet Live2D's licensing threshold must obtain the applicable Cubism SDK
Release License before publishing a packaged build.
