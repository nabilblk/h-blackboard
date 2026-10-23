# Science learning experience quality pack

This optional domain pack supports a build–review–revise mission. It is not a
Blackboard protocol requirement, a finished curriculum or a classroom efficacy
claim. Give the files to the Coordinator as a versioned input artifact.

Keep each iteration separate from earlier runs. Use
[`ExperimentManifest`](../../../experiments/evidence-manifest.mjs) to pin code,
tool/harness/model versions, topology, permission policy, input hashes and the
acceptance rubric before running. The existing experiment evidence writer keeps
a hash-linked `timeline.jsonl`; record every human intervention and exact tested
artifact revision. A one-Mac rehearsal is labelled as such, even with many nodes.

## First slice before parallel expansion

Produce one executable lesson and a small integration contract before distributing
bulk content work. Publish it as a draft. One independent Agent imports the exact
bundle, uses `artifact_browser` at desktop and narrow widths, changes the controls,
reads the returned image and publishes the evidence. Revise that same artifact.
Select its exact revision as the delivery candidate after review.

Use different representations where the subject requires them. A circuit,
particle system and biological process should not all be forced into a generic
numeric slider template. Framework and scene design remain the agents' choice.
The sample model contract is an interoperability example, not an aesthetic target.

## Evidence for each lesson

- Explicit age/stage label and official curriculum statement/source. Year 8 use
  of the full KS3 programme must not claim that England prescribes all of KS3
  specifically in Year 8. A curriculum ID is an index, not evidence of teaching.
- One focused objective per learning step: explanation → prediction → action →
  observable evidence → feedback → explanation. Include a misconception path.
- A meaningful scene/model with stated assumptions, units and limitations.
  Primary observations and feedback must be visible beside the interaction.
- A fully usable keyboard path, readable narrow view, reduced motion and a
  non-WebGL alternative. Diagram mode must still expose the essential result.
- Axis labels and units, explanatory legends, invalid-input feedback and visible
  fallback/error states. Do not turn a missing value into a misleading zero.
- An immutable bundle with entrypoint, original source, reproducible build recipe,
  dependency versions/licences and all runtime assets needed by its offline viewer.

## Required independent checks

1. Run the model boundary tests and try additional counterexamples of your own.
   Check qualitative assumptions; numeric agreement alone is not scientific review.
2. Open the exact published bundle, not a reconstructed local approximation.
3. Operate every visible control. Inspect correct/incorrect prediction feedback,
   keyboard focus, resize, reduced motion, reset and the no-WebGL experience.
   Use the browser's `reducedMotion:true` and `disableWebgl:true` options to test
   these conditions; every call starts a fresh page and records its conditions.
4. Check the scene as a teacher would: can a learner infer the intended relation
   from the representation? Is the simulation scientifically honest?
5. Record exact revision, engine, viewport, steps, screenshots and failed/not-run
   checks. Publish a review scoped to what you actually checked. Fixes cite old
   reviews as historical citations, not live dependencies.
6. A Coordinator names a candidate and a concise handoff. A late revision needs a
   new candidate decision and the appropriate recheck. Human acceptance remains
   explicit. Scientific expertise and learner studies cannot be replaced by these
   automated checks; record their absence rather than inventing validation.

## Regression seeds

`model-contract.mjs` demonstrates a portable renderer/model interface and guards
for negative distance, invalid/zero time, invalid bounds and non-finite values.
Run `node --test model-contract.test.mjs`. An author may use a different model
implementation, but must retain equivalent counterexample coverage.

`fixture.html` consumes the model directly. Publish it with `model-contract.mjs`
to exercise the artifact browser: baseline readings are visible, invalid input
is explained and a labelled static diagram remains usable. This is a diagnostic
fixture, not the requested premium 3D result or an art direction. The native
artifact-browser check exercises these regressions against the real renderer.

A scene adapter supplies `update(state)`, `resize(width,height)`, and `dispose()`.
It owns one animation loop, cancels it on dispose and responds to reduced motion.
The view renders `status`, `feedback` and labelled `readings` in every display
mode. It must not hide them in a technical-details disclosure. Narrative,
prediction and assessment content stays separate from the mathematical model.
