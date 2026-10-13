# Teacher output training-use evidence

Verified on **2026-10-13** for the configured RouteTok DeepSeek Flash route.

- The operator confirmed that they built **RouteTok** and that the relay permits
  this workflow. `agentrouter` is the configuration provider ID for that relay.
- DeepSeek's official **Open Platform Terms of Service**, released 2026-04-22 and
  effective 2026-04-29, expressly permit using inputs/outputs for **“training other
  models (such as model distillation)”** in §4.2(3). §4.2(2) assigns any DeepSeek
  rights in service outputs to the user, subject to applicable law and its terms.
- DeepSeek's general **Terms of Use**, updated 2026-03-27, contains the same
  training-use permission in §4.2(3). The API-specific terms identify themselves
  as a specific agreement under the general terms.

Sources:

1. https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html
2. https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html

`routetok-deepseek-flash.json` records the inspected sections, exact snapshot
SHA-256s, operator confirmation and the intended teacher identity. Its relay URL
is represented by a digest; credentials and private endpoints are not recorded.
`snapshots/` retains the public HTML bytes retrieved from the official URLs.

The intended use is generating synthetic RPG examples to fine-tune the local
VelvetRP Qwen3-8B model. This evidence supports `verified-permitted` rights
provenance for the matching teacher route. It does not measure dataset quality.

To capture current public terms for comparison:

```bash
python3 dataset/rights/capture.py --output /tmp/opencode/current-deepseek-terms
```

Review source changes before updating the pinned receipt. Retrieval and review
never require an API key or a paid model call.
