import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_ONE_LANES } from "../../server/src/types.js";
import {
  allLanePromotionStatuses,
  buildPromotionReport,
  buildPromotionSection,
  lanePromotionStatus,
} from "../report-system-one-decisions.js";

test("reports exactly the recorded lanes as promoted", () => {
  const speaker = lanePromotionStatus("speaker-routing");
  assert.equal(speaker.promoted, true);
  assert.ok(speaker.record);
  assert.equal(speaker.record.evidence, "docs/system-one-benchmark.md");
  assert.equal(speaker.record.promotedAt, "2026-09-17");
  assert.deepEqual(speaker.record.metrics, {
    samples: 90,
    accuracy: 1,
    brier: 0,
    expectedCalibrationError: 0.0033,
  });
  assert.equal(speaker.gate?.promoted, true);
  assert.deepEqual(speaker.gate?.reasons, []);

  const router = lanePromotionStatus("cost-router");
  assert.equal(router.promoted, true);
  assert.equal(router.record?.evidence, "docs/system-one-router-benchmark.md");
  assert.equal(router.gate?.promoted, true);

  const narration = lanePromotionStatus("narration-verification");
  assert.equal(narration.promoted, true);
  assert.equal(narration.record?.evidence, "docs/system-one-narration-benchmark.md");
  assert.equal(narration.gate?.promoted, true);

  const director = lanePromotionStatus("director-selection");
  assert.equal(director.promoted, true);
  assert.equal(director.record?.evidence, "docs/system-one-director-calibration.md");
  assert.equal(director.gate?.promoted, true);

  // Every lane carries a frozen record today; the report must agree with the registry lane by lane.
  const recordedLanes = new Set<string>([
    "adventure-selection",
    "cost-router",
    "director-selection",
    "guardrails",
    "memory-reranking",
    "narration-verification",
    "speaker-routing",
  ]);
  assert.deepEqual(
    SYSTEM_ONE_LANES.filter((lane) => lanePromotionStatus(lane).record !== null).sort(),
    [...recordedLanes].sort(),
  );
  for (const lane of SYSTEM_ONE_LANES) {
    const status = lanePromotionStatus(lane);
    if (recordedLanes.has(lane)) {
      assert.equal(status.promoted, true, `${lane} must be promoted`);
      assert.equal(status.gate?.promoted, true, `${lane} must pass its gate`);
    } else {
      assert.equal(status.promoted, false, `${lane} must be unpromoted`);
      assert.equal(status.record, null, `${lane} must have no record`);
      assert.equal(status.gate, null, `${lane} must have no gate verdict`);
    }
  }
});

test("covers every lane in canonical order", () => {
  const statuses = allLanePromotionStatuses();
  assert.deepEqual(
    statuses.map((status) => status.lane),
    [...SYSTEM_ONE_LANES],
  );
});

test("renders a deterministic promotion section with not-recorded lanes", () => {
  const first = buildPromotionReport();
  assert.equal(first, buildPromotionReport());

  for (const lane of SYSTEM_ONE_LANES) {
    assert.match(first, new RegExp(`^### ${lane}$`, "m"));
  }

  assert.match(first, /^\| speaker-routing \| yes \| 2026-09-17 \| docs\/system-one-benchmark\.md \| pass \|$/m);
  assert.match(first, /^### speaker-routing$/m);
  assert.match(first, /- Metrics: samples=90, accuracy=1\.0000, brier=0\.0000, ece=0\.0033/);
  assert.match(first, /- Calibration: a=2\.5732, b=1\.3973/);
  assert.match(first, /- Gate: pass/);
  assert.match(first, /^\| cost-router \| yes \| 2026-09-17 \| docs\/system-one-router-benchmark\.md \| pass \|$/m);
  assert.match(first, /^\| narration-verification \| yes \| 2026-09-17 \| docs\/system-one-narration-benchmark\.md \| pass \|$/m);
  assert.match(first, /^\| director-selection \| yes \| 2026-09-17 \| docs\/system-one-director-calibration\.md \| pass \|$/m);

  // Every lane is recorded today, so exercise the not-recorded rendering with a synthetic status.
  const unrecorded = buildPromotionSection([
    { lane: "adventure-selection", promoted: false, record: null, gate: null },
  ]);
  assert.match(unrecorded, /^\| adventure-selection \| no \| — \| not recorded \| not recorded \|$/m);
});

test("renders a recorded-but-failing lane as unpromoted with its reasons", () => {
  const speaker = lanePromotionStatus("speaker-routing");
  assert.ok(speaker.record);
  const rendered = buildPromotionSection([
    {
      ...speaker,
      promoted: false,
      gate: { ...speaker.gate!, promoted: false, reasons: ["synthetic gate failure"] },
    },
  ]);
  assert.match(rendered, /^\| speaker-routing \| no \| 2026-09-17 \| docs\/system-one-benchmark\.md \| fail \|$/m);
  assert.match(rendered, /- Gate: fail/);
  assert.match(rendered, /  - synthetic gate failure/);
});
