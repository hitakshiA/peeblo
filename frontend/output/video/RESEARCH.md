# Loop generation decision

Researched with Exa and verified against Together's authenticated model catalog on September 13, 2026.

Selected: ByteDance/Seedance-2.0, 720p, 16:9, 5 seconds, identical generated image for `media.frame_images` first and last. Explicitly requested no audio. The returned first clip nevertheless contained an audio track; the web derivative strips audio completely.

The deciding factors were documented first/last control, prompt-based motion direction, sufficient resolution for the landing page, and a predictable budget that leaves room for revisions. This is a fit assessment, not a claim of measured superiority across every video model.

| Candidate | Verified price information | Decision |
| --- | --- | --- |
| Seedance 2.0 | $0.16 per second at 720p in live API catalog | Two five-second jobs estimated at $1.60 total |
| Seedance 2.5 | 720p starts at $0.249 per second in live API catalog | More expensive for this subtle still-life task |
| Kling 2.1 Pro | Catalog example $0.3234 for 1080p/5 seconds | Cheaper, but chosen model has directly documented two-keyframe prompt usage |
| Wan 2.7 I2V | First/last control documented; catalog example $0.10 per five seconds | Budget alternative; not tested or charged |
| Vidu Q1 | Catalog example $0.22 for 1080p/5 seconds | Not tested or charged |

Sources:
- https://docs.together.ai/docs/seedance2.0-quickstart
- https://docs.together.ai/docs/inference/videos/reference-and-keyframes
- https://docs.together.ai/docs/wan2.7-quickstart
- https://docs.together.ai/reference/create-videos
- https://api.together.xyz/v1/models (authenticated read-only inventory)

Caution for reproduction: the Seedance 2.0 `.md` URL redirected to Seedance 2.5 content during this session, while Exa's fetched page described 2.0. The model string, price and successful generation were checked against the live API. Catalog example prices are not interchangeable with exact per-request quotes.

Budget: user authorized up to their stated $3.88 balance. Two jobs only, estimated $0.80 each. Completed job responses may omit billed cost; do not report an estimate as a confirmed account debit or remaining balance. No automatic retry of job creation; saved IDs prevent duplicate submissions.

Prompts are recorded in orbit-prompt.txt and evidence-prompt.txt. Raw job responses are in the corresponding JSON files. No API credential is stored in this project.

## Completed media inspection
Both jobs completed successfully at 1280×720, 24fps, approximately five seconds. Their outputs omit a `cost` field, so $1.60 remains an estimate. Web derivatives strip the audio track, use H.264/yuv420p, and move MP4 metadata to the front for playback.

At a 160×90 RGB inspection resolution, first-to-last mean absolute differences were 0.681/255 for orbit and 0.954/255 for evidence. This supports a visually close loop boundary; it is not a guarantee of pixel-identical generated endpoints. Five-frame contact sheets were inspected for object stability and motion. Both loops retain the subject and use restrained reflection/paper motion.
